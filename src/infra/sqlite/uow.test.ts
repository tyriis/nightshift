import { describe, expect, it } from 'vitest'
import { SqliteUnitOfWork } from '#root/infra/sqlite/uow'
import { freshDb, seedActor } from '#root/testing/fixtures'
import { SqliteTaskRepo } from '#root/infra/sqlite/task-repo'

class Boom extends Error {}

const draft = (id: string) => ({
  id,
  parent_id: null,
  title: id,
  description: '',
  acceptance_criteria: '',
  status: 'todo' as const,
  position: 1,
  created_by: 'a_creator',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
})

describe('SqliteUnitOfWork', () => {
  it('rolls back on error', async () => {
    const db = await freshDb()
    await seedActor(db, 'a_creator', 'human')
    const uow = new SqliteUnitOfWork(db)
    await expect(
      uow.withTransaction(async (repos) => {
        await repos.tasks.create(draft('t_rolled'))
        throw new Boom('nope')
      })
    ).rejects.toBeInstanceOf(Boom)
    expect(await new SqliteTaskRepo(db).findById('t_rolled')).toBeNull()
    await db.destroy()
  })

  it('commits on success and repos inside share the tx connection', async () => {
    const db = await freshDb()
    await seedActor(db, 'a_creator', 'human')
    const uow = new SqliteUnitOfWork(db)
    await uow.withTransaction(async (repos) => {
      await repos.tasks.create(draft('t_kept'))
      // visible inside the same transaction
      expect(await repos.tasks.findById('t_kept')).not.toBeNull()
    })
    expect(await new SqliteTaskRepo(db).findById('t_kept')).not.toBeNull()
    await db.destroy()
  })

  it('runs transactions one after another on the single writer', async () => {
    const db = await freshDb()
    await seedActor(db, 'a_creator', 'human')
    const uow = new SqliteUnitOfWork(db)
    const results = await Promise.all([
      uow.withTransaction(async (repos) => {
        await repos.tasks.create(draft('t_c1'))
        return 1
      }),
      uow.withTransaction(async (repos) => {
        await repos.tasks.create(draft('t_c2'))
        return 2
      }),
    ])
    expect(results).toEqual([1, 2])
    expect(await new SqliteTaskRepo(db).findById('t_c1')).not.toBeNull()
    expect(await new SqliteTaskRepo(db).findById('t_c2')).not.toBeNull()
    await db.destroy()
  })
})
