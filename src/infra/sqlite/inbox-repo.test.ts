import { describe, expect, it } from 'vitest'
import { SqliteInboxRepo } from '#root/infra/sqlite/inbox-repo'
import { freshDb, seedActor, seedTask } from '#root/testing/fixtures'
import type { InboxKind } from '#root/application/ports'

const setup = async () => {
  const db = await freshDb()
  await seedActor(db, 'a_creator', 'human') // seedTask's FK target (created_by default)
  await seedActor(db, 'a_x', 'human', 'nils')
  await seedTask(db, 't_1')
  return { db, repo: new SqliteInboxRepo(db) }
}

const add = (
  id: string,
  kind: InboxKind,
  created_at = `2026-01-0${id.slice(-1)}T00:00:00.000Z`
) => ({
  id,
  actor_id: 'a_x',
  kind,
  task_id: 't_1',
  thread_id: null as string | null,
  created_at,
})

describe('SqliteInboxRepo', () => {
  it('adds, lists newest-first, filters unread, caps limit', async () => {
    const { db, repo } = await setup()
    // ids chosen so lexical id-order CONTRADICTS recency: 'ib_9' is the older row.
    // An `order by id desc` implementation would answer ['ib_9','ib_2'] here.
    await repo.add(add('ib_2', 'mentioned', '2026-01-02T00:00:00.000Z')) // newer
    await repo.add(add('ib_9', 'assigned', '2026-01-01T00:00:00.000Z')) // older
    expect(
      (await repo.listForActor('a_x', { unreadOnly: false, limit: 10 })).map((i) => i.id)
    ).toEqual(['ib_2', 'ib_9'])
    await repo.markRead('ib_9', 'a_x')
    expect(
      (await repo.listForActor('a_x', { unreadOnly: true, limit: 10 })).map((i) => i.id)
    ).toEqual(['ib_2'])
    expect(
      (await repo.listForActor('a_x', { unreadOnly: false, limit: 1 })).map((i) => i.id)
    ).toEqual(['ib_2'])
    await db.destroy()
  })

  it('breaks same-timestamp ties by id desc (created_at ties stay deterministic)', async () => {
    const { db, repo } = await setup()
    const stamp = '2026-01-05T00:00:00.000Z'
    await repo.add(add('ib_3', 'assigned', stamp))
    await repo.add(add('ib_7', 'mentioned', stamp))
    expect(
      (await repo.listForActor('a_x', { unreadOnly: false, limit: 10 })).map((i) => i.id)
    ).toEqual(['ib_7', 'ib_3'])
    await db.destroy()
  })

  it('markRead flips read once; other actors and unknown ids get false', async () => {
    const { db, repo } = await setup()
    await repo.add(add('ib_1', 'assigned'))
    expect(await repo.markRead('ib_1', 'a_other')).toBe(false)
    expect(await repo.markRead('ib_x', 'a_x')).toBe(false)
    expect(await repo.markRead('ib_1', 'a_x')).toBe(true)
    const [item] = await repo.listForActor('a_x', { unreadOnly: false, limit: 5 })
    expect(item!.read).toBe(true)
    await db.destroy()
  })

  it('lists per-actor only: another actor sees none of a_x items', async () => {
    const { db, repo } = await setup()
    await seedActor(db, 'a_y', 'human', 'ana')
    await repo.add(add('ib_1', 'question_assigned'))
    expect(await repo.listForActor('a_y', { unreadOnly: false, limit: 10 })).toEqual([])
    await db.destroy()
  })
})
