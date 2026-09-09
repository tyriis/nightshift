// reference tools (links/labels/attachments/events/audit) — the REST twins transcribed (D-mm)
// — sync = shipped form (see Task 7 Amendment: #root imports, 413 pinned at the config
// floor, ghost/content-list + lost-blob arms for the coverage duty)
import { describe, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DISCUSSION_TOOLS } from '#root/adapters/mcp/tools/discussion'
import { REFERENCE_TOOLS } from '#root/adapters/mcp/tools/references'
import { TASK_TOOLS } from '#root/adapters/mcp/tools/tasks'
import { DiskFileStore } from '#root/infra/files/disk-file-store'
import { actorContextFor, openInMemoryPair } from '#root/testing/mcp-client'
import { makeTestApp } from '#root/testing/test-app'

const ALL = [...TASK_TOOLS, ...DISCUSSION_TOOLS, ...REFERENCE_TOOLS]
const withMcp = async (
  fn: (
    mcp: Awaited<ReturnType<typeof openInMemoryPair>>,
    t: Awaited<ReturnType<typeof makeTestApp>>
  ) => Promise<void>,
  overrides: NodeJS.ProcessEnv = {}
) => {
  const t = await makeTestApp(overrides)
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

describe('reference tools (D-mm)', () => {
  it('links: insert-or-get always 201-class identical rows; ghost-404; remove → {result:null}', () =>
    withMcp(async (mcp) => {
      const task = result<{ id: string }>(await mcp.call('create_task', { title: 'refs' }))
      const ghost = await mcp.call('list_links', { task_id: 'ts_ghost' })
      expect(ghost.structuredContent).toEqual({ code: 'not_found', status: 404 })
      const first = result<{ id: string; url: string }>(
        await mcp.call('add_link', { task_id: task.id, kind: 'pr', url: 'https://example.test/1' })
      )
      const again = result<{ id: string }>(
        await mcp.call('add_link', { task_id: task.id, kind: 'pr', url: 'https://example.test/1' })
      )
      expect(again.id).toBe(first.id) // D-t insert-or-get
      expect(result<unknown[]>(await mcp.call('list_links', { task_id: task.id }))).toHaveLength(1)
      expect(
        (await mcp.call('remove_link', { task_id: task.id, link_id: first.id })).structuredContent
      ).toEqual({ result: null }) // 204 analog
      expect(result<unknown[]>(await mcp.call('list_links', { task_id: task.id }))).toHaveLength(0)
    }))

  it('labels: create/list/attach/detach', () =>
    withMcp(async (mcp) => {
      const task = result<{ id: string }>(await mcp.call('create_task', { title: 'lab' }))
      const label = result<{ id: string; name: string }>(
        await mcp.call('create_label', { name: 'ops', color: '#fff' })
      )
      expect(
        result<unknown[]>(await mcp.call('list_labels')).map((l) => (l as { name: string }).name)
      ).toEqual(['ops'])
      expect(
        (await mcp.call('attach_label', { task_id: task.id, label_id: label.id })).structuredContent
      ).toEqual({ result: null })
      expect(
        (await mcp.call('detach_label', { task_id: task.id, label_id: label.id })).structuredContent
      ).toEqual({ result: null })
    }))

  it('attachments: upload exposes sha256 (D-s); content serves the UNSAFE_INLINE downgrade through the shared helpers', () =>
    withMcp(async (mcp) => {
      const task = result<{ id: string }>(await mcp.call('create_task', { title: 'files' }))
      const png = result<{ id: string; sha256: string }>(
        await mcp.call('upload_attachment', {
          task_id: task.id,
          filename: 'p.png',
          content_type: 'image/png',
          content_base64: Buffer.from('pretend-png').toString('base64'),
        })
      )
      expect(png.sha256).toMatch(/^[0-9a-f]{64}$/)
      const inline = result<{
        content_type: string
        content_disposition: string
        bytes_base64: string
      }>(await mcp.call('get_attachment_content', { attachment_id: png.id }))
      expect(inline.content_type).toBe('image/png')
      expect(inline.content_disposition).toBe('inline; filename="p.png"')
      expect(Buffer.from(inline.bytes_base64, 'base64').toString()).toBe('pretend-png')
      const svg = result<{ id: string }>(
        await mcp.call('upload_attachment', {
          task_id: task.id,
          filename: 's"1.svg',
          content_type: 'image/svg+xml',
          content_base64: Buffer.from('<svg/>').toString('base64'),
        })
      )
      const down = result<{
        content_type: string
        content_disposition: string
        x_content_type_options: string
      }>(await mcp.call('get_attachment_content', { attachment_id: svg.id }))
      expect(down.content_type).toBe('application/octet-stream')
      expect(down.content_disposition).toBe('attachment; filename="s_1.svg"') // shared safeFilename (Task 2)
      expect(down.x_content_type_options).toBe('nosniff')
      const listed = result<{ id: string; sha256: string }[]>(
        await mcp.call('list_attachments', { task_id: task.id })
      )
      // membership + D-s exposure, not strict order: created_at can tie in-ms and the
      // repo's tiebreak is the random id (attachment-repo.ts:42-43) — order is the repo's
      // own contract, not this tool's; REST never pins a multi-row list order either
      expect(listed.map((a) => a.id).sort()).toEqual([png.id, svg.id].sort())
      expect(listed.every((a) => /^[0-9a-f]{64}$/.test(a.sha256))).toBe(true) // sha256 exposed (D-s)
      expect(
        (await mcp.call('list_attachments', { task_id: 'ts_ghost' })).structuredContent
      ).toEqual({ code: 'not_found', status: 404 }) // ghost-404, never an empty list
    }))

  it('attachment content: ghost-404, and a lost blob 404s the second verbatim arm', () =>
    withMcp(async (mcp, t) => {
      expect(
        (await mcp.call('get_attachment_content', { attachment_id: 'at_ghost' })).structuredContent
      ).toEqual({ code: 'not_found', status: 404 })
      const task = result<{ id: string }>(await mcp.call('create_task', { title: 'orphan' }))
      const doomed = result<{ id: string; sha256: string }>(
        await mcp.call('upload_attachment', {
          task_id: task.id,
          filename: 'o.png',
          content_type: 'image/png',
          content_base64: Buffer.from('doomed').toString('base64'),
        })
      )
      const store = t.deps.files as DiskFileStore
      await rm(join(store.dir, doomed.sha256.slice(0, 2), doomed.sha256)) // simulate a corrupted store
      expect(
        (await mcp.call('get_attachment_content', { attachment_id: doomed.id })).structuredContent
      ).toEqual({ code: 'not_found', status: 404 }) // 'stored blob is missing' — code-side, prose never rides (D-jj)
    }))

  it('oversize upload → payload_too_large from the shared adapter vocabulary (D-jj)', () =>
    withMcp(
      async (mcp) => {
        const task = result<{ id: string }>(await mcp.call('create_task', { title: 'big' }))
        const big = await mcp.call('upload_attachment', {
          task_id: task.id,
          filename: 'b.bin',
          content_type: 'application/octet-stream',
          content_base64: Buffer.alloc(2048, 7).toString('base64'),
        })
        expect(big.structuredContent).toEqual({ code: 'payload_too_large', status: 413 })
      },
      { NS_MAX_UPLOAD_BYTES: '1024' } // the config floor (min 1024); mirrors the REST 413 test's cap
    ))

  it('events carry cursor (AuditRow minus payloads); audit keeps before/after (D-aa)', () =>
    withMcp(async (mcp) => {
      const task = result<{ id: string }>(await mcp.call('create_task', { title: 'feed' }))
      const events = result<{ cursor: number; action: string }[]>(await mcp.call('get_events', {}))
      expect(events.length).toBeGreaterThan(0)
      const feedKeys = Object.keys(events[0]!).sort()
      expect(feedKeys).toEqual([
        'action',
        'actor_id',
        'created_at',
        'cursor',
        'entity_id',
        'entity_type',
        'reason',
        'token_id',
      ]) // NO before/after (D-aa)
      const audit = result<Record<string, unknown>[]>(
        await mcp.call('search_audit', { entity_type: 'task', entity_id: task.id })
      )
      expect(Object.keys(audit[0]!).sort()).toContain('before')
      expect(audit[0]!.action).toBe('task_created')
    }))
})
