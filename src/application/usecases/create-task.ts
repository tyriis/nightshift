import { TASK_STATUSES, type TaskRecord, type TaskStatus } from '#root/domain/task'
import { DomainError } from '#root/domain/errors'
import type { ActorContext, Clock, IdGen, UnitOfWork } from '#root/application/ports'

export interface CreateTaskInput extends ActorContext {
  title: string
  description?: string
  acceptance_criteria?: string
  parent_id?: string
  status?: TaskStatus
  labels?: string[]
}

export class CreateTask {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGen
  ) {}

  async run(input: CreateTaskInput): Promise<TaskRecord> {
    const now = this.clock.now().toISOString()
    const status: TaskStatus = input.status ?? 'backlog'
    if (!TASK_STATUSES.includes(status)) {
      throw new DomainError('invalid_request', `unknown status '${status}'`)
    }
    return this.uow.withTransaction(async (repos) => {
      if (input.parent_id) {
        const parent = await repos.tasks.findById(input.parent_id)
        if (!parent) {
          throw new DomainError('not_found', `parent task ${input.parent_id} not found`)
        }
      }
      const position = await repos.tasks.nextPosition(input.parent_id ?? null)
      const task = await repos.tasks.create({
        id: this.ids.newId('t'),
        parent_id: input.parent_id ?? null,
        title: input.title,
        description: input.description ?? '',
        acceptance_criteria: input.acceptance_criteria ?? '',
        status,
        position,
        created_by: input.actor.id,
        created_at: now,
        updated_at: now,
      })
      for (const name of input.labels ?? []) {
        const label = await repos.labels.ensure({
          id: this.ids.newId('l'),
          name,
          color: '#888888',
          created_at: now,
        })
        await repos.labels.attach(task.id, label.id)
      }
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'task_created',
        entity_type: 'task',
        entity_id: task.id,
        after: { title: task.title, status: task.status, parent_id: task.parent_id },
        reason: 'task created',
        created_at: now,
      })
      return task
    })
  }
}
