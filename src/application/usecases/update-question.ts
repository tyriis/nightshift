import { QUESTION_STATES, canTransitionQuestion, type QuestionState } from '#root/domain/discussion'
import { DomainError } from '#root/domain/errors'
import type { ActorContext, Clock, IdGen, ThreadRecord, UnitOfWork } from '#root/application/ports'

export interface UpdateQuestionInput extends ActorContext {
  threadId: string
  state?: QuestionState
  assignee_id?: string
}

/** D-n/D-r/D-x: resolve/close and re-assign; every actor may act (nothing hidden). */
export class UpdateQuestion {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGen
  ) {}

  async run(input: UpdateQuestionInput): Promise<ThreadRecord> {
    if (input.state !== undefined && !QUESTION_STATES.includes(input.state)) {
      throw new DomainError('invalid_request', `unknown question state '${input.state}'`)
    }
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      const thread = await repos.threads.find(input.threadId)
      if (!thread) throw new DomainError('not_found', `thread ${input.threadId} not found`)
      if (thread.kind !== 'question') {
        throw new DomainError('invalid_request', 'only question threads can be updated')
      }
      let changed = false

      if (input.assignee_id !== undefined && input.assignee_id !== thread.assignee_id) {
        const assignee = await repos.actors.findById(input.assignee_id)
        if (!assignee) throw new DomainError('not_found', `assignee ${input.assignee_id} not found`)
        await repos.threads.setQuestionFields(thread.id, { assignee_id: assignee.id }, now)
        await repos.audit.append({
          actor_id: input.actor.id,
          token_id: input.tokenId,
          action: 'question_reassigned',
          entity_type: 'thread',
          entity_id: thread.id,
          before: { assignee_id: thread.assignee_id },
          after: { assignee_id: assignee.id },
          reason: 'question reassigned',
          created_at: now,
        })
        if (assignee.id !== input.actor.id) {
          await repos.inbox.add({
            id: this.ids.newId('ib'),
            actor_id: assignee.id,
            kind: 'question_assigned',
            task_id: thread.task_id,
            thread_id: thread.id,
            created_at: now,
          })
        }
        changed = true
      }

      if (input.state !== undefined && input.state !== thread.state) {
        // D-n delegation: the domain table is the single transition authority;
        // the state cast is total — the DDL biconditional makes question ⇒ state NOT NULL
        if (!canTransitionQuestion(thread.state as QuestionState, input.state)) {
          throw new DomainError(
            'question_transition',
            `illegal transition ${thread.state} → ${input.state} (decision D-n)`,
            { from: thread.state, to: input.state }
          )
        }
        await repos.threads.setQuestionFields(thread.id, { state: input.state }, now)
        await repos.audit.append({
          actor_id: input.actor.id,
          token_id: input.tokenId,
          action: 'question_state_changed',
          entity_type: 'thread',
          entity_id: thread.id,
          before: { state: thread.state },
          after: { state: input.state },
          reason: 'question state changed',
          created_at: now,
        })
        changed = true
      }

      return (changed ? await repos.threads.find(thread.id) : thread) as ThreadRecord
    })
  }
}
