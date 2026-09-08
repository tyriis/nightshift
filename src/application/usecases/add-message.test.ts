import { describe, expect, it } from 'vitest'
import { CreateTask } from '#root/application/usecases/create-task'
import { CreateThread } from '#root/application/usecases/create-thread'
import { AddMessage } from '#root/application/usecases/add-message'
import { SqliteInboxRepo } from '#root/infra/sqlite/inbox-repo'
import { SqliteAuditRepo } from '#root/infra/sqlite/audit-repo'
import { SqliteThreadRepo } from '#root/infra/sqlite/thread-repo'
import { buildUow, fixedClock, human, seqIds } from '#root/application/usecases/create-task.test'
import { seedActor } from '#root/testing/fixtures'

const setup = async () => {
  const { db, uow } = await buildUow() // seeds a_human (nils)
  await seedActor(db, 'a_ana', 'human', 'ana')
  const ids = seqIds()
  const task = await new CreateTask(uow, fixedClock(), ids).run({
    ...human,
    title: 'leaf',
    status: 'todo',
  })
  // one shared id counter for the thread-side use-cases: separate instances would
  // mint the same ms_* twice (uc's first message vs msgUc's second)
  const threadIds = seqIds()
  const uc = new CreateThread(uow, fixedClock(), threadIds)
  const msgUc = new AddMessage(uow, fixedClock(), threadIds)
  return { db, uow, uc, msgUc, taskId: task.id }
}

describe('AddMessage (spec §6.5)', () => {
  it('appends ordered messages and audits each', async () => {
    const { db, uc, taskId, msgUc } = await setup()
    const t = await uc.run({ ...human, taskId, kind: 'note', body: 'first' })
    const m2 = await msgUc.run({ ...human, threadId: t.thread.id, body: '@ana second' })
    expect(m2.seq).toBe(2)
    const audit = await new SqliteAuditRepo(db).search({
      entity_type: 'thread',
      entity_id: t.thread.id,
      limit: 5,
    })
    expect(audit[0]).toMatchObject({ action: 'message_created' })
    const anaInbox = await new SqliteInboxRepo(db).listForActor('a_ana', {
      unreadOnly: false,
      limit: 5,
    })
    expect(anaInbox.map((i) => i.kind)).toEqual(['mentioned'])
    await db.destroy()
  })

  it('keeps appending per-thread seq (third message gets seq=3)', async () => {
    const { db, uc, taskId, msgUc } = await setup()
    const t = await uc.run({ ...human, taskId, kind: 'note', body: 'first' })
    await msgUc.run({ ...human, threadId: t.thread.id, body: 'second' })
    const m3 = await msgUc.run({ ...human, threadId: t.thread.id, body: 'third' })
    expect(m3.seq).toBe(3)
    await db.destroy()
  })

  it('author never self-notifies on replies (D-q)', async () => {
    const { db, uc, taskId, msgUc } = await setup()
    const t = await uc.run({ ...human, taskId, kind: 'note', body: 'first' })
    await msgUc.run({ ...human, threadId: t.thread.id, body: '@nils my own handle' })
    expect(
      await new SqliteInboxRepo(db).listForActor('a_human', { unreadOnly: false, limit: 5 })
    ).toEqual([])
    await db.destroy()
  })

  it('a reply to an open question does not change its state (answering is Task 6)', async () => {
    const { db, uc, taskId, msgUc } = await setup()
    const t = await uc.run({
      ...human,
      taskId,
      kind: 'question',
      body: 'which database?',
      assignee_id: 'a_ana',
    })
    await msgUc.run({ ...human, threadId: t.thread.id, body: 'any updates?' })
    const after = await new SqliteThreadRepo(db).find(t.thread.id)
    expect(after).toMatchObject({ state: 'open', answer_message_id: null })
    await db.destroy()
  })

  it('unknown thread → not_found', async () => {
    const { db, msgUc } = await setup()
    await expect(msgUc.run({ ...human, threadId: 'th_ghost', body: 'x' })).rejects.toMatchObject({
      code: 'not_found',
    })
    await db.destroy()
  })
})
