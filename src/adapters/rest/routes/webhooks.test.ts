import { describe, expect, it } from 'vitest'
import { makeTestApp } from '#root/testing/test-app'

const bearer = (t: string) => ({ authorization: `Bearer ${t}` })

describe('POST/GET/DELETE /admin/webhooks + rotate (D-ff, requireHuman)', () => {
  it('agent callers are 403 on every webhook route (human-only, spec §6.8 admin)', async () => {
    const t = await makeTestApp()
    // register an agent actor + token through the admin surface first
    const agent = await t.app.inject({
      method: 'POST',
      url: '/admin/actors',
      headers: bearer(t.adminToken),
      payload: { kind: 'agent', handle: 'whd-agent', display_name: 'W' },
    })
    const tok = await t.app.inject({
      method: 'POST',
      url: `/admin/actors/${agent.json().id}/tokens`,
      headers: bearer(t.adminToken),
      payload: { label: 'w' },
    })
    const asAgent = bearer(tok.json().raw_token)
    // fastify validates the body BEFORE the preHandler — 403 (not 400) only proves the
    // human-guard, so every POST here carries a schema-VALID body
    for (const [method, url, payload] of [
      ['GET', '/admin/webhooks', undefined],
      ['POST', '/admin/webhooks', { agent_id: agent.json().id, url: 'http://x/403-probe' }],
      ['DELETE', '/admin/webhooks/wh_x', undefined],
      ['POST', '/admin/webhooks/wh_x/rotate-secret', undefined], // no body schema on this route
    ] as const) {
      const res = await t.app.inject({ method, url, headers: asAgent, payload })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
      expect(res.json().code).toBe('forbidden')
    }
    await t.close()
  })

  it('human lifecycle: create (secret once) → list (secret-free) → rotate → delete → 404', async () => {
    const t = await makeTestApp()
    const agent = await t.app.inject({
      method: 'POST',
      url: '/admin/actors',
      headers: bearer(t.adminToken),
      payload: { kind: 'agent', handle: 'life', display_name: 'L' },
    })
    const created = await t.app.inject({
      method: 'POST',
      url: '/admin/webhooks',
      headers: bearer(t.adminToken),
      payload: { agent_id: agent.json().id, url: 'http://runner.local/cb' },
    })
    expect(created.statusCode).toBe(201)
    const c = created.json()
    expect(c.id).toMatch(/^wh_/)
    expect(c.delivered_cursor).toBeGreaterThanOrEqual(1) // webhook_created audit rides BEFORE the seed? — assert >= 1 only; exact anchor value is the use-case's contract (Task 7 pins it)
    expect(c.secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const list = await t.app.inject({
      method: 'GET',
      url: '/admin/webhooks',
      headers: bearer(t.adminToken),
    })
    expect(list.json()).toHaveLength(1)
    expect(JSON.stringify(list.json())).not.toContain(c.secret) // D-ff exposure pin at the HTTP edge
    expect(list.json()[0].secret).toBeUndefined()
    const rotated = await t.app.inject({
      method: 'POST',
      url: `/admin/webhooks/${c.id}/rotate-secret`,
      headers: bearer(t.adminToken),
    })
    expect(rotated.statusCode).toBe(200)
    expect(rotated.json().secret).not.toBe(c.secret)
    const del = await t.app.inject({
      method: 'DELETE',
      url: `/admin/webhooks/${c.id}`,
      headers: bearer(t.adminToken),
    })
    expect(del.statusCode).toBe(204)
    expect(
      (
        await t.app.inject({
          method: 'DELETE',
          url: `/admin/webhooks/${c.id}`,
          headers: bearer(t.adminToken),
        })
      ).statusCode
    ).toBe(404)
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: `/admin/webhooks/wh_ghost/rotate-secret`,
          headers: bearer(t.adminToken),
        })
      ).json().code
    ).toBe('not_found')
    await t.close()
  })

  it('edge validation: human target and unknown actor; duplicate url 400; extra body keys STRIP per status quo (Task 7 parity, removeAdditional queued)', async () => {
    const t = await makeTestApp()
    const bad = await t.app.inject({
      method: 'POST',
      url: '/admin/webhooks',
      headers: bearer(t.adminToken),
      payload: { agent_id: 'a_nils', url: 'http://x/1' },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('invalid_request')
    const ghost = await t.app.inject({
      method: 'POST',
      url: '/admin/webhooks',
      headers: bearer(t.adminToken),
      payload: { agent_id: 'a_ghost', url: 'http://x/2' },
    })
    expect(ghost.statusCode).toBe(404)
    const mkAgent = async (handle: string) =>
      (
        await t.app.inject({
          method: 'POST',
          url: '/admin/actors',
          headers: bearer(t.adminToken),
          payload: { kind: 'agent', handle, display_name: handle },
        })
      ).json()
    const ag = await mkAgent('dup1')
    const a = await t.app.inject({
      method: 'POST',
      url: '/admin/webhooks',
      headers: bearer(t.adminToken),
      payload: { agent_id: ag.id, url: 'http://x/dup' },
    })
    expect(a.statusCode).toBe(201)
    const dup = await t.app.inject({
      method: 'POST',
      url: '/admin/webhooks',
      headers: bearer(t.adminToken),
      payload: { agent_id: ag.id, url: 'http://x/dup' },
    })
    expect(dup.statusCode).toBe(400)
    // removeAdditional status quo: unknown key silently stripped, NOT 400 (queued human decision)
    const parity = await t.app.inject({
      method: 'POST',
      url: '/admin/webhooks',
      headers: bearer(t.adminToken),
      payload: { agent_id: ag.id, url: 'http://x/parity', smuggled_actor: 'a_nils' },
    })
    expect(parity.statusCode).toBe(201)
    expect(parity.json().created_by).toBe('a_nils') // the ONLY human is the caller — no smuggle effect
    await t.close()
  })
})

it('makeTestApp defaults the loop DISABLED (the suite must never POST; D-v posture)', async () => {
  const t = await makeTestApp()
  expect(t.deps.config.webhookIntervalMs).toBe(0)
  // start() on a disabled loop is inert — no timer to leak, proven by process exit
  await t.deps.deliveryLoop.stop() // resolves even when never started
  await t.close()
})
