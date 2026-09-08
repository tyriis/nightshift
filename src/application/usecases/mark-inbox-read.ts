import { DomainError } from '#root/domain/errors'
import type { ActorContext, UnitOfWork } from '#root/application/ports'

export interface MarkInboxReadInput extends ActorContext {
  itemId: string
}

/** D-r: read-state is personal; absent/not-owned both fail with not_found (no leak). */
export class MarkInboxRead {
  constructor(private readonly uow: UnitOfWork) {}

  async run(input: MarkInboxReadInput): Promise<void> {
    await this.uow.withTransaction(async (repos) => {
      const ok = await repos.inbox.markRead(input.itemId, input.actor.id)
      if (!ok) throw new DomainError('not_found', `inbox item ${input.itemId} not found`)
    })
  }
}
