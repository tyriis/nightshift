import { describe, expect, it } from 'vitest'
import { CreateTask } from '#root/application/usecases/create-task'
import { CreateThread } from '#root/application/usecases/create-thread'
import { UpdateQuestion } from '#root/application/usecases/update-question'
import { SqliteInboxRepo } from '#root/infra/sqlite/inbox-repo'
import { SqliteAuditRepo } from '#root/infra/sqlite/audit-repo'
import { buildUow, fixedClock, human, seqIds } from '#root/application/usecases/create-task.test'
import { seedActor } from '#root/testing/fixtures'
import type { ActorContext } from '#root/application/ports'

const ana: ActorContext = {
  actor: { id: 'a_ana', kind: 'human', handle: 'ana', display_name: 'Ana' },
  tokenId: null,
}

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
  const threadIds = seqIds()
  const threadUc = new CreateThread(uow, fixedClock(), threadIds)
  const updateUc = new UpdateQuestion(uow, fixedClock(), threadIds)
  return { db, uow, threadUc, updateUc, taskId: task.id }
}

const question = (taskId: string) => ({
  taskId,
  kind: 'question' as const,
  body: 'which database?',
  assignee_id: 'a_ana',
})

describe('UpdateQuestion (spec §6.5, D-n/D-r/D-x)', () => {
  it('walks the D-n table: open→answered→resolved with audits; reversals and terminal states reject', async () => {
    const { db, threadUc, updateUc, taskId } = await setup()
    const q = await threadUc.run({ ...human, ...question(taskId) })
    const answered = await updateUc.run({ ...ana, threadId: q.thread.id, state: 'answered' })
    expect(answered).toMatchObject({ state: 'answered' })
    let audit = await new SqliteAuditRepo(db).search({
      entity_type: 'thread',
      entity_id: q.thread.id,
      limit: 5,
    })
    expect(audit[0]).toMatchObject({
      action: 'question_state_changed',
      reason: 'question state changed',
      before: { state: 'open' },
      after: { state: 'answered' },
    })
    // the use-case DELEGATES: answered → open is not in the table (D-n)
    await expect(
      updateUc.run({ ...ana, threadId: q.thread.id, state: 'open' })
    ).rejects.toMatchObject({ code: 'question_transition' })
    await updateUc.run({ ...ana, threadId: q.thread.id, state: 'resolved' })
    audit = await new SqliteAuditRepo(db).search({
      entity_type: 'thread',
      entity_id: q.thread.id,
      limit: 5,
    })
    expect(audit[0]).toMatchObject({
      action: 'question_state_changed',
      after: { state: 'resolved' },
    })
    // terminal resolved rejects every onward move (D-n)
    await expect(
      updateUc.run({ ...ana, threadId: q.thread.id, state: 'open' })
    ).rejects.toMatchObject({ code: 'question_transition' })
    await expect(
      updateUc.run({ ...ana, threadId: q.thread.id, state: 'answered' })
    ).rejects.toMatchObject({ code: 'question_transition' })
    await expect(
      updateUc.run({ ...ana, threadId: q.thread.id, state: 'wont_fix' })
    ).rejects.toMatchObject({ code: 'question_transition' })
    await db.destroy()
  })

  it('open → resolved rejected (resolve implies answered); open → wont_fix allowed', async () => {
    const { db, threadUc, updateUc, taskId } = await setup()
    const q = await threadUc.run({ ...human, ...question(taskId) })
    await expect(
      updateUc.run({ ...ana, threadId: q.thread.id, state: 'resolved' })
    ).rejects.toMatchObject({ code: 'question_transition' })
    const closed = await updateUc.run({ ...ana, threadId: q.thread.id, state: 'wont_fix' })
    expect(closed).toMatchObject({ state: 'wont_fix' })
    await db.destroy()
  })

  it('reassign changes the assignee, notifies the new holder, and audits', async () => {
    const { db, threadUc, updateUc, taskId } = await setup()
    const q = await threadUc.run({ ...human, ...question(taskId) })
    const r = await updateUc.run({ ...human, threadId: q.thread.id, assignee_id: 'a_agent' })
    expect(r).toMatchObject({ assignee_id: 'a_agent' })
    const audit = await new SqliteAuditRepo(db).search({
      entity_type: 'thread',
      entity_id: q.thread.id,
      limit: 5,
    })
    expect(audit[0]).toMatchObject({
      action: 'question_reassigned',
      reason: 'question reassigned',
      before: { assignee_id: 'a_ana' },
      after: { assignee_id: 'a_agent' },
    })
    // D-r: the NEW assignee gets question_assigned
    expect(
      (await new SqliteInboxRepo(db).listForActor('a_agent', { unreadOnly: false, limit: 5 })).map(
        (i) => i.kind
      )
    ).toEqual(['question_assigned'])
    await db.destroy()
  })

  it('reassign-to-self writes no inbox entry (D-r); guard arms reject', async () => {
    const { db, threadUc, updateUc, taskId } = await setup()
    const q = await threadUc.run({ ...human, ...question(taskId) })
    // nils takes it over from ana: nils is the new assignee AND the actor → no notify
    const r = await updateUc.run({ ...human, threadId: q.thread.id, assignee_id: 'a_human' })
    expect(r).toMatchObject({ assignee_id: 'a_human' })
    expect(
      await new SqliteInboxRepo(db).listForActor('a_human', { unreadOnly: false, limit: 5 })
    ).toEqual([])
    // guard arms, one probe each: unknown thread / unknown assignee / note thread / bogus state
    await expect(
      updateUc.run({ ...human, threadId: 'th_ghost', state: 'resolved' })
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      updateUc.run({ ...human, threadId: q.thread.id, assignee_id: 'a_ghost' })
    ).rejects.toMatchObject({ code: 'not_found' })
    const n = await threadUc.run({ ...human, taskId, kind: 'note', body: 'a note' })
    await expect(
      updateUc.run({ ...human, threadId: n.thread.id, state: 'answered' })
    ).rejects.toMatchObject({ code: 'invalid_request' })
    // bogus state string: the route schema is the real edge guard; the use-case stays uniform
    await expect(
      updateUc.run({ ...human, threadId: q.thread.id, state: 'shipped' as never })
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await db.destroy()
  })

  it('no-op updates change nothing: same assignee + same state leave audit untouched', async () => {
    const { db, threadUc, updateUc, taskId } = await setup()
    const q = await threadUc.run({ ...human, ...question(taskId) })
    const noop = await updateUc.run({
      ...ana,
      threadId: q.thread.id,
      assignee_id: 'a_ana',
      state: 'open',
    })
    expect(noop).toMatchObject({ assignee_id: 'a_ana', state: 'open' })
    const audit = await new SqliteAuditRepo(db).search({
      entity_type: 'thread',
      entity_id: q.thread.id,
      limit: 5,
    })
    expect(audit.map((a) => a.action)).toEqual(['thread_created']) // creation audit stands alone
    await db.destroy()
  })
})
