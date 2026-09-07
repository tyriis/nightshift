import { DomainError } from '#root/domain/errors'
import type { ActorContext, Clock, IdGen, LabelRow, UnitOfWork } from '#root/application/ports'

export interface CreateLabelInput extends ActorContext {
  name: string
  color?: string
}

export class CreateLabel {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGen
  ) {}

  /** Create-or-get by name (labels have no other identity). */
  async run(input: CreateLabelInput): Promise<LabelRow> {
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) =>
      repos.labels.ensure({
        id: this.ids.newId('l'),
        name: input.name,
        color: input.color ?? '#888888',
        created_at: now,
      })
    )
  }
}

export interface AttachLabelInput extends ActorContext {
  taskId: string
  labelId: string
}

export class AttachLabel {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock
  ) {}

  async run(input: AttachLabelInput): Promise<void> {
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      if (!(await repos.tasks.findById(input.taskId))) {
        throw new DomainError('not_found', `task ${input.taskId} not found`)
      }
      if (!(await repos.labels.getById(input.labelId))) {
        throw new DomainError('not_found', `label ${input.labelId} not found`)
      }
      await repos.labels.attach(input.taskId, input.labelId)
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'label_attached',
        entity_type: 'task',
        entity_id: input.taskId,
        after: { label_id: input.labelId },
        reason: 'label attached',
        created_at: now,
      })
    })
  }
}

export class DetachLabel {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock
  ) {}

  async run(input: AttachLabelInput): Promise<void> {
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      if (!(await repos.tasks.findById(input.taskId))) {
        throw new DomainError('not_found', `task ${input.taskId} not found`)
      }
      // label side is idempotent: unknown label detaches nothing; task-side owns the 404
      await repos.labels.detach(input.taskId, input.labelId)
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'label_detached',
        entity_type: 'task',
        entity_id: input.taskId,
        after: { label_id: input.labelId },
        reason: 'label detached',
        created_at: now,
      })
    })
  }
}
