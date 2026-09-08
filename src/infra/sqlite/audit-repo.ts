import { sql, type Kysely } from 'kysely'
import type { AuditEntryDraft, AuditRepo, AuditRow } from '#root/application/ports'
import type { AuditLogTable, DB } from '#root/infra/sqlite/schema'

type Row = Omit<AuditLogTable, 'id'> & { id: number }

const parseJson = (raw: string | null): unknown => (raw === null ? null : JSON.parse(raw))

// one mapping, shared by search and tail — no drift between the two read paths
const toRow = (r: Row): AuditRow => ({
  id: r.id,
  actor_id: r.actor_id,
  token_id: r.token_id,
  action: r.action,
  entity_type: r.entity_type,
  entity_id: r.entity_id,
  before: parseJson(r.before_json),
  after: parseJson(r.after_json),
  reason: r.reason,
  created_at: r.created_at,
})

export class SqliteAuditRepo implements AuditRepo {
  constructor(private readonly db: Kysely<DB>) {}

  async append(entry: AuditEntryDraft): Promise<void> {
    await this.db
      .insertInto('audit_log')
      .values({
        actor_id: entry.actor_id,
        token_id: entry.token_id,
        action: entry.action,
        entity_type: entry.entity_type,
        entity_id: entry.entity_id,
        before_json: entry.before === undefined ? null : JSON.stringify(entry.before),
        after_json: entry.after === undefined ? null : JSON.stringify(entry.after),
        reason: entry.reason ?? null,
        created_at: entry.created_at,
      })
      .execute()
  }

  async search(q: {
    entity_type?: string
    entity_id?: string
    limit: number
  }): Promise<AuditRow[]> {
    let query = this.db.selectFrom('audit_log').selectAll().orderBy('id', 'desc').limit(q.limit)
    if (q.entity_type !== undefined) query = query.where('entity_type', '=', q.entity_type)
    if (q.entity_id !== undefined) query = query.where('entity_id', '=', q.entity_id)
    const rows = await query.execute()
    return rows.map(toRow)
  }

  async tail(after: number, limit: number): Promise<AuditRow[]> {
    // D-aa: ASCENDING — the event cursor moves forward; `search`'s desc is the
    // activity-tab view and stays untouched (two orders, two intents, one table)
    const rows = await this.db
      .selectFrom('audit_log')
      .selectAll()
      .where('id', '>', after)
      .orderBy('id', 'asc')
      .limit(limit)
      .execute()
    return rows.map(toRow)
  }

  async watermark(): Promise<number> {
    const r = await sql<{ m: number | null }>`select max(id) as m from audit_log`.execute(this.db)
    return r.rows[0]?.m ?? 0
  }
}
