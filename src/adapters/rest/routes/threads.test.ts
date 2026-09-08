import { describe, expect, it } from 'vitest'
import { makeTestApp, type TestApp } from '#root/testing/test-app'

const bearer = (t: TestApp): Record<string, string> => ({ authorization: `Bearer ${t.adminToken}` })

const createTask = async (t: TestApp, title: string): Promise<string> =>
  (
    await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: bearer(t),
      payload: { title, status: 'todo' },
    })
  ).json().id as string

const createActor = async (t: TestApp, kind: 'human' | 'agent', handle: string): Promise<string> =>
  (
    await t.app.inject({
      method: 'POST',
      url: '/admin/actors',
      headers: bearer(t),
      payload: { kind, handle, display_name: `D ${handle}` },
    })
  ).json().id as string

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('thread routes (spec §6.5, §7.2)', () => {
  it('POST /tasks/:id/threads creates a note with first message (and routes mentions)', async () => {
    const t = await makeTestApp()
    const anaId = await createActor(t, 'human', 'ana')
    const taskId = await createTask(t, 'threadable')
    const res = await t.app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/threads`,
      headers: bearer(t),
      payload: { kind: 'note', body: '@ana heads up' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({
      thread: { kind: 'note', state: null, task_id: taskId },
      message: { seq: 1, body: '@ana heads up' },
    })
    expect(res.json().thread.id).toMatch(/^th_[a-z0-9]{16}$/) // RandomIdGen family (D-z)
    const anaInbox = await t.deps.inboxRoot.listForActor(anaId, { unreadOnly: false, limit: 5 })
    expect(anaInbox.map((i) => i.kind)).toEqual(['mentioned'])
    await t.close()
  })

  it('question requires an assignee and lands open; unknown handle 404', async () => {
    const t = await makeTestApp()
    await createActor(t, 'human', 'ana')
    const taskId = await createTask(t, 'q host')
    const missing = await t.app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/threads`,
      headers: bearer(t),
      payload: { kind: 'question', body: 'which?' },
    })
    expect(missing.statusCode).toBe(400)
    expect(missing.json().code).toBe('invalid_request')
    const ghost = await t.app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/threads`,
      headers: bearer(t),
      payload: { kind: 'question', body: 'which?', assignee_handle: 'ghost' },
    })
    expect(ghost.statusCode).toBe(404)
    expect(ghost.json().code).toBe('not_found')
    const ok = await t.app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/threads`,
      headers: bearer(t),
      payload: { kind: 'question', body: 'which?', assignee_handle: 'ana' },
    })
    expect(ok.statusCode).toBe(201)
    expect(ok.json().thread).toMatchObject({ kind: 'question', state: 'open' })
    await t.close()
  })

  it('GET /tasks/:id/threads lists oldest-first with ordered messages', async () => {
    const t = await makeTestApp()
    const taskId = await createTask(t, 'board')
    const post = async (payload: Record<string, unknown>) =>
      (
        await t.app.inject({
          method: 'POST',
          url: `/tasks/${taskId}/threads`,
          headers: bearer(t),
          payload,
        })
      ).json()
    const first = await post({ kind: 'note', body: 'first' })
    await sleep(2) // SystemClock is millisecond-resolution; a tie would be id-ordered
    const second = await post({ kind: 'note', body: 'second' })
    await t.app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/threads/${first.thread.id}/messages`,
      headers: bearer(t),
      payload: { body: 'reply one' },
    })
    await t.app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/threads/${first.thread.id}/messages`,
      headers: bearer(t),
      payload: { body: 'reply two' },
    })
    const list = (
      await t.app.inject({ method: 'GET', url: `/tasks/${taskId}/threads`, headers: bearer(t) })
    ).json()
    expect(list.map((x: { thread: { id: string } }) => x.thread.id)).toEqual([
      first.thread.id,
      second.thread.id,
    ])
    expect(list[0].messages.map((m: { seq: number; body: string }) => [m.seq, m.body])).toEqual([
      [1, 'first'],
      [2, 'reply one'],
      [3, 'reply two'],
    ])
    // a typo'd task id must not masquerade as "no discussion yet" — sibling GET /tasks/:id 404s
    const ghostList = await t.app.inject({
      method: 'GET',
      url: '/tasks/t_ghost/threads',
      headers: bearer(t),
    })
    expect(ghostList.statusCode).toBe(404)
    expect(ghostList.json().code).toBe('not_found')
    await t.close()
  })

  it('POST messages appends seq 2; unknown thread 404', async () => {
    const t = await makeTestApp()
    const taskId = await createTask(t, 'reply host')
    const thread = (
      await t.app.inject({
        method: 'POST',
        url: `/tasks/${taskId}/threads`,
        headers: bearer(t),
        payload: { kind: 'note', body: 'open post' },
      })
    ).json()
    const replyRes = await t.app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/threads/${thread.thread.id}/messages`,
      headers: bearer(t),
      payload: { body: 'follow-up' },
    })
    expect(replyRes.statusCode).toBe(201)
    expect(replyRes.json()).toMatchObject({ seq: 2, body: 'follow-up' })
    const ghost = await t.app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/threads/th_nope/messages`,
      headers: bearer(t),
      payload: { body: 'x' },
    })
    expect(ghost.statusCode).toBe(404)
    await t.close()
  })

  it('POST answer links + answers; double answer 409 question_transition', async () => {
    const t = await makeTestApp()
    await createActor(t, 'human', 'ana')
    const taskId = await createTask(t, 'q answer')
    const thread = (
      await t.app.inject({
        method: 'POST',
        url: `/tasks/${taskId}/threads`,
        headers: bearer(t),
        payload: { kind: 'question', body: 'which db?', assignee_handle: 'ana' },
      })
    ).json()
    const ans = await t.app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/threads/${thread.thread.id}/answer`,
      headers: bearer(t),
      payload: { body: 'sqlite, WAL' },
    })
    expect(ans.statusCode).toBe(200)
    expect(ans.json()).toMatchObject({
      message: { seq: 2 },
      thread: { state: 'answered', answer_message_id: ans.json().message.id },
    })
    const again = await t.app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/threads/${thread.thread.id}/answer`,
      headers: bearer(t),
      payload: { body: 'again' },
    })
    expect(again.statusCode).toBe(409)
    // the T6-unified details shape stays visible at the REST boundary agents meet —
    // problem.ts spreads DomainError details TOP-LEVEL (stale_lease precedent)
    expect(again.json()).toMatchObject({
      code: 'question_transition',
      from: 'answered',
      to: 'answered',
    })
    await t.close()
  })

  it('PATCH resolves after answer; open → resolved is 409 question_transition', async () => {
    const t = await makeTestApp()
    await createActor(t, 'human', 'ana')
    const taskId = await createTask(t, 'q close')
    const thread = (
      await t.app.inject({
        method: 'POST',
        url: `/tasks/${taskId}/threads`,
        headers: bearer(t),
        payload: { kind: 'question', body: 'q?', assignee_handle: 'ana' },
      })
    ).json()
    const premature = await t.app.inject({
      method: 'PATCH',
      url: `/tasks/${taskId}/threads/${thread.thread.id}`,
      headers: bearer(t),
      payload: { state: 'resolved' },
    })
    expect(premature.statusCode).toBe(409)
    expect(premature.json().code).toBe('question_transition')
    await t.app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/threads/${thread.thread.id}/answer`,
      headers: bearer(t),
      payload: { body: 'a' },
    })
    const resolved = await t.app.inject({
      method: 'PATCH',
      url: `/tasks/${taskId}/threads/${thread.thread.id}`,
      headers: bearer(t),
      payload: { state: 'resolved' },
    })
    expect(resolved.statusCode).toBe(200)
    expect(resolved.json()).toMatchObject({ state: 'resolved' })
    await t.close()
  })

  it('PATCH assignee_handle re-assigns and notifies the new holder (D-r)', async () => {
    const t = await makeTestApp()
    await createActor(t, 'human', 'ana')
    const hermesId = await createActor(t, 'agent', 'hermes-1')
    const taskId = await createTask(t, 'q move')
    const thread = (
      await t.app.inject({
        method: 'POST',
        url: `/tasks/${taskId}/threads`,
        headers: bearer(t),
        payload: { kind: 'question', body: 'q?', assignee_handle: 'ana' },
      })
    ).json()
    const patch = await t.app.inject({
      method: 'PATCH',
      url: `/tasks/${taskId}/threads/${thread.thread.id}`,
      headers: bearer(t),
      payload: { assignee_handle: 'hermes-1' },
    })
    expect(patch.statusCode).toBe(200)
    expect(patch.json()).toMatchObject({ assignee_id: hermesId })
    const moved = await t.deps.inboxRoot.listForActor(hermesId, { unreadOnly: false, limit: 5 })
    expect(moved.map((i) => i.kind)).toEqual(['question_assigned'])
    await t.close()
  })

  it('threads_on_parent on a split parent; ?meta_note=true lets the human through (D-p)', async () => {
    const t = await makeTestApp()
    const parentId = await createTask(t, 'parent')
    await t.app.inject({
      method: 'POST',
      url: `/tasks/${parentId}/split`,
      headers: bearer(t),
      payload: { children: [{ title: 'kid', status: 'todo' }] },
    })
    const denied = await t.app.inject({
      method: 'POST',
      url: `/tasks/${parentId}/threads`,
      headers: bearer(t),
      payload: { kind: 'note', body: 'x' },
    })
    expect(denied.statusCode).toBe(409)
    expect(denied.json().code).toBe('threads_on_parent')
    const meta = await t.app.inject({
      method: 'POST',
      url: `/tasks/${parentId}/threads?meta_note=true`,
      headers: bearer(t),
      payload: { kind: 'note', body: 'decision: re-split' },
    })
    expect(meta.statusCode).toBe(201) // admin token belongs to human nils
    await t.close()
  })

  it('PATCH on a note thread is 400; unknown body keys are tolerated like the shipped surface', async () => {
    const t = await makeTestApp()
    const taskId = await createTask(t, 'strict')
    const thread = (
      await t.app.inject({
        method: 'POST',
        url: `/tasks/${taskId}/threads`,
        headers: bearer(t),
        payload: { kind: 'note', body: 'n' },
      })
    ).json()
    const patchNote = await t.app.inject({
      method: 'PATCH',
      url: `/tasks/${taskId}/threads/${thread.thread.id}`,
      headers: bearer(t),
      payload: { state: 'answered' },
    })
    expect(patchNote.statusCode).toBe(400)
    expect(patchNote.json().code).toBe('invalid_request')
    // fastify 5.12.3's default schema compiler strips extra keys silently —
    // the shipped POST /tasks behaves identically (extra key → 201, probe-verified)
    const sneaky = await t.app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/threads`,
      headers: bearer(t),
      payload: { kind: 'note', body: 'x', sneaky: true },
    })
    expect(sneaky.statusCode).toBe(201)
    await t.close()
  })
})
