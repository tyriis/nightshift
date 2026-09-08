import { THREAD_KINDS, type ThreadKind } from '#root/domain/discussion'
import { DomainError } from '#root/domain/errors'
import type {
  ActorContext,
  Clock,
  IdGen,
  MessageRecord,
  ThreadRecord,
  UnitOfWork,
} from '#root/application/ports'
import { routeMentions } from '#root/application/usecases/route-mentions'

export interface CreateThreadInput extends ActorContext {
  taskId: string
  kind: ThreadKind
  body: string
  /** required for kind='question' (D-m: question always has an assignee) */
  assignee_id?: string
  /** D-p: UI-only escape hatch on a parent task; honored for human actors only */
  metaNote?: boolean
}

export interface CreateThreadResult {
  thread: ThreadRecord
  message: MessageRecord
}

export class CreateThread {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGen
  ) {}

  async run(input: CreateThreadInput): Promise<CreateThreadResult> {
    if (!THREAD_KINDS.includes(input.kind)) {
      throw new DomainError('invalid_request', `unknown thread kind '${input.kind}'`)
    }
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      const task = await repos.tasks.findById(input.taskId)
      if (!task) throw new DomainError('not_found', `task ${input.taskId} not found`)

      // spec §6.2: after a split the conversation moves to the children (D-p)
      const onParent = await repos.tasks.hasChildren(input.taskId)
      if (onParent) {
        if (!(input.metaNote === true && input.actor.kind === 'human')) {
          throw new DomainError(
            'threads_on_parent',
            `task ${input.taskId} has children; conversation lives on the leaves (spec §6.2)`
          )
        }
      }

      let assigneeId: string | null = null
      if (input.kind === 'question') {
        if (!input.assignee_id) {
          throw new DomainError('invalid_request', 'a question requires an assignee (spec §6.5)')
        }
        const assignee = await repos.actors.findById(input.assignee_id)
        if (!assignee) {
          throw new DomainError('not_found', `assignee ${input.assignee_id} not found`)
        }
        assigneeId = assignee.id
      }

      const thread = await repos.threads.create({
        id: this.ids.newId('th'),
        task_id: input.taskId,
        kind: input.kind,
        state: input.kind === 'question' ? 'open' : null,
        assignee_id: assigneeId,
        answer_message_id: null,
        created_by: input.actor.id,
        created_at: now,
        updated_at: now,
      })
      const message = await repos.threads.appendMessage({
        id: this.ids.newId('ms'),
        threadId: thread.id,
        authorId: input.actor.id,
        body: input.body,
        created_at: now,
      })

      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'thread_created',
        entity_type: 'thread',
        entity_id: thread.id,
        after: { kind: thread.kind, task_id: thread.task_id },
        reason: onParent ? 'meta-note on parent (spec §6.2)' : 'thread created',
        created_at: now,
      })

      await routeMentions(repos, this.ids, input.body, {
        actorId: input.actor.id,
        taskId: input.taskId,
        threadId: thread.id,
        at: now,
      })
      // D-r: question assignment notifies the assignee, never themselves
      if (assigneeId && assigneeId !== input.actor.id) {
        await repos.inbox.add({
          id: this.ids.newId('ib'),
          actor_id: assigneeId,
          kind: 'question_assigned',
          task_id: input.taskId,
          thread_id: thread.id,
          created_at: now,
        })
      }
      return { thread, message }
    })
  }
}
