import type { Kysely } from 'kysely'
import type { LinkDraft, LinkRecord, LinkRepo } from '#root/application/ports'
import type { LinkKind } from '#root/domain/discussion'
import type { DB, LinksTable } from '#root/infra/sqlite/schema'

const toRecord = (r: LinksTable): LinkRecord => ({
  id: r.id,
  task_id: r.task_id,
  kind: r.kind,
  url: r.url,
  created_by: r.created_by,
  created_at: r.created_at,
})

export class SqliteLinkRepo implements LinkRepo {
  constructor(private readonly db: Kysely<DB>) {}

  async add(draft: LinkDraft): Promise<LinkRecord> {
    const row = await this.db
      .insertInto('links')
      .values(draft)
      .returningAll()
      .executeTakeFirstOrThrow()
    return toRecord(row)
  }

  async find(id: string): Promise<LinkRecord | null> {
    const r = await this.db.selectFrom('links').selectAll().where('id', '=', id).executeTakeFirst()
    return r ? toRecord(r) : null
  }

  // D-t idempotency anchor: POST is insert-or-get over the unique (task, kind, url)
  // triple — a hit returns the owning row instead of a second insert.
  async findByTaskKindUrl(taskId: string, kind: LinkKind, url: string): Promise<LinkRecord | null> {
    const r = await this.db
      .selectFrom('links')
      .selectAll()
      .where('task_id', '=', taskId)
      .where('kind', '=', kind)
      .where('url', '=', url)
      .executeTakeFirst()
    return r ? toRecord(r) : null
  }

  async remove(id: string): Promise<void> {
    await this.db.deleteFrom('links').where('id', '=', id).execute()
  }

  async listForTask(taskId: string): Promise<LinkRecord[]> {
    const rows = await this.db
      .selectFrom('links')
      .selectAll()
      .where('task_id', '=', taskId)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute()
    return rows.map(toRecord)
  }
}
