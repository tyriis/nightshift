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

describe('D-tt allow-list admin ops (idempotent POST, ghost-404 DELETE, policy flag)', () => {
  it('list -> add 201 LOWERCASED -> duplicate 200 same row -> audits -> DELETE 204 -> ghost-404 verbatim', async () => {
    const t = await makeTestApp()
    const listGet = () =>
      t.app.inject({ method: 'GET', url: '/admin/allowlist', headers: bearer(t) })

    const empty = await listGet()
    expect(empty.statusCode).toBe(200)
    expect(empty.json()).toEqual([])

    const added = await t.app.inject({
      method: 'POST',
      url: '/admin/allowlist',
      headers: bearer(t),
      payload: { email: 'Alice@Example.COM' },
    })
    expect(added.statusCode).toBe(201)
    // stored LOWERCASED (pinned both sides with the use-case test); whole row shape
    expect(added.json()).toMatchObject({ email: 'alice@example.com', added_by: 'a_nils' })
    expect(Object.keys(added.json()).sort()).toEqual(['added_by', 'created_at', 'email'])

    // duplicate POST is idempotent DATA, not error: 200 + the existing row (D-tt PINNED)
    const dup = await t.app.inject({
      method: 'POST',
      url: '/admin/allowlist',
      headers: bearer(t),
      payload: { email: 'ALICE@EXAMPLE.com' },
    })
    expect(dup.statusCode).toBe(200)
    expect(dup.json()).toEqual(added.json())

    // the route schema pattern rejects at the edge (same language as the use-case rule)
    const bad = await t.app.inject({
      method: 'POST',
      url: '/admin/allowlist',
      headers: bearer(t),
      payload: { email: 'not-an-email' },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('invalid_request')

    const list = await listGet()
    expect(list.statusCode).toBe(200)
    expect(list.json()).toEqual([added.json()])

    // audit spine (machine strings pinned: action, entity, after)
    const auditA = (
      await t.app.inject({
        method: 'GET',
        url: '/audit?entity_type=allowlist&limit=50',
        headers: bearer(t),
      })
    ).json()
    expect(auditA.map((a: { action: string }) => a.action)).toEqual(['allowlist_added'])
    expect(auditA[0]).toMatchObject({
      actor_id: 'a_nils',
      entity_id: 'alice@example.com',
      after: { email: 'alice@example.com' },
    })

    // DELETE arrives URL-decoded (%40); the lowercase rule applies BEFORE lookup
    const gone = await t.app.inject({
      method: 'DELETE',
      url: '/admin/allowlist/ALICE%40EXAMPLE.com',
      headers: bearer(t),
    })
    expect(gone.statusCode).toBe(204)
    expect((await listGet()).json()).toEqual([])

    const auditB = (
      await t.app.inject({
        method: 'GET',
        url: '/audit?entity_type=allowlist&limit=50',
        headers: bearer(t),
      })
    ).json()
    // search is desc (the activity-tab view; tail is the ascending one)
    expect(auditB.map((a: { action: string }) => a.action)).toEqual([
      'allowlist_removed',
      'allowlist_added',
    ])

    // ghost-404 doctrine, detail VERBATIM
    const ghost = await t.app.inject({
      method: 'DELETE',
      url: '/admin/allowlist/ghost@x.example',
      headers: bearer(t),
    })
    expect(ghost.statusCode).toBe(404)
    expect(ghost.json().code).toBe('not_found')
    expect(ghost.json().detail).toBe("allow-list entry 'ghost@x.example' not found")
    await t.close()
  })

  it('policy flag on the widened enum: oidc_provisioning allowlist => 200, on => 400; review_gate + allowlist STILL 400 (R2/B10)', async () => {
    const t = await makeTestApp()
    const allow = await t.app.inject({
      method: 'PUT',
      url: '/admin/policy/oidc_provisioning',
      headers: bearer(t),
      payload: { value: 'allowlist' },
    })
    expect(allow.statusCode).toBe(200)
    expect(allow.json()).toEqual({ key: 'oidc_provisioning', value: 'allowlist' })

    // 'on' rides the widened transport enum and is rejected by the PER-KEY gate
    const on = await t.app.inject({
      method: 'PUT',
      url: '/admin/policy/oidc_provisioning',
      headers: bearer(t),
      payload: { value: 'on' },
    })
    expect(on.statusCode).toBe(400)
    expect(on.json().code).toBe('invalid_request')

    // NEW arm (review R2/B10): the transport enum widened, POLICY_ALLOWLIST stays
    // the per-key semantic gate — no silent semantic widening.
    const gate = await t.app.inject({
      method: 'PUT',
      url: '/admin/policy/review_gate',
      headers: bearer(t),
      payload: { value: 'allowlist' },
    })
    expect(gate.statusCode).toBe(400)
    expect(gate.json().code).toBe('invalid_request')
    await t.close()
  })
})
