import type { TaskRecord } from '#root/domain/task'
import { DomainError } from '#root/domain/errors'
import type { ActorContext, Clock, UnitOfWork } from '#root/application/ports'

export interface ReleaseClaimInput extends ActorContext {
  taskId: string
}

// Three auth models in the claim family (deliberate asymmetry, ora-14 M-3): claim = exclusivity
// CAS (first writer wins); update-status/heartbeat = capability (lease_token string: taskId +
// generation); release = identity (tokenId === claim_token_id) — release has no lease_token field.
export class ReleaseClaim {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock
  ) {}

  async run(input: ReleaseClaimInput): Promise<TaskRecord> {
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      const task = await repos.tasks.findById(input.taskId)
      if (!task) throw new DomainError('not_found', `task ${input.taskId} not found`)
      if (!input.tokenId || task.claim_token_id !== input.tokenId) {
        throw new DomainError('stale_lease', 'only the active claim holder can release', {
          claimed: task.claim_token_id !== null,
        })
      }
      await repos.tasks.clearClaim(input.taskId, now)
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'claim_released',
        entity_type: 'task',
        entity_id: input.taskId,
        reason: 'claim released',
        created_at: now,
      })
      return (await repos.tasks.findById(input.taskId)) as TaskRecord
    })
  }
}
