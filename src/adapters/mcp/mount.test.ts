// src/adapters/mcp/mount.test.ts
import { describe, expect, it } from 'vitest'
import { makeTestApp } from '#root/testing/test-app'
import { openHttpMcp } from '#root/testing/mcp-client'

const seedQuestion = async (t: Awaited<ReturnType<typeof makeTestApp>>, assigneeHandle: string) => {
  const task = await t.app.inject({
    method: 'POST',
    url: '/tasks',
    headers: { authorization: `Bearer ${t.adminToken}` },
    payload: { title: 'seed' },
  })
  expect(task.statusCode).toBe(201)
  // D-r: question assignment notifies the assignee but NEVER the creator, so the
  // seeder is a separate agent — a question nils asks nils books no inbox row.
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
  const thread = await t.app.inject({
    method: 'POST',
    url: `/tasks/${task.json().id}/threads`,
    headers: { authorization: `Bearer ${seederTok.json().raw_token}` },
    payload: { kind: 'question', body: 'seeded?', assignee_handle: assigneeHandle },
  })
  expect(thread.statusCode).toBe(201)
}

describe('mcp mount (D-hh, D-ii)', () => {
  it('rejects unauthenticated connects through the SAME hook (problem+json 401)', async () => {
    const t = await makeTestApp()
    try {
      const baseUrl = await t.app.listen({ port: 0, host: '127.0.0.1' })
      const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client')
      const client = new Client(
        { name: 'x', version: '1.0.0' },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } }
      )
      await expect(
        client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)))
      ).rejects.toMatchObject({ code: 'CLIENT_HTTP_AUTHENTICATION' }) // era-specific class, match code (D-ii)
    } finally {
      await t.close()
    }
  })

  it('modern + legacy eras both serve get_inbox; result mirrors REST byte-for-byte; views are per-actor', async () => {
    const t = await makeTestApp()
    try {
      const baseUrl = await t.app.listen({ port: 0, host: '127.0.0.1' })
      await seedQuestion(t, 'nils') // inbox row for the seeded human actor (D-r)
      const modern = await openHttpMcp(baseUrl, t.adminToken, '2026-07-28')
      const legacy = await openHttpMcp(baseUrl, t.adminToken)
      const rest = await t.app.inject({
        method: 'GET',
        url: '/inbox',
        headers: { authorization: `Bearer ${t.adminToken}` },
      })
      expect(rest.statusCode).toBe(200)
      expect(rest.json()).toHaveLength(1) // the seed is non-vacuous (D-r notify landed)
      for (const mcp of [modern, legacy]) {
        const r = await mcp.call('get_inbox')
        expect(r.isError).toBeUndefined()
        expect(r.structuredContent).toEqual({ result: rest.json() }) // byte-parity, both eras
      }
      // per-actor isolation: a fresh AGENT sees an empty inbox while nils sees the seed
      const agent = await t.app.inject({
        method: 'POST',
        url: '/admin/actors',
        headers: { authorization: `Bearer ${t.adminToken}` },
        payload: { kind: 'agent', handle: 'a_iso', display_name: 'Iso' },
      })
      expect(agent.statusCode).toBe(201)
      const tok = await t.app.inject({
        method: 'POST',
        url: `/admin/actors/${agent.json().id}/tokens`,
        headers: { authorization: `Bearer ${t.adminToken}` },
        payload: { label: 'iso' },
      })
      expect(tok.statusCode).toBe(201)
      const iso = await openHttpMcp(baseUrl, tok.json().raw_token, '2026-07-28')
      expect((await iso.call('get_inbox')).structuredContent).toEqual({ result: [] })
      await modern.close()
      await legacy.close()
      await iso.close()
    } finally {
      await t.close()
    }
  })

  it('tools/list is exactly the current task-6-grown surface snapshot', async () => {
    const t = await makeTestApp()
    try {
      const baseUrl = await t.app.listen({ port: 0, host: '127.0.0.1' })
      const mcp = await openHttpMcp(baseUrl, t.adminToken, '2026-07-28')
      const listed = await mcp.list()
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        'add_block',
        'add_message',
        'answer_question',
        'claim_task',
        'create_task',
        'create_thread',
        'get_inbox',
        'get_task',
        'get_task_context',
        'heartbeat_task',
        'list_ready_tasks',
        'list_tasks',
        'list_threads',
        'mark_inbox_read',
        'release_task',
        'remove_block',
        'update_question',
        'update_task',
        'update_task_status',
      ])
      await mcp.close()
    } finally {
      await t.close()
    }
  })

  it('transport surface: GET/DELETE → handler 405; malformed POST body → JSON-RPC -32700 (buffer parser kept)', async () => {
    const t = await makeTestApp()
    try {
      const baseUrl = await t.app.listen({ port: 0, host: '127.0.0.1' })
      for (const method of ['GET', 'DELETE'] as const) {
        const res = await fetch(`${baseUrl}/mcp`, {
          method,
          headers: { authorization: `Bearer ${t.adminToken}` },
        })
        expect(res.status).toBe(405)
      }
      const bad = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${t.adminToken}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: '{ not json',
      })
      expect(bad.status).toBe(400)
      expect((await bad.text()).includes('-32700')).toBe(true)
    } finally {
      await t.close()
    }
  })
})
