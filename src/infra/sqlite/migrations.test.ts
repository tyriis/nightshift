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
  'threads',
  'messages',
  'inbox_items',
  'attachments',
  'links',
  'webhooks',
  // FTS5 (D-gg): names PROBE-CONFIRMED against sqlite_master after migrateToLatest.
  // External-content FTS5 creates NO `task_fts_content` shadow (the content lives in
  // `tasks`) — the plan's expected list included it; the probe output is the source of truth.
  'task_fts',
  'task_fts_config',
  'task_fts_data',
  'task_fts_docsize',
  'task_fts_idx',
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

  it('pins discussion DDL constraints (question⇔state/assignee, orderings, uniqueness)', async () => {
    const db = makeDb(':memory:')
    await migrateToLatest(db)
    await seedActorAndTask(db) // existing helper: seeds a_x (human) + t_x
    await sql`insert into actors (id, kind, handle, display_name, description, created_at)
                values ('a_ag','agent','ag','Ag','','2026-01-01')`.execute(db)
    // note thread: state must stay NULL
    await sql`insert into threads (id, task_id, kind, created_by, created_at, updated_at)
                values ('th_n','t_x','note','a_x','2026-01-01','2026-01-01')`.execute(db)
    await expect(
      sql`insert into threads (id, task_id, kind, state, created_by, created_at, updated_at)
            values ('th_bad','t_x','note','open','a_x','2026-01-01','2026-01-01')`.execute(db)
    ).rejects.toThrow(/CHECK|check/i)
    // question thread requires assignee; state vocabulary enforced
    await expect(
      sql`insert into threads (id, task_id, kind, state, created_by, created_at, updated_at)
            values ('th_q','t_x','question','open','a_x','2026-01-01','2026-01-01')`.execute(db)
    ).rejects.toThrow(/CHECK|check/i)
    await sql`insert into threads (id, task_id, kind, state, assignee_id, created_by,
                created_at, updated_at)
                values ('th_q2','t_x','question','open','a_ag','a_x','2026-01-01','2026-01-01')`.execute(
      db
    )
    await expect(
      sql`insert into threads (id, task_id, kind, state, assignee_id, created_by,
                created_at, updated_at)
                values ('th_q3','t_x','question','shipped','a_ag','a_x','2026-01-01','2026-01-01')`.execute(
        db
      )
    ).rejects.toThrow(/CHECK|check/i)
    // question without state is malformed too — the biconditional's question-arm (D-m);
    // assignee is set so only this CHECK can reject
    await expect(
      sql`insert into threads (id, task_id, kind, assignee_id, created_by, created_at, updated_at)
            values ('th_q4','t_x','question','a_ag','a_x','2026-01-01','2026-01-01')`.execute(db)
    ).rejects.toThrow(/CHECK|check/i)
    // thread kind vocabulary enforced (D-m)
    await expect(
      sql`insert into threads (id, task_id, kind, assignee_id, created_by, created_at, updated_at)
            values ('th_k','t_x','bogus','a_ag','a_x','2026-01-01','2026-01-01')`.execute(db)
    ).rejects.toThrow(/CHECK|check/i)
    // messages: unique seq per thread (D-y ordering)
    await sql`insert into messages (id, thread_id, seq, author_id, body, created_at)
                values ('ms_1','th_n',1,'a_x','hi','2026-01-01')`.execute(db)
    await expect(
      sql`insert into messages (id, thread_id, seq, author_id, body, created_at)
            values ('ms_2','th_n',1,'a_x','again','2026-01-01')`.execute(db)
    ).rejects.toThrow(/UNIQUE/i)
    // links: kind check + idempotency uniqueness (D-t)
    await sql`insert into links (id, task_id, kind, url, created_by, created_at)
                values ('lk_1','t_x','pr','https://x/1','a_x','2026-01-01')`.execute(db)
    await expect(
      sql`insert into links (id, task_id, kind, url, created_by, created_at)
            values ('lk_2','t_x','wiki','https://x/2','a_x','2026-01-01')`.execute(db)
    ).rejects.toThrow(/CHECK|check/i)
    await expect(
      sql`insert into links (id, task_id, kind, url, created_by, created_at)
            values ('lk_3','t_x','pr','https://x/1','a_x','2026-01-01')`.execute(db)
    ).rejects.toThrow(/UNIQUE/i)
    // inbox: kind vocabulary — claim_conflict IN the vocabulary since Plan C (D-cc
    // extends D-r's set once wake paths exist); the fourth bogus kind stays rejected
    await sql`insert into inbox_items (id, actor_id, kind, task_id, read, created_at)
                values ('ib_1','a_x','assigned','t_x',0,'2026-01-01')`.execute(db)
    await sql`insert into inbox_items (id, actor_id, kind, task_id, read, created_at)
                values ('ib_cc','a_x','claim_conflict','t_x',0,'2026-01-01')`.execute(db)
    await expect(
      sql`insert into inbox_items (id, actor_id, kind, task_id, read, created_at)
            values ('ib_2','a_x','bogus_kind','t_x',0,'2026-01-01')`.execute(db)
    ).rejects.toThrow(/CHECK|check/i)
    // attachments: per-task content identity (D-s dedupe anchor)
    await sql`insert into attachments (id, task_id, filename, content_type, sha256, bytes,
                    created_by, created_at)
                    values ('at_1','t_x','a.md','text/markdown','ab',1,'a_x','2026-01-01')`.execute(
      db
    )
    await expect(
      sql`insert into attachments (id, task_id, filename, content_type, sha256, bytes,
                    created_by, created_at)
                    values ('at_2','t_x','a.md','text/markdown','ab',1,'a_x','2026-01-01')`.execute(
        db
      )
    ).rejects.toThrow(/UNIQUE/i)
    await db.destroy()
  })

  it('pins webhook DDL: unique url, integer checkpoint fields (D-bb)', async () => {
    const db = makeDb(':memory:')
    await migrateToLatest(db)
    await seedActorAndTask(db) // a_x (human) + t_x
    await sql`insert into actors (id, kind, handle, display_name, description, created_at)
                  values ('a_ag2','agent','ag2','Ag2','','2026-01-01')`.execute(db)
    await sql`insert into webhooks (id, actor_id, url, secret, created_by, created_at,
                      delivered_cursor, attempts, next_attempt_at)
                  values ('wh_1','a_ag2','http://x/cb','s3cr3t','a_x','2026-01-01',0,0,0)`.execute(
      db
    )
    await expect(
      sql`insert into webhooks (id, actor_id, url, secret, created_by, created_at,
                      delivered_cursor, attempts, next_attempt_at)
                  values ('wh_2','a_ag2','http://x/cb','other','a_x','2026-01-01',0,0,0)`.execute(
        db
      )
    ).rejects.toThrow(/UNIQUE/i) // one runner, one wake path (D-bb)
    await expect(
      sql`insert into webhooks (id, actor_id, url, secret, created_by, created_at,
                      delivered_cursor, attempts, next_attempt_at)
                  values ('wh_3','a_missing','http://x/y','s','a_x','2026-01-01',0,0,0)`.execute(db)
    ).rejects.toThrow(/FOREIGN KEY|foreign key/i)
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
