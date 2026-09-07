import { sql, type Kysely } from 'kysely'
import type { BlockerRow, DependencyRepo } from '#root/application/ports'
import type { DB } from '#root/infra/sqlite/schema'

export class SqliteDependencyRepo implements DependencyRepo {
  constructor(private readonly db: Kysely<DB>) {}

  async add(blockerId: string, blockedId: string): Promise<void> {
    await this.db
      .insertInto('dependencies')
      .values({ blocker_id: blockerId, blocked_id: blockedId })
      .onConflict((oc) => oc.columns(['blocker_id', 'blocked_id']).doNothing())
      .execute()
  }

  async remove(blockerId: string, blockedId: string): Promise<void> {
    await this.db
      .deleteFrom('dependencies')
      .where('blocker_id', '=', blockerId)
      .where('blocked_id', '=', blockedId)
      .execute()
  }

  async wouldCycle(blockerId: string, blockedId: string): Promise<boolean> {
    // Adding "blockerId blocks blockedId" closes a cycle iff blockedId ALREADY
    // transitively blocks blockerId — i.e. blockedId appears among the transitive
    // blockers of blockerId. (Plan verbatim had the two interpolations swapped, which
    // detects "edge already transitively implied" instead — fails the plan's own
    // cycle test.) Anchor + recursion stay on blocked_id so SQLite uses
    // dependencies_blocked_idx.
    const r = await sql<{ hit: number }>`
      with recursive r(id) as (
        select blocker_id from dependencies where blocked_id = ${blockerId}
        union
        select d.blocker_id from dependencies d join r on d.blocked_id = r.id
      )
      select 1 as hit from r where r.id = ${blockedId} limit 1
    `.execute(this.db)
    return r.rows.length > 0
  }

  async unmetBlockers(taskId: string): Promise<BlockerRow[]> {
    const r = await sql<BlockerRow>`
      select b.id, b.title, b.status
        from dependencies d join tasks b on b.id = d.blocker_id
       where d.blocked_id = ${taskId} and b.status != 'done'
       order by b.title, b.id
    `.execute(this.db)
    return r.rows
  }
}
