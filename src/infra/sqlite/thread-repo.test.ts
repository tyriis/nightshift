import { describe, expect, it } from 'vitest'
import { SqliteThreadRepo } from '#root/infra/sqlite/thread-repo'
import { freshDb, seedActor, seedTask } from '#root/testing/fixtures'
import type { ThreadDraft } from '#root/application/ports'

const note = (over: Partial<ThreadDraft> = {}): ThreadDraft => ({
  id: 'th_1',
  task_id: 't_1',
  kind: 'note',
  state: null,
  assignee_id: null,
  answer_message_id: null,
  created_by: 'a_human',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  ...over,
})

const question = (over: Partial<ThreadDraft> = {}): ThreadDraft =>
  note({
    id: 'th_q',
    kind: 'question',
    state: 'open',
    assignee_id: 'a_ag',
    ...over,
  })

const setup = async () => {
  const db = await freshDb()
  await seedActor(db, 'a_creator', 'human') // seedTask's FK target (created_by default)
  await seedActor(db, 'a_human', 'human', 'nils')
  await seedActor(db, 'a_ag', 'agent', 'hermes-1')
  await seedActor(db, 'a_h2', 'human', 'ana')
  await seedTask(db, 't_1')
  await seedTask(db, 't_2')
  return { db, repo: new SqliteThreadRepo(db) }
}

const msg = (id: string, threadId: string, body: string) => ({
  id,
  threadId,
  authorId: 'a_human',
  body,
  created_at: '2026-01-01T00:00:00.000Z',
})

describe('SqliteThreadRepo', () => {
  it('creates, finds, appends ordered messages, lists with messages', async () => {
    const { db, repo } = await setup()
    const th = await repo.create(note())
    expect(th.state).toBeNull()
    const m1 = await repo.appendMessage(msg('ms_1', 'th_1', 'first'))
    const m2 = await repo.appendMessage(msg('ms_2', 'th_1', 'second'))
    expect([m1.seq, m2.seq]).toEqual([1, 2])
    expect(await repo.find('th_1')).toMatchObject({ id: 'th_1', kind: 'note' })
    expect(await repo.find('th_x')).toBeNull()
    const listed = await repo.listForTask('t_1')
    expect(listed).toHaveLength(1)
    expect(listed[0]!.messages.map((m) => m.body)).toEqual(['first', 'second'])
    await db.destroy()
  })

  it('lists empty results: no threads at all, and threads without messages', async () => {
    const { db, repo } = await setup()
    expect(await repo.listForTask('t_2')).toEqual([]) // no threads arm
    await repo.create(note())
    const listed = await repo.listForTask('t_1')
    expect(listed).toHaveLength(1)
    expect(listed[0]!.messages).toEqual([]) // message-free thread still lists
    await db.destroy()
  })

  it('setQuestionFields patches state/assignee/answer atomically', async () => {
    const { db, repo } = await setup()
    await repo.create(question())
    await repo.appendMessage(msg('ms_q', 'th_q', 'which db?'))
    await repo.setQuestionFields(
      'th_q',
      { state: 'answered', answer_message_id: 'ms_q' },
      '2026-01-02T00:00:00.000Z'
    )
    const t = (await repo.find('th_q'))!
    expect(t).toMatchObject({ state: 'answered', answer_message_id: 'ms_q', assignee_id: 'a_ag' })
    await db.destroy()
  })

  it('openHumanAssigned: open+human=1; answered/agent/other-task excluded', async () => {
    const { db, repo } = await setup()
    await repo.create(question()) // t_1, open, a_ag is AGENT → not counted
    expect(await repo.openHumanAssigned('t_1')).toBe(0) // the agent arm, pinned (D-o)
    await repo.setQuestionFields('th_q', { assignee_id: 'a_h2' }, '2026-01-02T00:00:00.000Z')
    expect(await repo.openHumanAssigned('t_1')).toBe(1)
    await repo.setQuestionFields('th_q', { state: 'answered' }, '2026-01-03T00:00:00.000Z')
    expect(await repo.openHumanAssigned('t_1')).toBe(0)
    // human assignee so the t_2 positive actually exercises the human arm
    await repo.create(question({ id: 'th_q9', task_id: 't_2', assignee_id: 'a_h2' }))
    expect(await repo.openHumanAssigned('t_1')).toBe(0) // other task untouched
    expect(await repo.openHumanAssigned('t_2')).toBe(1)
    await db.destroy()
  })

  it('openQuestionsForTask carries first-message text and assignee handle', async () => {
    const { db, repo } = await setup()
    await repo.create(question())
    await repo.appendMessage(msg('ms_q', 'th_q', 'which db?'))
    await repo.appendMessage(msg('ms_q2', 'th_q', 'ping'))
    const rows = await repo.openQuestionsForTask('t_1')
    expect(rows).toEqual([
      { id: 'th_q', state: 'open', assignee_handle: 'hermes-1', question: 'which db?' },
    ])
    await db.destroy()
  })
})
