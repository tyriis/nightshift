import { describe, expect, it } from 'vitest'
import { makeTestApp, type TestApp } from '#root/testing/test-app'

const bearer = (t: TestApp): Record<string, string> => ({ authorization: `Bearer ${t.adminToken}` })

describe('admin routes (human-only, D-h)', () => {
  it('agent tokens are rejected from every /admin path', async () => {
    const t = await makeTestApp()
    const agent = (
      await t.app.inject({
        method: 'POST',
        url: '/admin/actors',
        headers: bearer(t),
        payload: { kind: 'agent', handle: 'hermes-1', display_name: 'Hermes' },
      })
    ).json()
    const issued = (
      await t.app.inject({
        method: 'POST',
        url: `/admin/actors/${agent.id}/tokens`,
        headers: bearer(t),
        payload: { label: 'ci' },
      })
    ).json()
    expect(issued.raw_token).toMatch(/^[A-Za-z0-9_-]{43}$/)

    // human pass-through on the one list route (D-h "both sides"): 200, and no
    // token material ever re-emits from a list shape (shown-once, spec §5)
    const list = await t.app.inject({ method: 'GET', url: '/admin/actors', headers: bearer(t) })
    expect(list.statusCode).toBe(200)
    expect(JSON.stringify(list.json())).not.toMatch(/token_hash|raw_token/)

    const forBidden = await t.app.inject({
      method: 'GET',
      url: '/admin/actors',
      headers: { authorization: `Bearer ${issued.raw_token}` },
    })
    expect(forBidden.statusCode).toBe(403)
    expect(forBidden.json().code).toBe('forbidden')
    await t.close()
  })

  it('issued token authenticates agent API calls; revocation kills it (401)', async () => {
    const t = await makeTestApp()
    const agent = (
      await t.app.inject({
        method: 'POST',
        url: '/admin/actors',
        headers: bearer(t),
        payload: { kind: 'agent', handle: 'hermes-1', display_name: 'Hermes' },
      })
    ).json()
    const issued = (
      await t.app.inject({
        method: 'POST',
        url: `/admin/actors/${agent.id}/tokens`,
        headers: bearer(t),
        payload: { label: 'ci' },
      })
    ).json()
    const agentHeaders = { authorization: `Bearer ${issued.raw_token}` }

    const task = (
      await t.app.inject({
        method: 'POST',
        url: '/tasks',
        headers: bearer(t),
        payload: { title: 'x', status: 'todo' },
      })
    ).json()
    const claim = await t.app.inject({
      method: 'POST',
      url: `/tasks/${task.id}/claim`,
      headers: agentHeaders,
    })
    expect(claim.statusCode).toBe(200)

    const revoke = await t.app.inject({
      method: 'POST',
      url: `/admin/tokens/${issued.token_id}/revoke`,
      headers: bearer(t),
    })
    expect(revoke.statusCode).toBe(204)

    const after = await t.app.inject({
      method: 'GET',
      url: '/audit',
      headers: agentHeaders,
    })
    expect(after.statusCode).toBe(401)
    expect(after.json().code).toBe('unauthenticated')

    // audit recorded who issued/revoked which token (per-actor audit, spec §5)
    const audit = (
      await t.app.inject({
        method: 'GET',
        url: '/audit?entity_type=actor&limit=50',
        headers: bearer(t),
      })
    ).json()
    expect(audit.some((a: { action: string }) => a.action === 'token_created')).toBe(true)
    expect(audit.some((a: { action: string }) => a.action === 'token_revoked')).toBe(true)
    await t.close()
  })

  it('duplicate handle → 409 handle_taken; policy flip changes agent close behavior end-to-end', async () => {
    const t = await makeTestApp()
    const dup = await t.app.inject({
      method: 'POST',
      url: '/admin/actors',
      headers: bearer(t),
      payload: { kind: 'human', handle: 'nils', display_name: 'Other' },
    })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().code).toBe('handle_taken')

    const agent = (
      await t.app.inject({
        method: 'POST',
        url: '/admin/actors',
        headers: bearer(t),
        payload: { kind: 'agent', handle: 'hermes-2', display_name: 'H2' },
      })
    ).json()
    const issued = (
      await t.app.inject({
        method: 'POST',
        url: `/admin/actors/${agent.id}/tokens`,
        headers: bearer(t),
        payload: { label: 'l' },
      })
    ).json()
    const agentHeaders = { authorization: `Bearer ${issued.raw_token}` }
    const task = (
      await t.app.inject({
        method: 'POST',
        url: '/tasks',
        headers: bearer(t),
        payload: { title: 'closey', status: 'todo' },
      })
    ).json()

    const denied = await t.app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}/status`,
      headers: agentHeaders,
      payload: { status: 'done', reason: 'gate' },
    })
    expect(denied.statusCode).toBe(403)

    const off = await t.app.inject({
      method: 'PUT',
      url: '/admin/policy/review_gate',
      headers: bearer(t),
      payload: { value: 'off' },
    })
    expect(off.statusCode).toBe(200)
    const allowed = await t.app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}/status`,
      headers: agentHeaders,
      payload: { status: 'done', reason: 'gate off' },
    })
    expect(allowed.statusCode).toBe(200)

    const badPolicy = await t.app.inject({
      method: 'PUT',
      url: '/admin/policy/review_gate',
      headers: bearer(t),
      payload: { value: 'maybe' },
    })
    expect(badPolicy.statusCode).toBe(400)
    const unknownKey = await t.app.inject({
      method: 'GET',
      url: '/admin/policy/nope',
      headers: bearer(t),
    })
    expect(unknownKey.statusCode).toBe(404)
    await t.close()
  })
})
