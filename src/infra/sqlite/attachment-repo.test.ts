import { describe, expect, it } from 'vitest'
import { SqliteAttachmentRepo } from '#root/infra/sqlite/attachment-repo'
import { freshDb, seedActor, seedTask } from '#root/testing/fixtures'
import type { AttachmentRecord } from '#root/application/ports'

const setup = async () => {
  const db = await freshDb()
  await seedActor(db, 'a_creator', 'human')
  await seedTask(db, 't_1')
  await seedTask(db, 't_2')
  return { db, repo: new SqliteAttachmentRepo(db) }
}

const rec = (over: Partial<AttachmentRecord> = {}): AttachmentRecord => ({
  id: 'at_1',
  task_id: 't_1',
  filename: 'a.md',
  content_type: 'text/markdown',
  sha256: 'aa',
  bytes: 2,
  created_by: 'a_creator',
  created_at: '2026-01-01T00:00:00.000Z',
  ...over,
})

describe('SqliteAttachmentRepo', () => {
  it('adds the full record and reads it back', async () => {
    const { db, repo } = await setup()
    const added = await repo.add(rec())
    expect(added).toEqual(rec())
    expect(await repo.find('at_1')).toEqual(rec())
    expect(await repo.find('at_x')).toBeNull()
    await db.destroy()
  })

  it('lists per task ordered by created_at, id', async () => {
    const { db, repo } = await setup()
    await repo.add(rec({ id: 'at_c', sha256: 'cc', created_at: '2026-01-02T00:00:00.000Z' }))
    await repo.add(rec({ id: 'at_b', sha256: 'bb' })) // tie on created_at…
    await repo.add(rec({ id: 'at_a', sha256: 'dd' })) // …broken by id asc
    await repo.add(rec({ id: 'at_z', task_id: 't_2', sha256: 'ee' }))
    expect((await repo.listForTask('t_1')).map((a) => a.id)).toEqual(['at_a', 'at_b', 'at_c'])
    expect(await repo.listForTask('t_missing')).toEqual([])
    await db.destroy()
  })

  it('findByTaskShaFilename hits only the exact (task, sha, filename) triple', async () => {
    const { db, repo } = await setup()
    await repo.add(rec({ id: 'at_1', filename: 'a.md', sha256: 'aa' }))
    expect(await repo.findByTaskShaFilename('t_1', 'aa', 'a.md')).toMatchObject({ id: 'at_1' })
    expect(await repo.findByTaskShaFilename('t_2', 'aa', 'a.md')).toBeNull() // other task
    expect(await repo.findByTaskShaFilename('t_1', 'zz', 'a.md')).toBeNull() // other sha
    expect(await repo.findByTaskShaFilename('t_1', 'aa', 'other.md')).toBeNull() // other name
    await db.destroy()
  })
})
