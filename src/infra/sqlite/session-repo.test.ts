import { describe, expect, it } from 'vitest'
import { SqliteSessionRepo } from '#root/infra/sqlite/session-repo'
import { freshDb, seedActor } from '#root/testing/fixtures'

const NOW = '2026-09-09T12:00:00.000Z'
const FUTURE = '2026-09-09T20:00:00.000Z'
const PAST = '2026-09-09T11:00:00.000Z'

describe('SqliteSessionRepo (D-qq)', () => {
  const seed = async (role: 'admin' | 'member' = 'admin') => {
    const db = await freshDb()
    await seedActor(db, 'a_human', 'human', undefined, role)
    const repo = new SqliteSessionRepo(db)
    await repo.create({
      id: 's_1',
      actor_id: 'a_human',
      csrf: 'c_1',
      created_at: NOW,
      expires_at: FUTURE,
    })
    return { db, repo }
  }

  it('findValid joins session + actor; csrf and role ride, actor is trimmed', async () => {
    const { db, repo } = await seed('member')
    const hit = await repo.findValid('s_1', NOW)
    expect(hit?.session).toEqual({
      id: 's_1',
      actor_id: 'a_human',
      csrf: 'c_1',
      created_at: NOW,
      expires_at: FUTURE,
      revoked_at: null,
    })
    // explicit-alias join posture (actor-repo.ts:63-97 exemplar): real actor columns,
    // trimmed ones are empty strings — never join bleed-through.
    expect(hit?.actor).toEqual({
      id: 'a_human',
      kind: 'human',
      handle: 'human_a_human',
      display_name: 'Seed a_human',
      role: 'member',
      description: '',
      created_at: '',
    })
    await db.destroy()
  })

  it('expired (expires_at past) and unknown ids are null', async () => {
    const { db, repo } = await seed()
    await repo.create({
      id: 's_gone',
      actor_id: 'a_human',
      csrf: 'c_2',
      created_at: PAST,
      expires_at: PAST,
    })
    expect(await repo.findValid('s_gone', NOW)).toBeNull() // lazy expiry, no sweeper
    expect(await repo.findValid('s_ghost', NOW)).toBeNull()
    expect(await repo.findValid('s_1', NOW)).not.toBeNull() // same clock: live row rides on
    await db.destroy()
  })

  it('revoke then findValid => null (the table is the revocation truth)', async () => {
    const { db, repo } = await seed()
    await repo.revoke('s_1', NOW)
    expect(await repo.findValid('s_1', NOW)).toBeNull()
    await db.destroy()
  })
})
