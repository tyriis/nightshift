import type { Kysely } from 'kysely'
import type { InboxItemDraft, InboxItemRecord, InboxRepo } from '#root/application/ports'
import type { DB, InboxItemsTable } from '#root/infra/sqlite/schema'

const toItem = (r: InboxItemsTable): InboxItemRecord => ({
  id: r.id,
  actor_id: r.actor_id,
  kind: r.kind,
  task_id: r.task_id,
  thread_id: r.thread_id,
  read: r.read === 1,
  created_at: r.created_at,
})

export class SqliteInboxRepo implements InboxRepo {
  constructor(private readonly db: Kysely<DB>) {}

  async add(draft: InboxItemDraft): Promise<void> {
    await this.db
      .insertInto('inbox_items')
      .values({ ...draft, read: 0 })
      .execute()
  }

  async listForActor(
    actorId: string,
    filter: { unreadOnly: boolean; limit: number }
  ): Promise<InboxItemRecord[]> {
    // recency order (newest-first): ids are RandomIdGen-random (src/infra/ids.ts),
    // NOT monotonic — ordering by id would be an arbitrary subset under limit
    const base = this.db
      .selectFrom('inbox_items')
      .selectAll()
      .where('actor_id', '=', actorId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
    const rows = await (filter.unreadOnly ? base.where('read', '=', 0) : base)
      .limit(filter.limit)
      .execute()
    return rows.map(toItem)
  }

  async markRead(itemId: string, actorId: string): Promise<boolean> {
    // owner-only by construction: the actor filter makes foreign ids simply not match
    const r = await this.db
      .updateTable('inbox_items')
      .set({ read: 1 })
      .where('id', '=', itemId)
      .where('actor_id', '=', actorId)
      .returning('id')
      .executeTakeFirst()
    return Boolean(r)
  }
}
