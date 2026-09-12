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
})

// issue #23: PATCH /admin/actors/:id — the humans-only role switch, audited role_changed
// (the update-status.ts before/after lineage), with the last-admin refusal as the
// self-healing guard. The test board seeds exactly ONE admin (a_nils, test-app.ts).
describe('issue #23: PATCH /admin/actors/:id (role switch)', () => {
  const createActor = async (
    t: TestApp,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> =>
    (
      await t.app.inject({
        method: 'POST',
        url: '/admin/actors',
        headers: bearer(t),
        payload,
      })
    ).json()

  const patch = (t: TestApp, id: string, role: string) =>
    t.app.inject({
      method: 'PATCH',
      url: `/admin/actors/${id}`,
      headers: bearer(t),
      payload: { role },
    })

  it('member -> admin -> member: 200 with the updated whole row, both directions', async () => {
    const t = await makeTestApp()
    const bob = await createActor(t, { kind: 'human', handle: 'bob', display_name: 'Bob' })
    const up = await patch(t, bob.id as string, 'admin')
    expect(up.statusCode).toBe(200)
    // nothing-hidden twin of GET /admin/actors: the full ActorRow shape rides back
    expect(Object.keys(up.json()).sort()).toEqual([
      'created_at',
      'description',
      'display_name',
      'handle',
      'id',
      'kind',
      'oidc_subject',
      'role',
    ])
    expect(up.json()).toMatchObject({ id: bob.id, handle: 'bob', kind: 'human', role: 'admin' })
    const down = await patch(t, bob.id as string, 'member')
    expect(down.statusCode).toBe(200)
    expect(down.json().role).toBe('member')
    // the 200 is the FRESH row, not an echo: the stored row matches
    const listed = (
      await t.app.inject({ method: 'GET', url: '/admin/actors', headers: bearer(t) })
    ).json()
    expect(listed.find((a: { id: string }) => a.id === bob.id).role).toBe('member')
    await t.close()
  })

  it('audits role_changed with before/after, attributed to the acting admin', async () => {
    const t = await makeTestApp()
    const bob = await createActor(t, { kind: 'human', handle: 'bob', display_name: 'Bob' })
    await patch(t, bob.id as string, 'admin')
    await patch(t, bob.id as string, 'member')
    const audit = (
      await t.app.inject({
        method: 'GET',
        url: `/audit?entity_type=actor&entity_id=${bob.id}&limit=50`,
        headers: bearer(t),
      })
    ).json()
    const roles = audit.filter((a: { action: string }) => a.action === 'role_changed')
    // search is DESC (the activity view), so the demotion leads the promotion
    expect(roles.map((a: { before: unknown; after: unknown }) => [a.before, a.after])).toEqual([
      [{ role: 'admin' }, { role: 'member' }],
      [{ role: 'member' }, { role: 'admin' }],
    ])
    expect(roles[0]).toMatchObject({
      actor_id: 'a_nils',
      entity_type: 'actor',
      entity_id: bob.id,
      reason: 'role changed',
    })
    await t.close()
  })

  it('bad bodies 400 invalid_request (edge enum = HUMAN_ROLES twin); unknown id 404', async () => {
    const t = await makeTestApp()
    const bob = await createActor(t, { kind: 'human', handle: 'bob', display_name: 'Bob' })
    for (const payload of [{ role: 'boss' }, {}] as const) {
      const res = await t.app.inject({
        method: 'PATCH',
        url: `/admin/actors/${bob.id}`,
        headers: bearer(t),
        payload,
      })
      expect({ payload, status: res.statusCode, code: res.json().code }).toEqual({
        payload,
        status: 400,
        code: 'invalid_request',
      })
    }
    // removeAdditional status quo (fastify default ajv): a smuggled key is STRIPPED,
    // never a 400 — the same doctrine as webhooks.test.ts and the MCP parity harness.
    const smuggled = await t.app.inject({
      method: 'PATCH',
      url: `/admin/actors/${bob.id}`,
      headers: bearer(t),
      payload: { role: 'admin', extra: 1 },
    })
    expect(smuggled.statusCode).toBe(200)
    expect(smuggled.json()).toMatchObject({ id: bob.id, role: 'admin' })
    const ghost = await patch(t, 'a_ghost', 'admin')
    expect(ghost.statusCode).toBe(404)
    expect(ghost.json().code).toBe('not_found')
    expect(ghost.json().detail).toBe('actor a_ghost not found')
    await t.close()
  })

  it('agents are refused (role is humans-only, D-ss); no second admin is created', async () => {
    const t = await makeTestApp()
    const agent = await createActor(t, {
      kind: 'agent',
      handle: 'hermes-9',
      display_name: 'H9',
      role: 'admin', // dropped by CreateActor for agents — role stays null
    })
    expect(agent.role).toBeNull()
    const res = await patch(t, agent.id as string, 'admin')
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid_request')
    expect(res.json().detail).toBe(`actor ${agent.id} is not a human — only humans carry a role`)
    await t.close()
  })

  it('last-admin guard: the only admin cannot be demoted; a second admin unlocks it', async () => {
    const t = await makeTestApp()
    const solo = await patch(t, 'a_nils', 'member')
    expect(solo.statusCode).toBe(400)
    expect(solo.json().code).toBe('invalid_request')
    expect(solo.json().detail).toBe('actor a_nils is the last admin — demoting it leaves no admin')
    // the no-op arm is NOT a demotion: admin -> admin answers 200
    expect((await patch(t, 'a_nils', 'admin')).statusCode).toBe(200)

    const bob = await createActor(t, { kind: 'human', handle: 'bob', display_name: 'Bob' })
    expect((await patch(t, bob.id as string, 'admin')).statusCode).toBe(200) // two admins now
    const demoted = await patch(t, 'a_nils', 'member')
    expect(demoted.statusCode).toBe(200)
    expect(demoted.json()).toMatchObject({ id: 'a_nils', role: 'member' })
    // the write is LIVE on the wire: the very next admin op by the same token is a 403,
    // because a_nils is now a member (bob is the surviving admin)
    const after = await t.app.inject({ method: 'GET', url: '/admin/actors', headers: bearer(t) })
    expect(after.statusCode).toBe(403)
    expect(after.json().code).toBe('forbidden')
    await t.close()
  })
})

describe('D-tt policy flag on the widened enum (2 of 2)', () => {
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
