import type { TaskRecord } from '#root/domain/task'
import { DomainError } from '#root/domain/errors'
import type { ActorContext, Clock, TaskPatch, UnitOfWork } from '#root/application/ports'

export interface UpdateTaskInput extends ActorContext {
  taskId: string
  patch: TaskPatch
}

export class UpdateTask {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock
  ) {}

  async run(input: UpdateTaskInput): Promise<TaskRecord> {
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      const before = await repos.tasks.findById(input.taskId)
      if (!before) throw new DomainError('not_found', `task ${input.taskId} not found`)
      if (input.patch.assignee_id) {
        const assignee = await repos.actors.findById(input.patch.assignee_id)
        if (!assignee) {
          throw new DomainError('not_found', `assignee ${input.patch.assignee_id} not found`)
        }
      }
      const meaningful = Object.keys(input.patch).length > 0
      if (meaningful) {
        await repos.tasks.patch(input.taskId, input.patch, now)
        const after = (await repos.tasks.findById(input.taskId)) as TaskRecord
        await repos.audit.append({
          actor_id: input.actor.id,
          token_id: input.tokenId,
          action: 'task_updated',
          entity_type: 'task',
          entity_id: input.taskId,
          before: {
            title: before.title,
            blocked_flag: before.blocked_flag,
            assignee_id: before.assignee_id,
            acceptance_criteria: before.acceptance_criteria,
          },
          after: {
            title: after.title,
            blocked_flag: after.blocked_flag,
            assignee_id: after.assignee_id,
            acceptance_criteria: after.acceptance_criteria,
          },
          reason: 'content updated',
          created_at: now,
        })
        return after
      }
      return before
    })
  }
}
