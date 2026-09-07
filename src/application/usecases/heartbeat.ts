import type { TaskRecord } from '#root/domain/task'
import { parseLeaseToken } from '#root/domain/claim'
import { DomainError } from '#root/domain/errors'
import type { ActorContext, Clock, UnitOfWork } from '#root/application/ports'

export interface HeartbeatInput extends ActorContext {
  taskId: string
  lease_token: string
}

/** Liveness record only — no keepalive enforcement in v1 (spec §3, §12). */
export class Heartbeat {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock
  ) {}

  async run(input: HeartbeatInput): Promise<TaskRecord> {
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      const task = await repos.tasks.findById(input.taskId)
      if (!task) throw new DomainError('not_found', `task ${input.taskId} not found`)
      const ref = parseLeaseToken(input.lease_token)
      const current =
        task.claim_token_id !== null &&
        input.tokenId === task.claim_token_id &&
        ref !== null &&
        ref.taskId === input.taskId &&
        ref.generation === task.claim_generation
      if (!current) {
        throw new DomainError('stale_lease', 'heartbeat requires the current lease', {
          claimed: task.claim_token_id !== null,
        })
      }
      await repos.tasks.setHeartbeat(input.taskId, now)
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'heartbeat',
        entity_type: 'task',
        entity_id: input.taskId,
        reason: 'liveness recorded',
        created_at: now,
      })
      return (await repos.tasks.findById(input.taskId)) as TaskRecord
    })
  }
}
