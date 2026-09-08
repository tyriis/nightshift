import { describe, expect, it } from 'vitest'
import { SqliteLinkRepo } from '#root/infra/sqlite/link-repo'
import { freshDb, seedActor, seedTask } from '#root/testing/fixtures'
import type { LinkDraft } from '#root/application/ports'

const setup = async () => {
  const db = await freshDb()
  await seedActor(db, 'a_creator', 'human')
  await seedTask(db, 't_1')
  await seedTask(db, 't_2')
  return { db, repo: new SqliteLinkRepo(db) }
}

const draft = (over: Partial<LinkDraft> = {}): LinkDraft => ({
  id: 'lk_1',
  task_id: 't_1',
  kind: 'pr',
  url: 'https://x/1',
  created_by: 'a_creator',
  created_at: '2026-01-01T00:00:00.000Z',
  ...over,
})

describe('SqliteLinkRepo', () => {
  it('adds the full record and reads it back', async () => {
    const { db, repo } = await setup()
    const added = await repo.add(draft())
    expect(added).toEqual(draft())
    expect(await repo.find('lk_1')).toEqual(draft())
    expect(await repo.find('lk_x')).toBeNull()
    await db.destroy()
  })

  it('lists per task ordered by created_at, id', async () => {
    const { db, repo } = await setup()
    await repo.add(
      draft({ id: 'lk_c', url: 'https://x/c', created_at: '2026-01-02T00:00:00.000Z' })
    )
    await repo.add(draft({ id: 'lk_b', url: 'https://x/b' })) // tie on created_at…
    await repo.add(draft({ id: 'lk_a', url: 'https://x/a' })) // …broken by id asc
    await repo.add(draft({ id: 'lk_z', task_id: 't_2', url: 'https://x/z' }))
    expect((await repo.listForTask('t_1')).map((l) => l.id)).toEqual(['lk_a', 'lk_b', 'lk_c'])
    expect(await repo.listForTask('t_missing')).toEqual([])
    await db.destroy()
  })

  it('findByTaskKindUrl hits only the exact (task, kind, url) triple', async () => {
    const { db, repo } = await setup()
    await repo.add(draft({ id: 'lk_1', kind: 'pr', url: 'https://x/1' }))
    expect(await repo.findByTaskKindUrl('t_1', 'pr', 'https://x/1')).toMatchObject({ id: 'lk_1' })
    expect(await repo.findByTaskKindUrl('t_2', 'pr', 'https://x/1')).toBeNull() // other task
    expect(await repo.findByTaskKindUrl('t_1', 'doc', 'https://x/1')).toBeNull() // other kind
    expect(await repo.findByTaskKindUrl('t_1', 'pr', 'https://x/2')).toBeNull() // other url
    await db.destroy()
  })

  it('remove deletes; second remove is a no-op', async () => {
    const { db, repo } = await setup()
    await repo.add(draft())
    await repo.remove('lk_1')
    expect(await repo.find('lk_1')).toBeNull()
    await expect(repo.remove('lk_1')).resolves.toBeUndefined() // idempotent delete
    await db.destroy()
  })
})
