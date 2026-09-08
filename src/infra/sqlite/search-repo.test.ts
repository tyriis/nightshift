import { describe, expect, it } from 'vitest'
import { sql, type Kysely } from 'kysely'
import { DomainError } from '#root/domain/errors'
import { makeDb } from '#root/infra/sqlite/db'
import { migrateToLatest } from '#root/infra/sqlite/migrations'
import type { DB } from '#root/infra/sqlite/schema'
import { SqliteSearchRepo } from '#root/infra/sqlite/search-repo'

const setup = async () => {
  const db = makeDb(':memory:')
  await migrateToLatest(db)
  await sql`insert into actors (id, kind, handle, display_name, description, created_at)
              values ('a_h','human','h','H','','2026-01-01')`.execute(db)
  const task = (id: string, title: string, description: string, ac: string) =>
    sql`insert into tasks (id, title, description, acceptance_criteria, created_by, created_at, updated_at, position)
          values (${id}, ${title}, ${description}, ${ac}, 'a_h', '2026-01-01', '2026-01-01', 1)`.execute(
      db
    )
  return { db, task }
}

describe('SqliteSearchRepo (D-gg)', () => {
  it('matches title/description/AC; returns id/title/snippet/score, score-desc', async () => {
    const { db, task } = await setup()
    await task(
      't_a',
      'Deploy the widget service',
      'kubernetes widget rollout notes',
      'widgets live'
    )
    await task('t_b', 'Unrelated', 'widget mentions only in the description body', '')
    await task('t_c', 'Nothing here', '', '')
    const repo = new SqliteSearchRepo(db)
    const hits = await repo.search('widget', 10)
    expect(hits.map((h) => h.id).sort()).toEqual(['t_a', 't_b']) // AC-free t_c absent
    expect(hits[0].title).toBeDefined()
    expect(hits[0].snippet).toMatch(/\[widget\]/i) // snippet wraps matched terms in [] (D-gg marker choice)
    expect(hits[0].score).toBeGreaterThan(hits[1].score) // bm25 flipped: higher = better
    expect(await repo.search('widget', 1)).toHaveLength(1) // limit respected (score order decides WHICH one)
    await db.destroy()
  })

  it('population rides the triggers: raw insert/update visible; UPDATE moves the term', async () => {
    const { db, task } = await setup()
    await task('t_u', 'alpha', 'body one', '')
    const repo = new SqliteSearchRepo(db)
    expect((await repo.search('alpha', 10)).map((h) => h.id)).toEqual(['t_u'])
    await sql`update tasks set title = 'beta', description = 'body one' where id = 't_u'`.execute(
      db
    )
    expect(await repo.search('alpha', 10)).toEqual([]) // AU trigger deleted the old row
    expect((await repo.search('beta', 10)).map((h) => h.id)).toEqual(['t_u']) // and inserted the new
    await db.destroy()
  })

  it('malformed FTS syntax is invalid_request, not a 500 (taxonomy: NO new code)', async () => {
    const { db, task } = await setup()
    await task('t_q', 'searchable term', '', '')
    const repo = new SqliteSearchRepo(db)
    const err = await repo.search('"unbalanced', 10).catch((e) => e)
    expect(err).toBeInstanceOf(DomainError)
    expect((err as DomainError).code).toBe('invalid_request')
    // probe note (record observed behavior here, never assume): PROBED — the engine
    // REJECTS 'AND OR' too ("fts5: syntax error near \"AND\""), so it is pinned as the
    // second case; '"unbalanced' surfaces as "unterminated string" (no fts5: prefix).
    const err2 = await repo.search('AND OR', 10).catch((e) => e)
    expect(err2).toBeInstanceOf(DomainError)
    expect((err2 as DomainError).code).toBe('invalid_request')
    await db.destroy()
  })

  it('everything else RE-THROWS untouched (no blanket catch swallowing real bugs)', async () => {
    // Error arm: a destroyed driver fails for a NON-FTS reason — the raw Error must
    // survive unmapped (internal_error honesty via the problem.ts fallback)
    const { db, task } = await setup()
    await task('t_q', 'searchable term', '', '')
    const repo = new SqliteSearchRepo(db)
    await db.destroy()
    const err = await repo.search('widget', 10).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(DomainError)
    expect((err as Error).message).toMatch(/destroyed/)
    // non-Error arm: the message extraction String(e) fallback, then rethrow verbatim
    // stub matches kysely 0.29's raw path: getExecutor().{transformQuery,compileQuery,
    // executeQuery} — the hostile throw happens at executeQuery, pre-driver
    const hostile = {
      getExecutor: () => ({
        transformQuery: (q: unknown) => q,
        compileQuery: (q: unknown) => q,
        executeQuery: async () => {
          throw 'boom'
        },
      }),
    } as unknown as Kysely<DB>
    await expect(new SqliteSearchRepo(hostile).search('x', 10)).rejects.toBe('boom')
  })
})
