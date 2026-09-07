import { formatLeaseToken } from '#root/domain/claim'
import { DomainError } from '#root/domain/errors'
import type { TaskStatus } from '#root/domain/task'
import type { ActorContext, Clock, UnitOfWork } from '#root/application/ports'

export interface ClaimTaskInput extends ActorContext {
  taskId: string
}

export interface ClaimResult {
  lease_token: string
  generation: number
}

export class ClaimTask {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock
  ) {}

  async run(input: ClaimTaskInput): Promise<ClaimResult> {
    const now = this.clock.now().toISOString()
    if (!input.tokenId) {
      throw new DomainError('invalid_request', 'claiming requires an authenticated token')
    }
    // Typecheck deviation (sanctioned): input.tokenId loses its null-guard narrowing inside
    // the transaction closure, so capture the narrowed string here.
    const tokenId = input.tokenId
    return this.uow.withTransaction(async (repos) => {
      const task = await repos.tasks.findById(input.taskId)
      if (!task) throw new DomainError('not_found', `task ${input.taskId} not found`)
      if (task.status === 'canceled') {
        throw new DomainError('canceled_terminal', `task ${input.taskId} is canceled`)
      }
      if (task.status !== 'todo' && task.status !== 'in_progress') {
        throw new DomainError('invalid_request', `task in status '${task.status}' is not claimable`)
      }
      // Invariant 1 / D6: leaf-claim
      if (await repos.tasks.hasChildren(input.taskId)) {
        throw new DomainError('not_a_leaf', 'work happens on leaves; claim a child instead')
      }

      const alreadyClaimed = async (): Promise<DomainError> => {
        // ora-14 M-1: FRESH re-read — after a lost CAS the current row, not the first read's
        // claim_token_id, is the truth about who holds the claim today.
        const fresh = await repos.tasks.findById(input.taskId)
        const holder = fresh?.claim_token_id
          ? await repos.actors.findActorByTokenId(fresh.claim_token_id)
          : null
        return new DomainError(
          'already_claimed',
          `task is claimed by ${holder?.display_name ?? 'another actor'}`,
          {
            holder_handle: holder?.handle ?? null,
            holder_display_name: holder?.display_name ?? null,
          }
        )
      }

      if (task.claim_token_id) throw await alreadyClaimed()

      const newStatus: TaskStatus = task.status === 'todo' ? 'in_progress' : task.status
      const result = await repos.tasks.tryClaim(task.id, tokenId, input.actor.id, newStatus, now)
      if (!result) throw await alreadyClaimed() // lost a race between check and CAS

      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'claim_acquired',
        entity_type: 'task',
        entity_id: task.id,
        after: { generation: result.generation },
        reason: 'claim acquired',
        created_at: now,
      })
      return {
        lease_token: formatLeaseToken(task.id, result.generation),
        generation: result.generation,
      }
    })
  }
}
