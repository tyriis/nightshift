import { canTransitionQuestion, type QuestionState } from '#root/domain/discussion'
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

export interface AnswerQuestionInput extends ActorContext {
  threadId: string
  body: string
}

export interface AnswerResult {
  message: MessageRecord
  thread: ThreadRecord
}

/** D-n: answering is its own verb — message + link + open→answered, one transaction. */
export class AnswerQuestion {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGen
  ) {}

  async run(input: AnswerQuestionInput): Promise<AnswerResult> {
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      const thread = await repos.threads.find(input.threadId)
      if (!thread) throw new DomainError('not_found', `thread ${input.threadId} not found`)
      if (thread.kind !== 'question') {
        throw new DomainError('invalid_request', 'only question threads can be answered')
      }
      // D-n delegation: only the domain table decides movability (open → answered);
      // the state cast is total here — the DDL biconditional makes question ⇒ state NOT NULL
      if (!canTransitionQuestion(thread.state as QuestionState, 'answered')) {
        throw new DomainError('question_transition', `question is '${thread.state}', not 'open'`, {
          state: thread.state,
        })
      }
      const message = await repos.threads.appendMessage({
        id: this.ids.newId('ms'),
        threadId: thread.id,
        authorId: input.actor.id,
        body: input.body,
        created_at: now,
      })
      await repos.threads.setQuestionFields(
        thread.id,
        { state: 'answered', answer_message_id: message.id },
        now
      )
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'question_answered',
        entity_type: 'thread',
        entity_id: thread.id,
        before: { state: thread.state },
        after: { state: 'answered', answer_message_id: message.id },
        reason: 'question answered',
        created_at: now,
      })
      await routeMentions(repos, this.ids, input.body, {
        actorId: input.actor.id,
        taskId: thread.task_id,
        threadId: thread.id,
        at: now,
      })
      return { message, thread: (await repos.threads.find(thread.id)) as ThreadRecord }
    })
  }
}
