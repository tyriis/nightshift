// src/adapters/rest/scenarios-auth.test.ts
// §11 story shape (Task 7): the FULL human login loop over raw inject + a
// hand-rolled cookie jar — admin registers the email, flips the policy, the human
// logs in through the stub IdP, the member session acts (CSRF rides), the member
// hits the admin wall (D-ss), logs out, and the session dies (D-qq). Tonight's
// §14-1 human-loop skeleton; the Playwright twin rides the real UI in Task 11.
import { describe, expect, it } from 'vitest'
import * as rp from '#root/adapters/shared/oidc-rp'
import { makeOidcApp } from '#root/testing/oidc-harness'
import type { StubUser } from '#root/testing/stub-idp'

const USERS: Record<string, StubUser> = {
  alice: { sub: 'stub-alice', email: 'alice@example.test', preferred_username: 'alice' },
}

const MISSING_BEARER = 'missing bearer token (Plan E adds human cookie sessions)'
const D_RR = 'missing or invalid CSRF token (D-rr)'

type Headed = { headers: Record<string, unknown> }
const jarEat = (jar: Record<string, string>, res: Headed): void => {
  const raw = res.headers['set-cookie']
  const arr = raw === undefined ? [] : Array.isArray(raw) ? (raw as string[]) : [String(raw)]
  for (const c of arr) {
    const [pair] = c.split(';')
    const eq = (pair ?? '').indexOf('=')
    const name = (pair ?? '').slice(0, eq).trim()
    const value = (pair ?? '').slice(eq + 1)
    if (value === '')
      delete jar[name] // Max-Age=0 — the jar dies with the cookie
    else jar[name] = value
  }
}
const jarSend = (jar: Record<string, string>): string | undefined => {
  const pairs = Object.entries(jar).map(([k, v]) => `${k}=${v}`)
  return pairs.length ? pairs.join('; ') : undefined
}

describe('auth scenario (§11): allow-list first-login → member session → logout', () => {
  it('admin seeds → OIDC login → member acts WITH CSRF → admin wall 403 → logout → 401', async () => {
    const issuer = 'http://idp-scenario.test'
    const h = await makeOidcApp({ rp, issuer, users: USERS })
    const t = h.t
    const jar: Record<string, string> = {}

    // 1) bootstrap-admin bearer: allow-list + policy flip (the D-tt admin surface)
    const allow = await t.app.inject({
      method: 'POST',
      url: '/admin/allowlist',
      headers: { authorization: `Bearer ${t.adminToken}` },
      payload: { email: 'alice@example.test' },
    })
    expect(allow.statusCode).toBe(201)
    const flip = await t.app.inject({
      method: 'PUT',
      url: '/admin/policy/oidc_provisioning',
      headers: { authorization: `Bearer ${t.adminToken}` },
      payload: { value: 'allowlist' },
    })
    expect(flip.json()).toEqual({ key: 'oidc_provisioning', value: 'allowlist' })

    // 2) the human side: L2 → authorize → callback, jar-driven (raw inject only)
    const login = await t.app.inject({ method: 'GET', url: '/auth/login?returnTo=/ui/tasks' })
    expect(login.statusCode).toBe(302)
    jarEat(jar, login)
    expect(Object.keys(jar)).toEqual(['__Host-ns_flow'])
    const auth = await h.idp.app.inject({
      method: 'GET',
      url: `${new URL(login.headers.location as string).href.slice(issuer.length)}&login_hint=alice`,
    })
    expect(auth.statusCode).toBe(302)
    const cb = await t.app.inject({
      method: 'GET',
      url: `/auth/callback${new URL(auth.headers.location as string).search}`,
      headers: { cookie: jarSend(jar) as string },
    })
    expect(cb.statusCode).toBe(302)
    expect(cb.headers.location).toBe('/ui/tasks') // returnTo rode the flow cookie
    jarEat(jar, cb)
    expect(Object.keys(jar).sort()).toEqual(['__Host-ns_csrf', '__Host-ns_sess']) // flow consumed

    // 3) member session: read 200, write WITH the CSRF companion 201
    const tasks = await t.app.inject({
      method: 'GET',
      url: '/tasks',
      headers: { cookie: jarSend(jar) as string },
    })
    expect(tasks.statusCode).toBe(200)
    const noCsrf = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: jarSend(jar) as string },
      payload: { title: 'no token, no write' },
    })
    expect(noCsrf.statusCode).toBe(403)
    expect(noCsrf.json().detail).toBe(D_RR)
    const created = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: jarSend(jar) as string, 'x-csrf-token': jar['__Host-ns_csrf'] as string },
      payload: { title: 'provisioned work' },
    })
    expect(created.statusCode).toBe(201)

    // 4) the member identity: /auth/me echoes member; the admin wall stays (D-ss)
    const me = await t.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: jarSend(jar) as string },
    })
    expect(me.json()).toMatchObject({ kind: 'human', handle: 'alice', role: 'member' })
    expect(created.json().created_by).toBe(me.json().id) // the spine knows who wrote
    const wall = await t.app.inject({
      method: 'POST',
      url: '/admin/actors',
      headers: { cookie: jarSend(jar) as string, 'x-csrf-token': jar['__Host-ns_csrf'] as string },
      payload: { kind: 'human', handle: 'impostor', display_name: 'X' },
    })
    expect(wall.statusCode).toBe(403) // requireAdmin — the member-403 fact (T4 matrix shape)

    // 5) logout (CSRF rides) → the identity dies immediately
    const out = await t.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: jarSend(jar) as string, 'x-csrf-token': jar['__Host-ns_csrf'] as string },
    })
    expect(out.statusCode).toBe(204)
    jarEat(jar, out)
    expect(jar).toEqual({})
    const dead = await t.app.inject({
      method: 'GET',
      url: '/tasks',
      headers: { cookie: (jarSend(jar) as string) ?? '' },
    })
    expect(dead.statusCode).toBe(401)
    expect(dead.json().detail).toBe(MISSING_BEARER)

    // the spine tells the whole story (§14-7), in order
    const spine = await t.deps.auditRoot.tail(0, 500)
    expect(spine.map((r) => r.action)).toEqual([
      'allowlist_added', // admin seeding (token-riding, audited per plan A lineage)
      'policy_set',
      'human_provisioned',
      'login_success',
      'task_created', // the member write (created_by pinned above)
      'session_revoked',
    ])
    await h.close()
  })
})
