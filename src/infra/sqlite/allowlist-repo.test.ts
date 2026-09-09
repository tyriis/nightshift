import { describe, expect, it } from 'vitest'
import { SqliteAllowlistRepo } from '#root/infra/sqlite/allowlist-repo'
import { freshDb, seedActor } from '#root/testing/fixtures'

// D-tt rows (emails lowercased by the use-case before they ever reach the store)
const ALICE = {
  email: 'alice@example.com',
  added_by: 'a_human',
  created_at: '2026-01-01T00:00:00.000Z',
}
const BOB = {
  email: 'bob@example.com',
  added_by: 'a_human',
  created_at: '2026-01-02T00:00:00.000Z',
}

describe('SqliteAllowlistRepo (D-tt)', () => {
  const open = async () => {
    const db = await freshDb()
    await seedActor(db, 'a_human', 'human', 'nils')
    return { db, repo: new SqliteAllowlistRepo(db) }
  }

  it('insert/find/list round-trip the whole row; list is email-ascending (pinned)', async () => {
    const { db, repo } = await open()
    expect(await repo.findByEmail('alice@example.com')).toBeNull() // unknown => null
    expect(await repo.list()).toEqual([])
    // inserted bob-first so the ascending pin cannot be insertion order in disguise
    await repo.insert(BOB)
    await repo.insert(ALICE)
    expect(await repo.findByEmail('alice@example.com')).toEqual(ALICE)
    expect(await repo.list()).toEqual([ALICE, BOB])
    await db.destroy()
  })

  it('remove returns changed>0 both ways; the row is gone', async () => {
    const { db, repo } = await open()
    expect(await repo.remove('ghost@x.example')).toBe(false) // absent arm first
    await repo.insert(ALICE)
    expect(await repo.remove('alice@example.com')).toBe(true)
    expect(await repo.findByEmail('alice@example.com')).toBeNull()
    expect(await repo.list()).toEqual([])
    await db.destroy()
  })
})
