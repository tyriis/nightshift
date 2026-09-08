import { DomainError } from '#root/domain/errors'
import type { ActorContext, Clock, IdGen, MessageRecord, UnitOfWork } from '#root/application/ports'
import { routeMentions } from '#root/application/usecases/route-mentions'

export interface AddMessageInput extends ActorContext {
  threadId: string
  body: string
}

export class AddMessage {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGen
  ) {}

  async run(input: AddMessageInput): Promise<MessageRecord> {
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      const thread = await repos.threads.find(input.threadId)
      if (!thread) throw new DomainError('not_found', `thread ${input.threadId} not found`)
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
        action: 'message_created',
        entity_type: 'thread',
        entity_id: thread.id,
        after: { message_id: message.id, seq: message.seq },
        reason: 'message created',
        created_at: now,
      })
      await routeMentions(repos, this.ids, input.body, {
        actorId: input.actor.id,
        taskId: thread.task_id,
        threadId: thread.id,
        at: now,
      })
      return message
    })
  }
}
