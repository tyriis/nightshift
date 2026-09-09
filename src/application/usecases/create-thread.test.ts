import { describe, expect, it } from 'vitest'
import { CreateTask } from '#root/application/usecases/create-task'
import { SplitTask } from '#root/application/usecases/split-task'
import { CreateThread } from '#root/application/usecases/create-thread'
import { SqliteInboxRepo } from '#root/infra/sqlite/inbox-repo'
import { SqliteAuditRepo } from '#root/infra/sqlite/audit-repo'
import { buildUow, fixedClock, human, seqIds } from '#root/application/usecases/create-task.test'
import { seedActor } from '#root/testing/fixtures'
import type { ActorContext } from '#root/application/ports'

const setup = async () => {
  const { db, uow } = await buildUow() // seeds a_human (nils)
  await seedActor(db, 'a_ana', 'human', 'ana')
  await seedActor(db, 'a_agent', 'agent', 'hermes-1')
  const ids = seqIds()
  const task = await new CreateTask(uow, fixedClock(), ids).run({
    ...human,
    title: 'leaf',
    status: 'todo',
  })
  // fresh seqIds for the thread use-case: `ids` already spent seq1 on the task,
  // and the block's literal expectations (th_seq1/ms_seq2) count thread-side ids
  const uc = new CreateThread(uow, fixedClock(), seqIds())
  return { db, uow, ids, uc, taskId: task.id }
}

const question = (taskId: string) => ({
  taskId,
  kind: 'question' as const,
  body: 'which database?',
  assignee_id: 'a_ana',
})

describe('CreateThread (spec §6.5)', () => {
  it('creates a note thread with first message seq=1 and audits it', async () => {
    const { db, uc, taskId } = await setup()
    const r = await uc.run({ ...human, taskId, kind: 'note', body: 'plan: do the thing' })
    expect(r.thread).toMatchObject({ id: 'th_seq1', task_id: taskId, kind: 'note', state: null })
    expect(r.message).toMatchObject({ id: 'ms_seq2', seq: 1, body: 'plan: do the thing' })
    const audit = await new SqliteAuditRepo(db).search({
      entity_type: 'thread',
      entity_id: r.thread.id,
      limit: 5,
    })
    expect(audit[0]).toMatchObject({
      action: 'thread_created',
      reason: 'thread created',
      // opening message recorded — the thread history is audit-reconstructable
      after: { kind: 'note', task_id: taskId, message_id: 'ms_seq2', seq: 1 },
    })
    await db.destroy()
  })

  it('routes @mentions to mentioned inboxes — except author and unknown handles', async () => {
    const { db, uc, taskId } = await setup()
    await uc.run({
      ...human,
      taskId,
      kind: 'note',
      body: '@ana @nils and @ghost look',
    })
    const inbox = new SqliteInboxRepo(db)
    const anaItems = await inbox.listForActor('a_ana', { unreadOnly: false, limit: 10 })
    const nilsItems = await inbox.listForActor('a_human', { unreadOnly: false, limit: 10 })
    expect(anaItems.map((i) => i.kind)).toEqual(['mentioned']) // mentioned once
    expect(nilsItems).toEqual([]) // author never self-notifies (D-q)
    await db.destroy()
  })

  it('question requires an existing assignee, opens, and notifies them', async () => {
    const { db, uc, taskId } = await setup()
    await expect(uc.run({ ...human, taskId, kind: 'question', body: 'q' })).rejects.toMatchObject({
      code: 'invalid_request',
    })
    await expect(
      // single spread: `{ taskId, ...{...question(taskId) } }` is TS2783 (spread would
      // overwrite the explicit prop); question(taskId) carries the same taskId anyway
      uc.run({ ...human, ...question(taskId), assignee_id: 'a_ghost' })
    ).rejects.toMatchObject({ code: 'not_found' })
    const r = await uc.run({ ...human, ...question(taskId) })
    expect(r.thread).toMatchObject({ kind: 'question', state: 'open', assignee_id: 'a_ana' })
    const anaInbox = await new SqliteInboxRepo(db).listForActor('a_ana', {
      unreadOnly: false,
      limit: 10,
    })
    expect(anaInbox.map((i) => i.kind)).toEqual(['question_assigned'])
    await db.destroy()
  })

  it('an agent may self-assign a question without an inbox spam entry', async () => {
    const { db, uc, taskId } = await setup()
    const agent: ActorContext = {
      actor: { id: 'a_agent', kind: 'agent', handle: 'hermes-1', display_name: 'H', role: null },
      tokenId: null,
    }
    const r = await uc.run({
      ...agent,
      taskId,
      kind: 'question',
      body: 'self-noted risk',
      assignee_id: 'a_agent',
    })
    expect(r.thread.state).toBe('open')
    expect(
      await new SqliteInboxRepo(db).listForActor('a_agent', { unreadOnly: false, limit: 5 })
    ).toEqual([])
    await db.destroy()
  })

  it('threads_on_parent gate: children block threads; human meta-note flag passes, agent flag does not (D-p)', async () => {
    const { db, uow, ids, uc } = await setup()
    const parent = await new CreateTask(uow, fixedClock(), ids).run({
      ...human,
      title: 'p',
      status: 'todo',
    })
    await new SplitTask(uow, fixedClock(), ids).run({
      ...human,
      taskId: parent.id,
      children: [{ title: 'c1' }],
    })
    await expect(
      uc.run({ ...human, taskId: parent.id, kind: 'note', body: 'x' })
    ).rejects.toMatchObject({ code: 'threads_on_parent' })
    const agent: ActorContext = {
      actor: { id: 'a_agent', kind: 'agent', handle: 'hermes-1', display_name: 'H', role: null },
      tokenId: null,
    }
    await expect(
      uc.run({ ...agent, taskId: parent.id, kind: 'note', body: 'x', metaNote: true })
    ).rejects.toMatchObject({ code: 'threads_on_parent' }) // agents can't use the UI flag
    // D-p literal: the flag is for a human posting a NOTE — a question thread gets the 409
    await expect(
      uc.run({
        ...human,
        taskId: parent.id,
        kind: 'question',
        body: 'x',
        assignee_id: 'a_ana',
        metaNote: true,
      })
    ).rejects.toMatchObject({ code: 'threads_on_parent' })
    const r = await uc.run({
      ...human,
      taskId: parent.id,
      kind: 'note',
      body: 'decision: re-split',
      metaNote: true,
    })
    const audit = await new SqliteAuditRepo(db).search({
      entity_type: 'thread',
      entity_id: r.thread.id,
      limit: 5,
    })
    expect(audit[0]?.reason).toBe('meta-note on parent (spec §6.2)') // grep-pinned forward
    await db.destroy()
  })

  it('unknown task → not_found; bogus kind → invalid_request', async () => {
    const { db, uc } = await setup()
    await expect(
      uc.run({ ...human, taskId: 't_ghost', kind: 'note', body: 'x' })
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      uc.run({ ...human, taskId: 't_seq1', kind: 'flame' as never, body: 'x' })
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await db.destroy()
  })
})
