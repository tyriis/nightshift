import { DomainError } from '#root/domain/errors'
import type { ActorContext, Clock, UnitOfWork } from '#root/application/ports'

export interface AddBlockInput extends ActorContext {
  /** the blocked task */
  taskId: string
  /** the blocker */
  blocker_id: string
}

export class AddBlock {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock
  ) {}

  async run(input: AddBlockInput): Promise<void> {
    const now = this.clock.now().toISOString()
    if (input.taskId === input.blocker_id) {
      throw new DomainError('invalid_request', 'a task cannot block itself')
    }
    return this.uow.withTransaction(async (repos) => {
      const blocked = await repos.tasks.findById(input.taskId)
      if (!blocked) throw new DomainError('not_found', `task ${input.taskId} not found`)
      const blocker = await repos.tasks.findById(input.blocker_id)
      if (!blocker) throw new DomainError('not_found', `blocker ${input.blocker_id} not found`)
      // Edge orientation (Task 5 contract): add(blockerId, blockedId); wouldCycle
      // takes the same (blocker, blocked) pair.
      if (await repos.deps.wouldCycle(input.blocker_id, input.taskId)) {
        throw new DomainError(
          'dependency_cycle',
          `adding ${input.blocker_id} -> ${input.taskId} would create a cycle`
        )
      }
      await repos.deps.add(input.blocker_id, input.taskId)
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'block_added',
        entity_type: 'task',
        entity_id: input.taskId,
        after: { blocker_id: input.blocker_id, blocked_id: input.taskId },
        reason: 'dependency added',
        created_at: now,
      })
    })
  }
}
