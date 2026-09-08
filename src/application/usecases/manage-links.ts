import { LINK_KINDS, type LinkKind } from '#root/domain/discussion'
import { DomainError } from '#root/domain/errors'
import type { ActorContext, Clock, IdGen, LinkRecord, UnitOfWork } from '#root/application/ports'

function assertHttpUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new DomainError('invalid_request', `'${url}' is not a valid URL`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new DomainError('invalid_request', `URL scheme must be http(s), got '${parsed.protocol}'`)
  }
}

export interface AddLinkInput extends ActorContext {
  taskId: string
  kind: LinkKind
  url: string
}

export class AddLink {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGen
  ) {}

  async run(input: AddLinkInput): Promise<LinkRecord> {
    if (!LINK_KINDS.includes(input.kind)) {
      throw new DomainError('invalid_request', `unknown link kind '${input.kind}'`)
    }
    assertHttpUrl(input.url)
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      const task = await repos.tasks.findById(input.taskId)
      if (!task) throw new DomainError('not_found', `task ${input.taskId} not found`)
      const existing = await repos.links.findByTaskKindUrl(input.taskId, input.kind, input.url)
      if (existing) return existing // D-t idempotent
      const row = await repos.links.add({
        id: this.ids.newId('lk'),
        task_id: input.taskId,
        kind: input.kind,
        url: input.url,
        created_by: input.actor.id,
        created_at: now,
      })
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'link_added',
        entity_type: 'link',
        entity_id: row.id,
        after: { task_id: input.taskId, kind: input.kind, url: input.url },
        reason: 'link added',
        created_at: now,
      })
      return row
    })
  }
}

export interface RemoveLinkInput extends ActorContext {
  taskId: string
  linkId: string
}

export class RemoveLink {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock
  ) {}

  async run(input: RemoveLinkInput): Promise<void> {
    const now = this.clock.now().toISOString()
    await this.uow.withTransaction(async (repos) => {
      const row = await repos.links.find(input.linkId)
      if (!row || row.task_id !== input.taskId) {
        throw new DomainError('not_found', `link ${input.linkId} not found on task ${input.taskId}`)
      }
      await repos.links.remove(input.linkId)
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'link_removed',
        entity_type: 'link',
        entity_id: row.id,
        before: { task_id: row.task_id, kind: row.kind, url: row.url },
        reason: 'link removed',
        created_at: now,
      })
    })
  }
}
