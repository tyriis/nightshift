import { DomainError } from '#root/domain/errors'
import type { ActorContext, Clock, UnitOfWork } from '#root/application/ports'

export interface RemoveBlockInput extends ActorContext {
  taskId: string
  blocker_id: string
}

export class RemoveBlock {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock
  ) {}

  async run(input: RemoveBlockInput): Promise<void> {
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      const blocked = await repos.tasks.findById(input.taskId)
      if (!blocked) throw new DomainError('not_found', `task ${input.taskId} not found`)
      await repos.deps.remove(input.blocker_id, input.taskId)
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'block_removed',
        entity_type: 'task',
        entity_id: input.taskId,
        after: { blocker_id: input.blocker_id, blocked_id: input.taskId },
        reason: 'dependency removed',
        created_at: now,
      })
    })
  }
}
