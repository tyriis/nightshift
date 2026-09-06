import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { makeDb } from '#root/infra/sqlite/db'
import { migrateToLatest } from '#root/infra/sqlite/migrations'

const TABLES = [
  'actors',
  'tokens',
  'tasks',
  'dependencies',
  'labels',
  'task_labels',
  'audit_log',
  'policy',
  'idempotency_keys',
]

describe('migrations', () => {
  it('creates all tables', async () => {
    const db = makeDb(':memory:')
    await migrateToLatest(db)
    // 'sqlite%' filter: `autoincrement` makes SQLite create the internal sqlite_sequence
    // table; without this exclusion the plan's as-written query can never equal TABLES.
    const rows = await sql<{ name: string }>`
      select name from sqlite_master
      where type = 'table' and name not like 'kysely%' and name not like 'sqlite%'
    `.execute(db)
    const names = rows.rows.map((r) => r.name).sort()
    expect(names).toEqual([...TABLES].sort())
    await db.destroy()
  })

  it('is idempotent', async () => {
    const db = makeDb(':memory:')
    await migrateToLatest(db)
    await migrateToLatest(db) // second run must not throw
    await db.destroy()
  })

  it('seeds review_gate policy on', async () => {
    const db = makeDb(':memory:')
    await migrateToLatest(db)
    const r = await sql<{
      value: string
    }>`select value from policy where key = 'review_gate'`.execute(db)
    expect(r.rows[0]?.value).toBe('on')
    await db.destroy()
  })

  it('rethrows migration failures instead of swallowing them', async () => {
    const db = makeDb(':memory:')
    await sql`create table actors (id text)`.execute(db) // collide with the init DDL
    await expect(migrateToLatest(db)).rejects.toThrow(/already exists/)
    await db.destroy()
  })

  it('enforces foreign keys', async () => {
    const db = makeDb(':memory:')
    await migrateToLatest(db)
    await expect(
      sql`insert into tasks (id, title, position, created_by, created_at, updated_at)
          values ('t_x', 'x', 1, 'a_missing', '2026-01-01', '2026-01-01')`.execute(db)
    ).rejects.toThrow(/FOREIGN KEY|foreign key/i)
    await db.destroy()
  })

  // Constraint-contract tests: pin the CHECK/unique/index guarantees that later
  // use-cases and repos rely on, so a silent DDL edit in a future migration fails CI.
  const seedActorAndTask = async (db: ReturnType<typeof makeDb>): Promise<void> => {
    await sql`insert into actors (id, kind, handle, display_name, description, created_at)
              values ('a_x','human','x','X','','2026-01-01')`.execute(db)
    await sql`insert into tasks (id, title, position, created_by, created_at, updated_at)
              values ('t_x','x',1,'a_x','2026-01-01','2026-01-01')`.execute(db)
  }

  it('rejects invalid status, self-edges, duplicate handles, non-boolean flags', async () => {
    const db = makeDb(':memory:')
    await migrateToLatest(db)
    await seedActorAndTask(db)
    await expect(
      sql`insert into tasks (id, title, position, status, created_by, created_at, updated_at)
          values ('t_bad','x',1,'shipped','a_x','2026-01-01','2026-01-01')`.execute(db)
    ).rejects.toThrow(/CHECK|check/i)
    await expect(
      sql`insert into dependencies (blocker_id, blocked_id) values ('t_x','t_x')`.execute(db)
    ).rejects.toThrow(/CHECK|check/i)
    await expect(
      sql`insert into actors (id, kind, handle, display_name, description, created_at)
          values ('a_y','agent','x','Y','','2026-01-01')`.execute(db)
    ).rejects.toThrow(/UNIQUE/i)
    await expect(
      sql`insert into tasks (id, title, position, blocked_flag, created_by, created_at, updated_at)
          values ('t_flag','x',1,2,'a_x','2026-01-01','2026-01-01')`.execute(db)
    ).rejects.toThrow(/CHECK|check/i)
    await db.destroy()
  })

  it('indexes the hot dependency and audit query paths', async () => {
    const db = makeDb(':memory:')
    await migrateToLatest(db)
    const r = await sql<{ name: string }>`
      select name from sqlite_master
       where type = 'index'
         and name in ('dependencies_blocked_idx', 'audit_log_entity_idx')
    `.execute(db)
    expect(r.rows.map((x) => x.name).sort()).toEqual([
      'audit_log_entity_idx',
      'dependencies_blocked_idx',
    ])
    await db.destroy()
  })
})
