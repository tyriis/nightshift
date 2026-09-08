import { describe, expect, it } from 'vitest'
import { CreateTask } from '#root/application/usecases/create-task'
import { CreateThread } from '#root/application/usecases/create-thread'
import { AnswerQuestion } from '#root/application/usecases/answer-question'
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
  // one shared thread-side id counter (create-thread.test setup note)
  const threadIds = seqIds()
  const threadUc = new CreateThread(uow, fixedClock(), threadIds)
  const answerUc = new AnswerQuestion(uow, fixedClock(), threadIds)
  const updateUc = new UpdateQuestion(uow, fixedClock(), threadIds)
  return { db, uow, threadUc, answerUc, updateUc, taskId: task.id }
}

const question = (taskId: string) => ({
  taskId,
  kind: 'question' as const,
  body: 'which database?',
  assignee_id: 'a_ana',
})

describe('AnswerQuestion (spec §6.5, D-n)', () => {
  it('human answer appends a message, links it and moves open → answered', async () => {
    const { db, threadUc, answerUc, taskId } = await setup()
    const q = await threadUc.run({ ...human, ...question(taskId) })
    const r = await answerUc.run({ ...ana, threadId: q.thread.id, body: 'sqlite, WAL' })
    expect(r.message).toMatchObject({ seq: 2, author_id: 'a_ana' })
    expect(r.thread).toMatchObject({ state: 'answered', answer_message_id: r.message.id })
    const audit = await new SqliteAuditRepo(db).search({
      entity_type: 'thread',
      entity_id: q.thread.id,
      limit: 5,
    })
    expect(audit[0]).toMatchObject({ action: 'question_answered', reason: 'question answered' })
    await db.destroy()
  })

  it('answering a note thread → invalid_request; unknown thread → not_found', async () => {
    const { db, threadUc, answerUc, taskId } = await setup()
    const n = await threadUc.run({ ...human, taskId, kind: 'note', body: 'a note' })
    await expect(answerUc.run({ ...ana, threadId: n.thread.id, body: 'x' })).rejects.toMatchObject({
      code: 'invalid_request',
    })
    await expect(answerUc.run({ ...ana, threadId: 'th_ghost', body: 'x' })).rejects.toMatchObject({
      code: 'not_found',
    })
    await db.destroy()
  })

  it('answering a non-open question delegates to the D-n table (answered and terminal reject)', async () => {
    const { db, threadUc, answerUc, updateUc, taskId } = await setup()
    const q = await threadUc.run({ ...human, ...question(taskId) })
    await answerUc.run({ ...ana, threadId: q.thread.id, body: 'sqlite' })
    // answered → answered is not in the table (only open → answered answers)
    await expect(
      answerUc.run({ ...ana, threadId: q.thread.id, body: 'again' })
    ).rejects.toMatchObject({ code: 'question_transition' })
    // terminal resolved → answering stays rejected forever
    await updateUc.run({ ...human, threadId: q.thread.id, state: 'resolved' })
    await expect(
      answerUc.run({ ...ana, threadId: q.thread.id, body: 'late' })
    ).rejects.toMatchObject({ code: 'question_transition' })
    await db.destroy()
  })

  it('answer body routes mentions — the answering author is never notified', async () => {
    const { db, threadUc, answerUc, taskId } = await setup()
    const q = await threadUc.run({ ...human, ...question(taskId) })
    await answerUc.run({ ...ana, threadId: q.thread.id, body: '@ana @nils sqlite, WAL' })
    const inbox = new SqliteInboxRepo(db)
    expect(
      (await inbox.listForActor('a_ana', { unreadOnly: false, limit: 10 })).map((i) => i.kind)
    ).toEqual(['question_assigned']) // self-mention skipped (D-q); creation notice stands
    expect(
      (await inbox.listForActor('a_human', { unreadOnly: false, limit: 10 })).map((i) => i.kind)
    ).toEqual(['mentioned']) // the answering author's own handle skipped, nils notified
    await db.destroy()
  })
})
