import { describe, expect, it } from 'vitest'
import { SqliteLabelRepo } from '#root/infra/sqlite/label-repo'
import { freshDb, seedActor, seedTask } from '#root/testing/fixtures'

const setup = async () => {
  const db = await freshDb()
  await seedActor(db, 'a_creator', 'human')
  await seedTask(db, 't_1')
  return { db, repo: new SqliteLabelRepo(db) }
}

describe('SqliteLabelRepo', () => {
  it('ensure is create-or-get', async () => {
    const { db, repo } = await setup()
    const made = await repo.ensure({
      id: 'l_new',
      name: 'infra',
      color: '#f00',
      created_at: '2026-01-01T00:00:00.000Z',
    })
    const again = await repo.ensure({
      id: 'l_other',
      name: 'infra',
      color: '#00f',
      created_at: '2026-01-01T00:00:00.000Z',
    })
    expect(again.id).toBe(made.id)
    expect(await repo.list()).toHaveLength(1)
    await db.destroy()
  })

  it('attach/detach and labelsFor', async () => {
    const { db, repo } = await setup()
    const label = await repo.ensure({
      id: 'l_a',
      name: 'a',
      color: '#f00',
      created_at: '2026-01-01T00:00:00.000Z',
    })
    await repo.attach('t_1', label.id)
    await repo.attach('t_1', label.id) // idempotent
    expect((await repo.labelsFor('t_1')).map((l) => l.name)).toEqual(['a'])
    await repo.detach('t_1', label.id)
    expect(await repo.labelsFor('t_1')).toEqual([])
    await db.destroy()
  })
})
