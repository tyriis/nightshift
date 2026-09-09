// src/adapters/mcp/tools/discussion.test.ts — sync = shipped form
// (#root imports, 'nils' handle, REST-seeded inbox via the mount.test.ts precedent; see Amendment)
import { describe, expect, it } from 'vitest'
import { DISCUSSION_TOOLS } from '#root/adapters/mcp/tools/discussion'
import { TASK_TOOLS } from '#root/adapters/mcp/tools/tasks'
import { actorContextFor, openInMemoryPair } from '#root/testing/mcp-client'
import { makeTestApp } from '#root/testing/test-app'

const ALL = [...TASK_TOOLS, ...DISCUSSION_TOOLS]

const withMcp = async (
  fn: (
    mcp: Awaited<ReturnType<typeof openInMemoryPair>>,
    t: Awaited<ReturnType<typeof makeTestApp>>
  ) => Promise<void>
) => {
  const t = await makeTestApp()
  try {
    const mcp = await openInMemoryPair(t.deps, await actorContextFor(t.deps, t.adminToken), ALL)
    try {
      await fn(mcp, t)
    } finally {
      await mcp.close()
    }
  } finally {
    await t.close()
  }
}
const result = <T>(r: { structuredContent?: unknown }) =>
  (r.structuredContent as { result: T }).result

describe('discussion + inbox tools (D-mm)', () => {
  it('note thread lands {thread, message}; list_threads nests messages; ghost-404 first', () =>
    withMcp(async (mcp) => {
      const ghost = await mcp.call('list_threads', { task_id: 'ts_ghost' })
      expect(ghost.structuredContent).toEqual({ code: 'not_found', status: 404 })
      const task = result<{ id: string }>(await mcp.call('create_task', { title: 'discuss' }))
      const made = result<{ thread: { id: string }; message: { body: string } }>(
        await mcp.call('create_thread', { task_id: task.id, kind: 'note', body: 'hello' })
      )
      expect(made.message.body).toBe('hello')
      const listed = result<{ thread: { id: string }; messages: unknown[] }[]>(
        await mcp.call('list_threads', { task_id: task.id })
      )
      expect(listed).toHaveLength(1)
      expect(listed[0]!.thread.id).toBe(made.thread.id)
      expect(listed[0]!.messages).toHaveLength(1)
    }))

  it('question lifecycle: assign → answer {message, thread} order → resolve; invalid transition pins question_transition', () =>
    withMcp(async (mcp, t) => {
      const task = result<{ id: string }>(await mcp.call('create_task', { title: 'gate' }))
      const q = result<{ thread: { id: string; state: string }; message: { id: string } }>(
        await mcp.call('create_thread', {
          task_id: task.id,
          kind: 'question',
          body: 'which port?',
          assignee_handle: 'nils',
        })
      )
      expect(q.thread.state).toBe('open')
      const answered = result<{ message: { id: string }; thread: { state: string } }>(
        await mcp.call('answer_question', { thread_id: q.thread.id, body: '8080' })
      )
      expect(answered.thread.state).toBe('answered')
      const invalid = await mcp.call('update_question', { thread_id: q.thread.id, state: 'open' })
      expect(invalid.isError).toBe(true)
      expect(invalid.structuredContent).toMatchObject({ code: 'question_transition', status: 409 })
      const resolved = result<{ state: string }>(
        await mcp.call('update_question', { thread_id: q.thread.id, state: 'resolved' })
      )
      expect(resolved.state).toBe('resolved')
      // reassign arm (update-question.ts:36): the tool's handle→id resolver must be
      // PROVEN on the PATCH path too, not just create — the D-n arm is independent,
      // so a resolved thread can be reassigned without moving state.
      const lurker = await t.app.inject({
        method: 'POST',
        url: '/admin/actors',
        headers: { authorization: `Bearer ${t.adminToken}` },
        payload: { kind: 'agent', handle: 'a_lurker', display_name: 'Lurker' },
      })
      expect(lurker.statusCode).toBe(201)
      const reassigned = result<{ assignee_id: string }>(
        await mcp.call('update_question', { thread_id: q.thread.id, assignee_handle: 'a_lurker' })
      )
      expect(reassigned.assignee_id).toBe(lurker.json().id)
    }))

  it('add_message appends, mark_inbox_read is {result:null} + unread_only view flips, unknown assignee matches the REST twin', () =>
    withMcp(async (mcp, t) => {
      const task = result<{ id: string }>(await mcp.call('create_task', { title: 'inbox' }))
      // D-r self-notify trap (create-thread.ts:111): a question nils ASKS nils books
      // NO inbox row, so the inbox-arming seed is POSTed by a throwaway AGENT
      // (mount.test.ts precedent) — the nils harness pair then READS that inbox.
      const seeder = await t.app.inject({
        method: 'POST',
        url: '/admin/actors',
        headers: { authorization: `Bearer ${t.adminToken}` },
        payload: { kind: 'agent', handle: 'a_seed', display_name: 'Seed' },
      })
      expect(seeder.statusCode).toBe(201)
      const seederTok = await t.app.inject({
        method: 'POST',
        url: `/admin/actors/${seeder.json().id}/tokens`,
        headers: { authorization: `Bearer ${t.adminToken}` },
        payload: { label: 'seed' },
      })
      expect(seederTok.statusCode).toBe(201)
      const seeded = await t.app.inject({
        method: 'POST',
        url: `/tasks/${task.id}/threads`,
        headers: { authorization: `Bearer ${seederTok.json().raw_token}` },
        payload: { kind: 'question', body: 'ping?', assignee_handle: 'nils' },
      })
      expect(seeded.statusCode).toBe(201)
      const msg = result<{ seq: number }>(
        await mcp.call('add_message', { thread_id: seeded.json().thread.id, body: 'also' })
      )
      expect(msg.seq).toBe(2) // D-y per-thread seq
      const inbox = result<{ id: string; read: boolean }[]>(
        await mcp.call('get_inbox', { unread_only: true })
      )
      expect(inbox).toHaveLength(1) // the REST seed is non-vacuous (D-r notify landed)
      expect(
        (await mcp.call('mark_inbox_read', { item_id: inbox[0]!.id })).structuredContent
      ).toEqual({ result: null })
      expect((await mcp.call('get_inbox', { unread_only: true })).structuredContent).toEqual({
        result: [],
      })
      // unknown handle: MCP ⇄ REST same code+status out of the SHARED resolver (Task 2)
      const mcpErr = await mcp.call('create_thread', {
        task_id: task.id,
        kind: 'question',
        body: 'x',
        assignee_handle: 'a_ghost',
      })
      const restErr = await t.app.inject({
        method: 'POST',
        url: `/tasks/${task.id}/threads`,
        headers: { authorization: `Bearer ${t.adminToken}` },
        payload: { kind: 'question', body: 'x', assignee_handle: 'a_ghost' },
      })
      expect(mcpErr.structuredContent).toMatchObject({
        code: restErr.json().code,
        status: restErr.statusCode,
      })
    }))
})
