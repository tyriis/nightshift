import type { Kysely } from 'kysely'
import type {
  DueWebhook,
  NewWebhookDraft,
  WebhookRecord,
  WebhookRepo,
} from '#root/application/ports'
import type { DB } from '#root/infra/sqlite/schema'

const PUBLIC_COLUMNS = [
  'id',
  'actor_id',
  'url',
  'created_by',
  'created_at',
  'delivered_cursor',
] as const

// D-ff: find/list SELECT every column EXCEPT secret — no response can project what the
// record type never carries. The secret is visible only in listDue, the delivery loop's
// private read path (and the create/rotate use-case returns, which mint it themselves).
export class SqliteWebhookRepo implements WebhookRepo {
  constructor(private readonly db: Kysely<DB>) {}

  async add(draft: NewWebhookDraft): Promise<void> {
    await this.db
      .insertInto('webhooks')
      .values({ ...draft, attempts: 0, next_attempt_at: 0 })
      .execute()
  }

  async find(id: string): Promise<WebhookRecord | null> {
    const r = await this.db
      .selectFrom('webhooks')
      .select([...PUBLIC_COLUMNS])
      .where('id', '=', id)
      .executeTakeFirst()
    return r ?? null
  }

  async list(): Promise<WebhookRecord[]> {
    // recency order by (created_at, id): ids are RandomIdGen-random (ids.ts), NOT
    // monotonic — the inbox-repo lesson applies verbatim here
    return this.db
      .selectFrom('webhooks')
      .select([...PUBLIC_COLUMNS])
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute()
  }

  async remove(id: string): Promise<void> {
    await this.db.deleteFrom('webhooks').where('id', '=', id).execute()
  }

  async setSecret(id: string, secret: string): Promise<void> {
    await this.db.updateTable('webhooks').set({ secret }).where('id', '=', id).execute()
  }

  async listDue(nowMs: number): Promise<DueWebhook[]> {
    return this.db
      .selectFrom('webhooks')
      .select(['id', 'url', 'secret', 'delivered_cursor', 'attempts'])
      .where('next_attempt_at', '<=', nowMs)
      .orderBy('created_at', 'asc')
      .execute()
  }

  async advance(id: string, deliveredCursor: number): Promise<void> {
    await this.db
      .updateTable('webhooks')
      .set({ delivered_cursor: deliveredCursor, attempts: 0 })
      .where('id', '=', id)
      .execute()
  }

  async scheduleRetry(id: string, attempts: number, nextAttemptAt: number): Promise<void> {
    await this.db
      .updateTable('webhooks')
      .set({ attempts, next_attempt_at: nextAttemptAt })
      .where('id', '=', id)
      .execute()
  }

  async reanchor(id: string, deliveredCursor: number): Promise<void> {
    // rotation IS re-registration (D-bb): checkpoint, attempts AND park reset together
    await this.db
      .updateTable('webhooks')
      .set({ delivered_cursor: deliveredCursor, attempts: 0, next_attempt_at: 0 })
      .where('id', '=', id)
      .execute()
  }
}
