import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { makeDb } from '#root/infra/sqlite/db'
import { migrateToLatest } from '#root/infra/sqlite/migrations'
import { SqliteWebhookRepo } from '#root/infra/sqlite/webhook-repo'

const setup = async () => {
  const db = makeDb(':memory:')
  await migrateToLatest(db)
  await sql`insert into actors (id, kind, handle, display_name, description, created_at)
              values ('a_h','human','h','H','','2026-01-01'),
                     ('a_g','agent','g','G','','2026-01-01')`.execute(db)
  return db
}
const draft = (id = 'wh_1') => ({
  id,
  actor_id: 'a_g',
  url: `http://x/${id}`,
  secret: 'sekret',
  created_by: 'a_h',
  created_at: '2026-01-01',
  delivered_cursor: 7,
})

describe('SqliteWebhookRepo (D-ff)', () => {
  it('read paths never carry the secret; listDue is the ONLY secret reader (D-ff)', async () => {
    const db = await setup()
    const repo = new SqliteWebhookRepo(db)
    await repo.add(draft())
    const found = await repo.find('wh_1')
    expect(found).toEqual({
      id: 'wh_1',
      actor_id: 'a_g',
      url: 'http://x/wh_1',
      created_by: 'a_h',
      created_at: '2026-01-01',
      delivered_cursor: 7,
    })
    expect(JSON.stringify(found)).not.toContain('sekret') // exposure surface zero at the repo boundary
    expect(await repo.list()).toEqual([found])
    const due = await repo.listDue(0) // next_attempt_at 0 <= 0 ⇒ due
    expect(due).toEqual([
      { id: 'wh_1', url: 'http://x/wh_1', secret: 'sekret', delivered_cursor: 7, attempts: 0 },
    ])
    await db.destroy()
  })

  it('listDue windows on next_attempt_at; advance resets attempts; scheduleRetry parks', async () => {
    const db = await setup()
    const repo = new SqliteWebhookRepo(db)
    await repo.add(draft())
    expect(await repo.listDue(1000)).toHaveLength(1)
    await repo.scheduleRetry('wh_1', 3, 5000)
    expect(await repo.listDue(4999)).toEqual([]) // parked until 5000
    expect(await repo.listDue(5000)).toHaveLength(1)
    await repo.advance('wh_1', 42)
    const r = await repo.find('wh_1')
    expect(r?.delivered_cursor).toBe(42)
    const due = await repo.listDue(5000)
    expect(due[0]?.attempts).toBe(0) // advance resets the backoff counter
    await db.destroy()
  })

  it('setSecret swaps the key; remove deletes; list is oldest-first', async () => {
    const db = await setup()
    const repo = new SqliteWebhookRepo(db)
    await repo.add(draft('wh_b'))
    await repo.add(draft('wh_a'))
    await repo.setSecret('wh_a', 'rotated')
    expect((await repo.listDue(0)).find((w) => w.id === 'wh_a')?.secret).toBe('rotated')
    await repo.remove('wh_a')
    expect((await repo.list()).map((w) => w.id)).toEqual(['wh_b'])
    expect(await repo.find('wh_a')).toBeNull()
    await db.destroy()
  })

  it('reanchor is the rotation one-write: checkpoint moves, backoff clears, park un-parks (D-bb)', async () => {
    const db = await setup()
    const repo = new SqliteWebhookRepo(db)
    await repo.add(draft())
    await repo.scheduleRetry('wh_1', 3, 5000) // parked with a fat backoff counter
    await repo.reanchor('wh_1', 99)
    expect((await repo.find('wh_1'))?.delivered_cursor).toBe(99)
    const due = await repo.listDue(0) // un-parked: due again at once
    expect(due).toHaveLength(1)
    expect(due[0]?.attempts).toBe(0) // rotation re-registration starts the backoff fresh
    await db.destroy()
  })
})
