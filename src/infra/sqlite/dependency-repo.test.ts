import { describe, expect, it } from 'vitest'
import { SqliteDependencyRepo } from '#root/infra/sqlite/dependency-repo'
import { freshDb, seedActor, seedTask, setStatus } from '#root/testing/fixtures'

const setup = async () => {
  const db = await freshDb()
  await seedActor(db, 'a_creator', 'human')
  await seedTask(db, 't_x')
  await seedTask(db, 't_y')
  await seedTask(db, 't_z')
  return { db, repo: new SqliteDependencyRepo(db) }
}

describe('SqliteDependencyRepo', () => {
  it('add is idempotent and remove works', async () => {
    const { db, repo } = await setup()
    await repo.add('t_x', 't_y')
    await repo.add('t_x', 't_y') // no throw
    await repo.remove('t_x', 't_y')
    await repo.remove('t_x', 't_y') // no throw on missing edge
    await db.destroy()
  })

  it('detects direct and transitive cycles', async () => {
    const { db, repo } = await setup()
    // X blocks Y  (t_x -> t_y)
    await repo.add('t_x', 't_y')
    // adding Y blocks X would close the cycle
    expect(await repo.wouldCycle('t_y', 't_x')).toBe(true)
    // Z is unrelated — no cycle
    expect(await repo.wouldCycle('t_z', 't_x')).toBe(false)
    expect(await repo.wouldCycle('t_y', 't_z')).toBe(false)
    // transitive: Z blocks X, and X blocks Y ⇒ Y blocking Z is a cycle
    await repo.add('t_z', 't_x')
    expect(await repo.wouldCycle('t_y', 't_z')).toBe(true)
    await db.destroy()
  })

  it('an already-implied edge is redundant, not a cycle', async () => {
    const { db, repo } = await setup()
    // Z blocks X blocks Y ⇒ adding "Z blocks Y" short-circuits, it does not close a cycle
    await repo.add('t_z', 't_x')
    await repo.add('t_x', 't_y')
    expect(await repo.wouldCycle('t_z', 't_y')).toBe(false)
    await db.destroy()
  })

  it('unmetBlockers skips done blockers', async () => {
    const { db, repo } = await setup()
    await repo.add('t_x', 't_y')
    expect((await repo.unmetBlockers('t_y')).map((b) => b.id)).toEqual(['t_x'])
    await setStatus(db, 't_x', 'done')
    expect(await repo.unmetBlockers('t_y')).toEqual([])
    await db.destroy()
  })
})
