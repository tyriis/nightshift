import { TASK_STATUSES, type TaskRecord, type TaskStatus } from '#root/domain/task'
import { parseLeaseToken } from '#root/domain/claim'
import { DomainError } from '#root/domain/errors'
import type { ActorContext, Clock, UnitOfWork } from '#root/application/ports'

export interface UpdateStatusInput extends ActorContext {
  taskId: string
  to: TaskStatus
  reason: string
  lease_token?: string
}

export class UpdateStatus {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock
  ) {}

  async run(input: UpdateStatusInput): Promise<TaskRecord> {
    const now = this.clock.now().toISOString()
    if (!input.reason || input.reason.trim() === '') {
      throw new DomainError('invalid_request', 'status changes require a reason (spec §6.7)')
    }
    // ora-14 M-5: uniform input validation with the sibling use-cases (create/split) — a
    // bogus `to` is rejected as invalid_request, not left to SQLite or silent acceptance.
    if (!TASK_STATUSES.includes(input.to)) {
      throw new DomainError('invalid_request', `unknown status '${input.to}'`)
    }
    return this.uow.withTransaction(async (repos) => {
      const task = await repos.tasks.findById(input.taskId)
      if (!task) throw new DomainError('not_found', `task ${input.taskId} not found`)
      if (task.status === 'canceled') {
        throw new DomainError(
          'canceled_terminal',
          `task ${input.taskId} is canceled; cancel is terminal`
        )
      }

      // Invariant 3: any transition of a claimed task requires its current fencing token.
      if (task.claim_token_id !== null) {
        const ref = parseLeaseToken(input.lease_token)
        if (!ref || ref.taskId !== input.taskId || ref.generation !== task.claim_generation) {
          throw new DomainError('stale_lease', 'task is claimed; current lease_token required', {
            claimed: true,
          })
        }
      } else if (input.lease_token !== undefined) {
        // D-b/D-d closure (Task 8 test "the old lease token can never be used again"):
        // a PRESENTED lease must validate against current state even when the claim was
        // already released (by review/split). A released generation can never re-validate,
        // so a presented-but-stale token is rejected instead of silently ignored.
        // (Absent lease on an unclaimed task stays allowed — D-c lets humans close.)
        throw new DomainError('stale_lease', 'lease does not match any active claim', {
          claimed: false,
        })
      }

      if (input.to === 'done') {
        const gate = await repos.actors.getPolicy('review_gate')
        if ((gate ?? 'on') === 'on' && input.actor.kind === 'agent') {
          throw new DomainError(
            'agent_close_forbidden',
            'agents may move work to in_review, not done (spec §6.4.5)'
          )
        }
        // Invariant 6 seam: Plan B adds "open question assigned to a human → open_questions 409" here.
        const openDesc = await repos.tasks.countOpenDescendants(input.taskId)
        if (openDesc > 0) {
          throw new DomainError('open_descendants', `${openDesc} descendants still open`, {
            open: openDesc,
          })
        }
      }

      await repos.tasks.setStatus(input.taskId, input.to, now)

      // D-c: leave review/done un-claimed so humans can close without a lease.
      if ((input.to === 'in_review' || input.to === 'done') && task.claim_token_id !== null) {
        await repos.tasks.clearClaim(input.taskId, now)
        await repos.audit.append({
          actor_id: input.actor.id,
          token_id: input.tokenId,
          action: 'claim_released',
          entity_type: 'task',
          entity_id: input.taskId,
          reason: 'claim released on review',
          created_at: now,
        })
      }

      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'status_changed',
        entity_type: 'task',
        entity_id: input.taskId,
        before: { status: task.status },
        after: { status: input.to },
        reason: input.reason,
        created_at: now,
      })

      return (await repos.tasks.findById(input.taskId)) as TaskRecord
    })
  }
}
