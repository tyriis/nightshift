import { DomainError } from '#root/domain/errors'
// sanctioned pure-util import (manage-actors precedent): node:crypto-only, no infra coupling
import { generateWebhookSecret } from '#root/infra/token-hash'
import type { ActorContext, Clock, IdGen, UnitOfWork, WebhookRecord } from '#root/application/ports'

export interface CreateWebhookInput extends ActorContext {
  agent_id: string
  url: string
}

export interface CreatedWebhook {
  webhook: WebhookRecord
  /** shown exactly once (D-ff); the repo read paths never carry it again */
  secret: string
}

const parseHttpUrl = (url: string): URL => {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new DomainError('invalid_request', `url '${url}' is not a parseable URL`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new DomainError('invalid_request', 'webhook url must be http(s)')
  }
  return u
}

export class CreateWebhook {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGen
  ) {}

  async run(input: CreateWebhookInput): Promise<CreatedWebhook> {
    parseHttpUrl(input.url) // edge parse; the stored string is exactly what validated
    const now = this.clock.now().toISOString()
    const secret = generateWebhookSecret()
    return this.uow.withTransaction(async (repos) => {
      const agent = await repos.actors.findById(input.agent_id)
      if (!agent) throw new DomainError('not_found', `actor ${input.agent_id} not found`)
      if (agent.kind !== 'agent') {
        // spec §6.8 registers PER-AGENT callbacks; humans are woken by their own UI polling
        throw new DomainError('invalid_request', `actor ${input.agent_id} is not an agent`)
      }
      const id = this.ids.newId('wh')
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'webhook_created',
        entity_type: 'webhook',
        entity_id: id,
        after: { agent_id: input.agent_id, url: input.url },
        reason: 'webhook created', // grep-pinned forward (binding: never reword)
        created_at: now,
      })
      // D-bb: the checkpoint anchors at the watermark INCLUDING the own webhook_created
      // row just appended in this same transaction — a registering runner is woken for
      // what happens NEXT, never for its own registration. Same tx ⇒ no window race.
      const watermark = await repos.audit.watermark()
      try {
        await repos.webhooks.add({
          id,
          actor_id: input.agent_id,
          url: input.url,
          secret,
          created_by: input.actor.id,
          created_at: now,
          delivered_cursor: watermark,
        })
      } catch {
        // honest backstop (D-y lineage): the UNIQUE(url) race loser surfaces here as a
        // domain 400 rather than a bare SqliteError→500; the pre-check on agent + the
        // UNIQUE are the gates, this catch is the loser path. The tx rolls back clean
        // (the audit row included).
        throw new DomainError('invalid_request', `a webhook for '${input.url}' already exists`)
      }
      // plan-verbatim cast (manage-actors precedent): row inserted in THIS tx — the
      // null arm of find is unreachable here
      const webhook = (await repos.webhooks.find(id)) as WebhookRecord
      return { webhook, secret }
    })
  }
}

export interface DeleteWebhookInput extends ActorContext {
  webhook_id: string
}

export class DeleteWebhook {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock
  ) {}

  async run(input: DeleteWebhookInput): Promise<void> {
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      const webhook = await repos.webhooks.find(input.webhook_id)
      if (!webhook) throw new DomainError('not_found', `webhook ${input.webhook_id} not found`)
      await repos.webhooks.remove(input.webhook_id)
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'webhook_deleted',
        entity_type: 'webhook',
        entity_id: input.webhook_id,
        after: { url: webhook.url },
        reason: 'webhook deleted', // grep-pinned forward
        created_at: now,
      })
    })
  }
}

export interface RotateWebhookSecretInput extends ActorContext {
  webhook_id: string
}

export class RotateWebhookSecret {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock
  ) {}

  /** New secret shown exactly once (D-ff); rotation IS re-registration (D-bb): */
  async run(input: RotateWebhookSecretInput): Promise<CreatedWebhook> {
    const now = this.clock.now().toISOString()
    const secret = generateWebhookSecret()
    return this.uow.withTransaction(async (repos) => {
      const existing = await repos.webhooks.find(input.webhook_id)
      if (!existing) throw new DomainError('not_found', `webhook ${input.webhook_id} not found`)
      await repos.webhooks.setSecret(input.webhook_id, secret)
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'webhook_secret_rotated',
        entity_type: 'webhook',
        entity_id: input.webhook_id,
        after: { url: existing.url },
        reason: 'webhook secret rotated', // grep-pinned forward
        created_at: now,
      })
      // re-anchor AFTER the own rotation audit (D-bb, same self-inclusive rule as
      // create): checkpoint moves to the watermark, the backoff counter clears and
      // the park un-set — the old-key backlog is undeliverable by definition and
      // the rotating runner is never woken by its own rotation. ONE statement
      // (WebhookRepo.reanchor, shipped since Task 5).
      await repos.webhooks.reanchor(input.webhook_id, await repos.audit.watermark())
      const webhook = (await repos.webhooks.find(input.webhook_id)) as WebhookRecord
      return { webhook, secret }
    })
  }
}
