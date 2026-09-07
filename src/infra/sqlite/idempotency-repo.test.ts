import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { SqliteIdempotencyRepo } from '#root/infra/sqlite/idempotency-repo'
import { freshDb } from '#root/testing/fixtures'

const req = (key = 'k-1') => ({
  actor_id: 'a_1',
  idem_key: key,
  request_method: 'POST',
  request_path: '/tasks',
  created_at: '2026-01-01T00:00:00.000Z',
})

describe('SqliteIdempotencyRepo', () => {
  it('reserve → complete → replay', async () => {
    const db = await freshDb()
    const repo = new SqliteIdempotencyRepo(db)
    expect(await repo.reserve(req())).toEqual({ state: 'reserved' })
    // concurrent duplicate while unresolved:
    expect(await repo.reserve(req())).toEqual({ state: 'in_flight' })
    await repo.complete('a_1', 'k-1', 201, '{"id":"t_1"}')
    expect(await repo.reserve(req())).toEqual({
      state: 'complete',
      status: 201,
      body: '{"id":"t_1"}',
    })
    await db.destroy()
  })

  it('keys are scoped per actor', async () => {
    const db = await freshDb()
    const repo = new SqliteIdempotencyRepo(db)
    expect(await repo.reserve(req())).toEqual({ state: 'reserved' })
    expect(await repo.reserve({ ...req(), actor_id: 'a_2' })).toEqual({ state: 'reserved' })
    await db.destroy()
  })

  it('remove frees the key for retry (5xx path, decision D-j)', async () => {
    const db = await freshDb()
    const repo = new SqliteIdempotencyRepo(db)
    await repo.reserve(req())
    await repo.remove('a_1', 'k-1')
    expect(await repo.reserve(req())).toEqual({ state: 'reserved' })
    await db.destroy()
  })

  it('in-progress (body null) is in_flight; only a completed body replays', async () => {
    const db = await freshDb()
    const repo = new SqliteIdempotencyRepo(db)
    // reserved but not completed => body is null => never replay, always in_flight
    expect(await repo.reserve(req())).toEqual({ state: 'reserved' })
    expect(await repo.reserve(req())).toEqual({ state: 'in_flight' })
    // completing stores status + body; the next reserve replays the stored response
    await repo.complete('a_1', 'k-1', 200, '{"ok":true}')
    const replay = await repo.reserve(req())
    expect(replay).toEqual({ state: 'complete', status: 200, body: '{"ok":true}' })
    // the distinction lives in the row: null body = in-progress, non-null = complete
    const row = await sql<{ status: number | null; body: string | null }>`
      select status, body from idempotency_keys where actor_id = 'a_1' and idem_key = 'k-1'
    `.execute(db)
    expect(row.rows[0]).toEqual({ status: 200, body: '{"ok":true}' })
    await db.destroy()
  })

  it('complete on an unknown key is a silent no-op (never creates a row)', async () => {
    const db = await freshDb()
    const repo = new SqliteIdempotencyRepo(db)
    // no reserve first: complete must not throw nor materialise a phantom row
    await repo.complete('a_1', 'ghost', 500, 'nope')
    const count = await sql<{ n: number }>`
      select count(*) as n from idempotency_keys where actor_id = 'a_1' and idem_key = 'ghost'
    `.execute(db)
    expect(count.rows[0]?.n).toBe(0)
    // the key remains free to reserve normally
    expect(await repo.reserve(req('ghost'))).toEqual({ state: 'reserved' })
    await db.destroy()
  })
})
