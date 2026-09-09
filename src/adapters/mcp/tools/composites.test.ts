import { describe, expect, it } from 'vitest'
import { COMPOSITE_TOOLS, postUpdate } from '#root/adapters/mcp/tools/composites'
import { DISCUSSION_TOOLS } from '#root/adapters/mcp/tools/discussion'
import { REFERENCE_TOOLS } from '#root/adapters/mcp/tools/references'
import { TASK_TOOLS } from '#root/adapters/mcp/tools/tasks'
import { actorContextFor, openInMemoryPair } from '#root/testing/mcp-client'
import { makeTestApp } from '#root/testing/test-app'

const ALL = [...TASK_TOOLS, ...DISCUSSION_TOOLS, ...REFERENCE_TOOLS, ...COMPOSITE_TOOLS]
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

describe('spec §7.1 composites (D-nn)', () => {
  it('claim_next: empty is data, then claims the first ready task atomically', () =>
    withMcp(async (mcp) => {
      expect(result(await mcp.call('claim_next'))).toEqual({
        claimed: false,
        task: null,
        claim: null,
      })
      await mcp.call('create_task', { title: 'work', status: 'todo' }) // ready leaves seeded explicitly (create defaults to backlog)
      const got = result<{
        claimed: boolean
        task: { status: string }
        claim: { lease_token: string }
      }>(await mcp.call('claim_next'))
      expect(got.claimed).toBe(true)
      expect(got.task.status).toBe('in_progress') // D-a: claim flips todo→in_progress
      expect(got.claim.lease_token).toMatch(/:/) // "<task_id>:<generation>" (D-b)
    }))

  it('post_update: comment-only creates a note thread; with lease+status the full loop lands', () =>
    withMcp(async (mcp) => {
      const task = result<{ id: string }>(
        await mcp.call('create_task', { title: 'loop', status: 'todo' })
      )
      const note = result<{ thread: { id: string; kind: string }; message: { body: string } }>(
        await mcp.call('post_update', { task_id: task.id, body: 'progress: half' })
      )
      expect(note.thread.kind).toBe('note')
      const claim = result<{ lease_token: string }>(
        await mcp.call('claim_task', { task_id: task.id })
      )
      const full = result<{ task: { status: string } }>(
        await mcp.call('post_update', {
          task_id: task.id,
          thread_id: note.thread.id,
          body: 'ready for review',
          lease_token: claim.lease_token,
          status: 'in_review',
          reason: 'work complete',
        })
      )
      expect(full.task.status).toBe('in_review')
    }))

  it('post_update: missing reason with status is invalid_request (no synthesized audit reason, D-nn)', () =>
    withMcp(async (mcp, t) => {
      const task = result<{ id: string }>(await mcp.call('create_task', { title: 'why' }))
      const err = await mcp.call('post_update', {
        task_id: task.id,
        body: 'x',
        status: 'in_progress',
      })
      expect(err.isError).toBe(true)
      // D-jj: the FLAT envelope mirrors no prose (message is transport, not data), so the
      // envelope pins code+status and the plan-pinned machine STRING is pinned at its
      // throw site — the DomainError message, never reworded.
      expect(err.structuredContent).toEqual({ code: 'invalid_request', status: 400 })
      const ctx = await actorContextFor(t.deps, t.adminToken)
      await expect(
        postUpdate.run(t.deps, ctx, {
          task_id: task.id,
          body: 'y',
          status: 'in_progress',
        } as never)
      ).rejects.toThrow(/status in post_update requires reason/)
    }))

  it('post_update is NOT transactional: a stale lease propagates AFTER the comment stayed booked (D-nn)', () =>
    withMcp(async (mcp) => {
      const task = result<{ id: string }>(await mcp.call('create_task', { title: 'partial' }))
      const err = await mcp.call('post_update', {
        task_id: task.id,
        body: 'booked',
        lease_token: 'bogus:0',
      })
      expect(err.structuredContent).toMatchObject({ code: 'stale_lease', status: 412 })
      const threads = result<{ messages: unknown[] }[]>(
        await mcp.call('list_threads', { task_id: task.id })
      )
      expect(threads[0]!.messages).toHaveLength(1) // the comment is in the board — no rollback fiction
    }))

  it('ask_question resolves the handle via the shared resolver and opens the gate question', () =>
    withMcp(async (mcp, t) => {
      const task = result<{ id: string }>(await mcp.call('create_task', { title: 'ask' }))
      // the seeded human's HANDLE is 'nils' ('a_nils' is its id); D-r — a question nils
      // asks nils books NO inbox row, and nothing here asserts one.
      const q = result<{ thread: { kind: string; state: string }; message: { body: string } }>(
        await mcp.call('ask_question', {
          task_id: task.id,
          text: 'which port?',
          assignee: 'nils',
        })
      )
      expect(q.thread).toMatchObject({ kind: 'question', state: 'open' })
      const ghost = await mcp.call('ask_question', {
        task_id: task.id,
        text: 'x',
        assignee: 'a_ghost',
      })
      expect(ghost.isError).toBe(true)
      expect(ghost.structuredContent).toMatchObject({ code: 'not_found', status: 404 })
      // REST twin: the SAME shared resolver, the SAME machine code on both sides (D-nn, no grammar fork)
      const rest = await t.app.inject({
        method: 'POST',
        url: `/tasks/${task.id}/threads`,
        headers: { authorization: `Bearer ${t.adminToken}` },
        payload: { kind: 'question', body: 'x', assignee_handle: 'a_ghost' },
      })
      expect(rest.statusCode).toBe(404)
      expect(rest.json().code).toBe((ghost.structuredContent as { code: string }).code)
    }))

  it('split_task mirrors POST /tasks/{id}/split verbatim (parent claim released, pinned reason rides)', () =>
    withMcp(async (mcp) => {
      const parent = result<{ id: string }>(
        await mcp.call('create_task', { title: 'parent', status: 'todo' })
      )
      await mcp.call('claim_task', { task_id: parent.id })
      const split = result<{
        parent: { task: { claim_token_id: string | null } } // un-DTO'd SplitTaskResult: parent is the TaskWithCounts wrapper
        created: { status: string }[]
      }>(
        await mcp.call('split_task', {
          task_id: parent.id,
          children: [{ title: 'child one' }, { title: 'child two', status: 'backlog' }],
        })
      )
      expect(split.parent.task.claim_token_id).toBeNull() // D-d release rides
      expect(split.created.map((c) => c.status)).toEqual(['todo', 'backlog']) // Dev-2 defaults
      const audit = result<{ reason: string }[]>(
        await mcp.call('search_audit', { entity_type: 'task', entity_id: parent.id })
      )
      expect(audit.some((a) => a.reason === 'claim released by split')).toBe(true) // grep-pinned string, forward-pinned (D-d)
    }))
})
