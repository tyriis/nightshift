import { describe, expect, it } from 'vitest'
import { TASK_TOOLS } from '#root/adapters/mcp/tools/tasks'
import { actorContextFor, openInMemoryPair } from '#root/testing/mcp-client'
import { makeTestApp } from '#root/testing/test-app'

const withMcp = async (
  fn: (
    mcp: Awaited<ReturnType<typeof openInMemoryPair>>,
    t: Awaited<ReturnType<typeof makeTestApp>>
  ) => Promise<void>
) => {
  const t = await makeTestApp()
  try {
    const ctx = await actorContextFor(t.deps, t.adminToken)
    const mcp = await openInMemoryPair(t.deps, ctx, TASK_TOOLS)
    try {
      await fn(mcp, t)
    } finally {
      await mcp.close()
    }
  } finally {
    await t.close()
  }
}

const jsonOf = (r: { content: unknown }) => JSON.parse((r.content as { text: string }[])[0].text) // cast lands on `content`, not on `unknown`

describe('task-domain tools (D-mm)', () => {
  it('create → get → list round-trip with the re-fetched TaskDto shape', () =>
    withMcp(async (mcp) => {
      const created = await mcp.call('create_task', {
        title: 'alpha',
        labels: ['ops'],
        status: 'todo',
      })
      const task = (created.structuredContent as { result: { id: string } }).result
      expect(task).toMatchObject({
        title: 'alpha',
        status: 'todo',
        child_count: 0,
        unmet_blockers: 0,
      })
      const got = await mcp.call('get_task', { task_id: task.id })
      expect(got.structuredContent).toEqual(created.structuredContent) // same serializer, twice
      const listed = await mcp.call('list_tasks')
      expect((listed.structuredContent as { result: unknown[] }).result).toHaveLength(1)
      const ghost = await mcp.call('get_task', { task_id: 'ts_ghost' })
      expect(ghost.isError).toBe(true)
      expect(ghost.structuredContent).toEqual({ code: 'not_found', status: 404 })
      expect(jsonOf(ghost)).toEqual(ghost.structuredContent) // text ⇄ structuredContent mirror (D-jj)
    }))

  it('update_task discards the uc return and re-fetches (counts ride)', () =>
    withMcp(async (mcp) => {
      const parent = await mcp.call('create_task', { title: 'p' })
      const pid = (parent.structuredContent as { result: { id: string } }).result.id
      await mcp.call('create_task', { title: 'c', parent_id: pid })
      const patched = await mcp.call('update_task', { task_id: pid, patch: { description: 'why' } })
      const t2 = (patched.structuredContent as { result: { child_count: number } }).result
      expect(t2.child_count).toBe(1) // a bare UpdateTask return has NO counts — proof of re-fetch
    }))

  it('claim twice → second lands the FLAT already_claimed envelope (holder details ride)', () =>
    withMcp(async (mcp) => {
      const task = await mcp.call('create_task', { title: 'claimed?', status: 'todo' })
      const id = (task.structuredContent as { result: { id: string } }).result.id
      const first = await mcp.call('claim_task', { task_id: id })
      expect(first.structuredContent).toMatchObject({
        result: { lease_token: expect.stringMatching(/:/), generation: expect.any(Number) },
      })
      const second = await mcp.call('claim_task', { task_id: id })
      expect(second.isError).toBe(true)
      // claim-task.ts details are EXACTLY {holder_handle, holder_display_name} — the
      // flat envelope is the byte-parity twin of REST's problem body minus the prose.
      expect(second.structuredContent).toEqual({
        code: 'already_claimed',
        status: 409,
        holder_handle: 'nils',
        holder_display_name: 'Nils',
      })
    }))

  it('bogus lease → 412 stale_lease with FLAT claimed: true (heartbeat and status)', () =>
    withMcp(async (mcp) => {
      const task = await mcp.call('create_task', { title: 'lease', status: 'todo' })
      const id = (task.structuredContent as { result: { id: string } }).result.id
      await mcp.call('claim_task', { task_id: id }) // claimed:true arms need the live claim
      const hb = await mcp.call('heartbeat_task', { task_id: id, lease_token: 'bogus:0' })
      expect(hb.structuredContent).toEqual({ code: 'stale_lease', status: 412, claimed: true })
      const st = await mcp.call('update_task_status', {
        task_id: id,
        to: 'in_progress',
        reason: 'go',
        lease_token: 'bogus:0',
      })
      expect(st.structuredContent).toEqual({ code: 'stale_lease', status: 412, claimed: true })
    }))

  it('status happy path re-fetches TaskDto; blocks round-trip as {result:null} (204 analog)', () =>
    withMcp(async (mcp) => {
      const a = await mcp.call('create_task', { title: 'a', status: 'todo' })
      const b = await mcp.call('create_task', { title: 'b', status: 'todo' })
      const [ida, idb] = [a, b].map(
        (r) => (r.structuredContent as { result: { id: string } }).result.id
      )
      const moved = await mcp.call('update_task_status', {
        task_id: ida,
        to: 'in_progress',
        reason: 'started',
      })
      expect(moved.structuredContent).toMatchObject({ result: { status: 'in_progress' } })
      const blocked = await mcp.call('add_block', { task_id: ida, blocker_id: idb })
      expect(blocked.structuredContent).toEqual({ result: null })
      const ready = await mcp.call('list_ready_tasks')
      expect((ready.structuredContent as { result: unknown[] }).result).toHaveLength(1) // only b
      const [ctxBundle] = [
        (await mcp.call('get_task_context', { task_id: ida })).structuredContent as {
          result: { blockers: unknown[]; task: { id: string } }
        },
      ]
      expect(ctxBundle.result.task.id).toBe(ida)
      expect(ctxBundle.result.blockers).toHaveLength(1) // un-DTO'd bundle (D-mm)
      expect(
        (await mcp.call('remove_block', { task_id: ida, blocker_id: idb })).structuredContent
      ).toEqual({ result: null })
    }))

  it('release returns the re-fetched TaskDto (claim fields cleared)', () =>
    withMcp(async (mcp) => {
      const task = await mcp.call('create_task', { title: 'release me', status: 'todo' })
      const id = (task.structuredContent as { result: { id: string } }).result.id
      await mcp.call('claim_task', { task_id: id })
      const rel = await mcp.call('release_task', { task_id: id })
      expect(rel.structuredContent).toMatchObject({
        result: { claim_token_id: null, status: 'in_progress' },
      })
    }))
})
