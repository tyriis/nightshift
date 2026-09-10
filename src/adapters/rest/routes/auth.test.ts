// Task 7 (D-pp/D-tt/D-qq/D-rr/D-zz): the auth-routes arm set. Every leg rides the
// Task-5 stub IdP through inject (zero sockets); every DENY/allow/provision/drop-out
// arm is its own pin with the pinned machine strings.
//
// Module-cache isolation: discover/jwks caches are oidc-rp MODULE state keyed by
// issuer — the route tests statically import the RP module (the app-under-test
// shares that instance) and give every test its OWN issuer, so no test inherits
// another's discovery doc or RemoteJWKSet closure.
import { describe, expect, it } from 'vitest'
import * as rp from '#root/adapters/shared/oidc-rp'
import {
  clearSessionCookies,
  decodeSessionCookie,
  decodeSignedJson,
  encodeSessionCookie,
  encodeSignedJson,
} from '#root/adapters/shared/session-codec'
import { makeTestApp, type TestApp } from '#root/testing/test-app'
import { makeOidcApp, SESSION_KEY, type OidcApp } from '#root/testing/oidc-harness'
import type { StubUser } from '#root/testing/stub-idp'
import type { AuditRow } from '#root/application/ports'

const MISSING_BEARER = 'missing bearer token (Plan E adds human cookie sessions)'
const D_RR = 'missing or invalid CSRF token (D-rr)'
const D_PP = 'oidc callback validation failed (D-pp)'
const D_TT = 'oidc identity not recognized (allow-list first)'
const D_QQ = 'logout requires a cookie session (D-qq)'

const USERS: Record<string, StubUser> = {
  alice: { sub: 'stub-alice', email: 'alice@example.test', preferred_username: 'alice' },
  unverified: {
    sub: 'stub-unverified',
    email: 'unverified@example.test',
    preferred_username: 'unverified',
    email_verified: false,
  },
  // the falsy-email arm (D-tt gate): email_verified true, email empty
  noe: { sub: 'stub-noe', email: '', preferred_username: 'noe' },
}

let seq = 0
const freshIssuer = (): string => `http://idp${(seq += 1)}.test`

// ---- cookie-jar helpers (raw inject world — fastify hands set-cookie arrays) ----
const setCookies = (res: unknown): string[] => {
  const raw = (res as { headers?: Record<string, unknown> }).headers?.['set-cookie']
  return raw === undefined ? [] : Array.isArray(raw) ? (raw as string[]) : [String(raw)]
}
const cookieValue = (res: unknown, name: string): string | undefined => {
  for (const c of setCookies(res)) {
    const [pair] = c.split(';')
    const eq = (pair ?? '').indexOf('=')
    if ((pair ?? '').slice(0, eq).trim() === name) return (pair ?? '').slice(eq + 1)
  }
  return undefined
}

// the two browser legs BEFORE the callback: GET /auth/login (flow cookie + authorize
// Location) → authorize inject with login_hint → the IdP's callback query
const loginRoundTrip = async (h: OidcApp, issuer: string, userKey = 'alice', loginQuery = '') => {
  const login = await h.t.app.inject({ method: 'GET', url: `/auth/login${loginQuery}` })
  expect(login.statusCode).toBe(302)
  const loc = new URL(login.headers.location as string)
  const flowRaw = cookieValue(login, '__Host-ns_flow')
  if (!flowRaw) throw new Error('no flow cookie on /auth/login response')
  const flow = decodeSignedJson(flowRaw, SESSION_KEY, new Date().toISOString(), rp.isOidcFlow)
  if (!flow) throw new Error('flow cookie did not decode')
  const auth = await h.idp.app.inject({
    method: 'GET',
    url: `${loc.href.slice(issuer.length)}&login_hint=${userKey}`,
  })
  expect(auth.statusCode).toBe(302)
  return { flow, flowRaw, cbQuery: new URL(auth.headers.location as string).search }
}

const callback = (
  h: OidcApp,
  query: string,
  opts: { flowRaw?: string; headers?: Record<string, string> } = {}
) =>
  h.t.app.inject({
    method: 'GET',
    url: `/auth/callback${query}`,
    headers: opts.flowRaw
      ? { ...(opts.headers ?? {}), cookie: `__Host-ns_flow=${opts.flowRaw}` }
      : opts.headers,
  })

const audits = (t: TestApp): Promise<AuditRow[]> => t.deps.auditRoot.tail(0, 500)
const sessionRows = (t: TestApp): Promise<number> =>
  t.deps.db
    .selectFrom('sessions')
    .selectAll()
    .execute()
    .then((r) => r.length)

const FLOW_CLEAR = '__Host-ns_flow=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
const SESS_ATTRS = /; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=28800$/

const seedBound = async (t: TestApp, sub: string): Promise<string> => {
  await t.deps.db
    .insertInto('actors')
    .values({
      id: 'a_bound',
      kind: 'human',
      handle: 'bound-alice',
      display_name: 'Bound Alice',
      description: '',
      created_at: '2026-01-01T00:00:00.000Z',
      role: 'member',
      oidc_subject: sub,
    })
    .execute()
  return 'a_bound'
}

const allowAlice = async (t: TestApp): Promise<void> => {
  await t.deps.actorsRoot.setPolicy('oidc_provisioning', 'allowlist')
  await t.deps.allowlistRoot.insert({
    email: 'alice@example.test',
    added_by: 'a_nils',
    created_at: '2026-01-01T00:00:00.000Z',
  })
}

describe('GET /auth/login (D-vv(b) + L arms)', () => {
  it('AUTH_PRE_SESSION exact set: membership equality (a fourth member fails it)', async () => {
    const { AUTH_PRE_SESSION } = await import('#root/adapters/rest/auth')
    expect([...AUTH_PRE_SESSION]).toEqual(['/auth/login', '/auth/callback'])
  })

  it('L1: OIDC not configured (default test env) => 500 problem internal_error, pinned detail (both pre-session legs)', async () => {
    const t = await makeTestApp() // no NS_OIDC_* — dormant
    for (const url of ['/auth/login', '/auth/callback']) {
      const res = await t.app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(500)
      expect(res.headers['content-type']).toContain('application/problem+json')
      expect(res.json()).toMatchObject({ code: 'internal_error', detail: 'oidc not configured' })
    }
    await t.close()
  })

  it('L2: configured, no returnTo => 302 stub authorize URL w/ exact query set + pinned flow cookie', async () => {
    const issuer = freshIssuer()
    const h = await makeOidcApp({ rp, issuer, users: USERS })
    const res = await h.t.app.inject({ method: 'GET', url: '/auth/login' })
    expect(res.statusCode).toBe(302)
    const loc = new URL(res.headers.location as string)
    expect(loc.href.startsWith(`${issuer}/authorize?`)).toBe(true)
    const q = Object.fromEntries(loc.searchParams)
    expect(Object.keys(q).sort()).toEqual([
      'client_id',
      'code_challenge',
      'code_challenge_method',
      'nonce',
      'redirect_uri',
      'response_type',
      'scope',
      'state',
    ])
    expect(q).toMatchObject({
      response_type: 'code',
      client_id: 'ns',
      redirect_uri: 'http://board.test/auth/callback',
      scope: 'openid profile email',
      code_challenge_method: 'S256',
    })
    // the flow cookie: HttpOnly attrs in the shipped codec order, Max-Age = the 600s flow life
    expect(setCookies(res)).toHaveLength(1)
    expect(setCookies(res)[0]).toMatch(
      /^__Host-ns_flow=.+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=600$/
    )
    const flow = decodeSignedJson(
      String(cookieValue(res, '__Host-ns_flow')),
      SESSION_KEY,
      new Date().toISOString(),
      rp.isOidcFlow
    )
    expect(flow?.returnTo).toBe('/ui/') // the default landing
    expect(flow?.state).toBe(q.state)
    await h.close()
  })

  it('L3: returnTo outside /ui/ collapses to /ui/ INSIDE the flow cookie; /ui/ rides through', async () => {
    const issuer = freshIssuer()
    const h = await makeOidcApp({ rp, issuer, users: USERS })
    for (const [query, want] of [
      ['?returnTo=/tasks/NS-1', '/ui/'],
      ['?returnTo=https://evil.test/x', '/ui/'],
      ['?returnTo=/ui/tasks/NS-1', '/ui/tasks/NS-1'],
    ] as const) {
      const res = await h.t.app.inject({ method: 'GET', url: `/auth/login${query}` })
      const flow = decodeSignedJson(
        String(cookieValue(res, '__Host-ns_flow')),
        SESSION_KEY,
        new Date().toISOString(),
        rp.isOidcFlow
      )
      expect({ query, got: flow?.returnTo }).toEqual({ query, got: want })
    }
    await h.close()
  })

  it('L4: POST /auth/login => 401 byte-identical missing-bearer (the exempt arm is GET-only)', async () => {
    const issuer = freshIssuer()
    const h = await makeOidcApp({ rp, issuer, users: USERS })
    const res = await h.t.app.inject({ method: 'POST', url: '/auth/login' })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ code: 'unauthenticated', detail: MISSING_BEARER })
    await h.close()
  })
})

describe('GET /auth/callback (D-tt decision tree + C arms)', () => {
  it('C1: green round-trip on a bound subject => 302 returnTo, BOTH cookies + flow cleared, session row, login_success on the spine', async () => {
    const issuer = freshIssuer()
    const h = await makeOidcApp({ rp, issuer, users: USERS })
    const actorId = await seedBound(h.t, 'stub-alice')
    const { flowRaw, cbQuery } = await loginRoundTrip(h, issuer)
    const res = await callback(h, cbQuery, { flowRaw })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/ui/')
    const cookies = setCookies(res)
    expect(cookies).toHaveLength(3)
    const [sess, csrf, flow] = cookies
    expect(sess).toMatch(
      /^__Host-ns_sess=.+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=28800$/
    )
    expect(csrf).toMatch(/^__Host-ns_csrf=.+; Secure; SameSite=Lax; Path=\/; Max-Age=28800$/)
    expect(csrf).not.toContain('HttpOnly') // D-rr companion: the SPA must read it
    expect(flow).toBe(FLOW_CLEAR)
    // the sessions row exists and the csrf cookie value rides the row
    const rows = await h.t.deps.db.selectFrom('sessions').selectAll().execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor_id: actorId, csrf: csrf.split(';')[0]?.split('=')[1] })
    const decoded = decodeSessionCookie(
      String(cookieValue(res, '__Host-ns_sess')),
      SESSION_KEY,
      new Date().toISOString()
    )
    expect(decoded?.sid).toBe(rows[0]?.id) // cookie is a signed pointer to the row
    if (!decoded) throw new Error('session cookie did not decode')
    expect(Math.abs(Date.parse(decoded.exp) - (Date.now() + 28_800_000))).toBeLessThan(5_000)
    // the spine: exactly one entry — login_success
    const spine = await audits(h.t)
    expect(spine).toHaveLength(1)
    expect(spine[0]).toMatchObject({
      actor_id: actorId,
      token_id: null,
      action: 'login_success',
      entity_type: 'actor',
      entity_id: actorId,
      after: { sub: 'stub-alice' },
    })
    await h.close()
  })

  it('C2: state mismatch (signed-but-different flow) => ONE pinned validation string + flow cookie cleared', async () => {
    const issuer = freshIssuer()
    const h = await makeOidcApp({ rp, issuer, users: USERS })
    await seedBound(h.t, 'stub-alice')
    const { flow, cbQuery } = await loginRoundTrip(h, issuer)
    const forged = encodeSignedJson({ ...flow, state: `${flow.state}-forged` }, SESSION_KEY)
    const res = await callback(h, cbQuery, { flowRaw: forged })
    expect(res.statusCode).toBe(403)
    expect(res.headers['content-type']).toContain('application/problem+json')
    expect(res.json()).toMatchObject({ code: 'forbidden', detail: D_PP })
    // the flow cookie is ALWAYS cleared (Max-Age=0 in the Set-Cookie)
    expect(setCookies(res)).toEqual([FLOW_CLEAR])
    expect(await sessionRows(h.t)).toBe(0)
    expect(await audits(h.t)).toHaveLength(0) // validation rejects are noise, not spine events
    await h.close()
  })

  it('C3: missing flow cookie / expired flow / missing code => the same C2-shape (no oracle)', async () => {
    const issuer = freshIssuer()
    const h = await makeOidcApp({ rp, issuer, users: USERS })
    await seedBound(h.t, 'stub-alice')
    const { flow, flowRaw, cbQuery } = await loginRoundTrip(h, issuer)
    const expired = encodeSignedJson(
      { ...flow, exp: new Date(Date.now() - 1_000).toISOString() },
      SESSION_KEY
    )
    const noCode = new URLSearchParams(cbQuery)
    noCode.delete('code')
    for (const [label, query, raw] of [
      ['missing-flow', cbQuery, undefined],
      ['expired-flow', cbQuery, expired],
      ['missing-code', `?${noCode}`, flowRaw],
    ] as const) {
      const res = await callback(h, query, { flowRaw: raw })
      expect({ label, status: res.statusCode, detail: res.json().detail }).toEqual({
        label,
        status: 403,
        detail: D_PP,
      })
      expect(setCookies(res)).toEqual([FLOW_CLEAR])
    }
    expect(await sessionRows(h.t)).toBe(0)
    await h.close()
  })

  it('C4: iss param present and ≠ issuer => C2-shape (RFC 9207 leg)', async () => {
    const issuer = freshIssuer()
    const h = await makeOidcApp({ rp, issuer, users: USERS })
    await seedBound(h.t, 'stub-alice')
    const { flowRaw, cbQuery } = await loginRoundTrip(h, issuer)
    const q = new URLSearchParams(cbQuery)
    q.set('iss', 'http://evil.test')
    const res = await callback(h, `?${q}`, { flowRaw })
    expect(res.statusCode).toBe(403)
    expect(res.json().detail).toBe(D_PP)
    expect(setCookies(res)).toEqual([FLOW_CLEAR])
    await h.close()
  })

  it('C5: IdP error leg => 302 /ui/login?error=idp + login_denied (reason idp_error)', async () => {
    const issuer = freshIssuer()
    const h = await makeOidcApp({ rp, issuer, users: USERS })
    const res = await callback(h, '?error=access_denied&state=x')
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/ui/login?error=idp')
    expect(setCookies(res)).toEqual([FLOW_CLEAR])
    const spine = await audits(h.t)
    expect(spine).toHaveLength(1)
    expect(spine[0]).toMatchObject({
      actor_id: null,
      token_id: null,
      action: 'login_denied',
      entity_type: 'actor',
      entity_id: 'unknown', // no verified identity exists — unverified query data never enters the spine
      reason: 'idp_error',
    })
    await h.close()
  })

  it('C6: token endpoint down => 500 internal_error, generic path, NO detail leak', async () => {
    const issuer = freshIssuer()
    const h = await makeOidcApp({ rp, issuer, users: USERS })
    await seedBound(h.t, 'stub-alice')
    const { flowRaw, cbQuery } = await loginRoundTrip(h, issuer)
    const orig = h.fetch
    h.t.deps.fetch = async (input, init) =>
      String(input).endsWith('/api/oidc/token')
        ? Response.json({ error: 'stub down' }, { status: 500 })
        : orig(input, init)
    const res = await callback(h, cbQuery, { flowRaw })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toMatchObject({ code: 'internal_error', detail: 'internal error' }) // problem.ts generic — never the RP error text
    // the flow cookie is cleared on EVERY callback response — even the generic 500
    expect(setCookies(res)).toEqual([FLOW_CLEAR])
    expect(await sessionRows(h.t)).toBe(0)
    await h.close()
  })

  it('C7: green path BUT policy off => 302 error=pending + login_denied + NO session; fail-closed on missing/unknown policy', async () => {
    const issuer = freshIssuer()
    const h = await makeOidcApp({ rp, issuer, users: USERS })
    // three deny drivers, each PREPPED for real: seeded 'off' (the migration seed),
    // row DELETED (null ⇒ fail-closed 'off'), raw-set 'on' (anything that is not
    // 'allowlist' denies fail-closed)
    for (const [label, prep] of [
      ['seeded-off', async (): Promise<void> => {}],
      [
        'policy-deleted',
        async (): Promise<void> => {
          await h.t.deps.db.deleteFrom('policy').where('key', '=', 'oidc_provisioning').execute()
        },
      ],
      [
        'policy-on',
        async (): Promise<void> => {
          await h.t.deps.actorsRoot.setPolicy('oidc_provisioning', 'on')
        },
      ],
    ] as const) {
      await prep()
      const { flowRaw, cbQuery } = await loginRoundTrip(h, issuer)
      const res = await callback(h, cbQuery, { flowRaw })
      expect({ label, status: res.statusCode, loc: res.headers.location }).toEqual({
        label,
        status: 302,
        loc: '/ui/login?error=pending',
      })
      expect(setCookies(res)).toEqual([FLOW_CLEAR])
    }
    expect(await sessionRows(h.t)).toBe(0)
    const spine = await audits(h.t)
    expect(spine).toHaveLength(3)
    for (const row of spine) {
      expect(row).toMatchObject({
        actor_id: null,
        token_id: null,
        action: 'login_denied',
        entity_type: 'actor',
        entity_id: 'stub-alice', // the VERIFIED sub — the deny knows exactly who was refused
        reason: 'not allow-listed',
      })
    }
    await h.close()
  })

  it('C8: policy off + accept: application/json => 403 forbidden, pinned detail (API deny shape)', async () => {
    const issuer = freshIssuer()
    const h = await makeOidcApp({ rp, issuer, users: USERS })
    const { flowRaw, cbQuery } = await loginRoundTrip(h, issuer)
    const res = await callback(h, cbQuery, { flowRaw, headers: { accept: 'application/json' } })
    expect(res.statusCode).toBe(403)
    expect(res.headers['content-type']).toContain('application/problem+json')
    expect(res.json()).toMatchObject({ code: 'forbidden', detail: D_TT })
    const spine = await audits(h.t)
    expect(spine).toHaveLength(1)
    expect(spine[0]).toMatchObject({ action: 'login_denied', reason: 'not allow-listed' }) // the SAME audit as the browser deny
    await h.close()
  })

  it('C9: policy allowlist + listed => PROVISION (member) + login completes', async () => {
    const issuer = freshIssuer()
    const h = await makeOidcApp({ rp, issuer, users: USERS })
    await allowAlice(h.t)
    const { flowRaw, cbQuery } = await loginRoundTrip(h, issuer)
    const res = await callback(h, cbQuery, { flowRaw })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/ui/')
    expect(setCookies(res)).toHaveLength(3)
    // the row: kind human, role member, subject bound — verified through the deps db
    const [row] = await h.t.deps.db
      .selectFrom('actors')
      .selectAll()
      .where('oidc_subject', '=', 'stub-alice')
      .execute()
    expect(row).toMatchObject({
      kind: 'human',
      role: 'member',
      handle: 'alice',
      display_name: 'alice',
      description: '',
    })
    // the spine, in order: human_provisioned then login_success
    const spine = await audits(h.t)
    expect(spine.map((r) => r.action)).toEqual(['human_provisioned', 'login_success'])
    expect(spine[0]).toMatchObject({
      entity_id: row?.id,
      after: { handle: 'alice', subject: 'stub-alice' },
      reason: 'oidc first-login allow-list',
    })
    expect(spine[1]).toMatchObject({ actor_id: row?.id, after: { sub: 'stub-alice' } })
    await h.close()
  })

  it('C10: policy allowlist + email NOT listed => C7-shape', async () => {
    const issuer = freshIssuer()
    const h = await makeOidcApp({ rp, issuer, users: USERS })
    await h.t.deps.actorsRoot.setPolicy('oidc_provisioning', 'allowlist')
    const { flowRaw, cbQuery } = await loginRoundTrip(h, issuer)
    const res = await callback(h, cbQuery, { flowRaw })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/ui/login?error=pending')
    expect(await sessionRows(h.t)).toBe(0)
    expect(await audits(h.t)).toMatchObject([
      { action: 'login_denied', reason: 'not allow-listed' },
    ])
    await h.close()
  })

  it('C11: listed BUT email_verified false => deny; falsy email on a verified token => deny (gate)', async () => {
    const issuer = freshIssuer()
    const h = await makeOidcApp({ rp, issuer, users: USERS, userKey: 'unverified' })
    await h.t.deps.actorsRoot.setPolicy('oidc_provisioning', 'allowlist')
    await h.t.deps.allowlistRoot.insert({
      email: 'unverified@example.test',
      added_by: 'a_nils',
      created_at: '2026-01-01T00:00:00.000Z',
    })
    const { flowRaw: fr1, cbQuery: q1 } = await loginRoundTrip(h, issuer, 'unverified')
    const denied = await callback(h, q1, { flowRaw: fr1 })
    expect(denied.statusCode).toBe(302)
    expect(denied.headers.location).toBe('/ui/login?error=pending')
    await h.close()

    // the falsy-email leg: email_verified true, email '' — nothing can be listed
    const issuer2 = freshIssuer()
    const h2 = await makeOidcApp({ rp, issuer: issuer2, users: USERS, userKey: 'noe' })
    await h2.t.deps.actorsRoot.setPolicy('oidc_provisioning', 'allowlist')
    const { flowRaw: fr2, cbQuery: q2 } = await loginRoundTrip(h2, issuer2, 'noe')
    const denied2 = await callback(h2, q2, { flowRaw: fr2 })
    expect(denied2.headers.location).toBe('/ui/login?error=pending')
    expect(await audits(h2.t)).toMatchObject([
      { action: 'login_denied', reason: 'not allow-listed' },
    ])
    await h2.close()
  })

  it('C12: subject already bound (second login) => same actor, ZERO new actor rows, login_success again', async () => {
    const issuer = freshIssuer()
    const h = await makeOidcApp({ rp, issuer, users: USERS })
    const actorId = await seedBound(h.t, 'stub-alice')
    for (const _leg of [1, 2]) {
      const { flowRaw, cbQuery } = await loginRoundTrip(h, issuer)
      const res = await callback(h, cbQuery, { flowRaw })
      expect(res.statusCode).toBe(302)
      expect(res.headers.location).toBe('/ui/')
    }
    const actors = await h.t.deps.db
      .selectFrom('actors')
      .selectAll()
      .where('oidc_subject', '=', 'stub-alice')
      .execute()
    expect(actors).toHaveLength(1)
    expect(actors[0]?.id).toBe(actorId)
    expect(await sessionRows(h.t)).toBe(2) // two sessions, one identity
    const spine = await audits(h.t)
    expect(spine.map((r) => r.action)).toEqual(['login_success', 'login_success'])
    // and the policy was never consulted into a provisioning attempt: no human_provisioned
    expect(spine.some((r) => r.action === 'human_provisioned')).toBe(false)
    await h.close()
  })
})

describe('POST /auth/logout (O arms — session codec, no OIDC needed)', () => {
  const HOUR = 3_600_000
  const sessionApp = async (): Promise<TestApp> => makeTestApp({ NS_SESSION_KEY: SESSION_KEY })
  const mint = async (t: TestApp): Promise<string> => {
    const nowMs = Date.now()
    await t.deps.sessionsRoot.create({
      id: 's_1',
      actor_id: 'a_nils',
      csrf: 'c_1',
      created_at: new Date(nowMs).toISOString(),
      expires_at: new Date(nowMs + 8 * HOUR).toISOString(),
    })
    return encodeSessionCookie(
      { sid: 's_1', exp: new Date(nowMs + 8 * HOUR).toISOString() },
      t.deps.config.sessionKey as string
    )
  }

  it('O1: session actor + right CSRF => 204, both cookies cleared, row revoked, session_revoked audited', async () => {
    const t = await sessionApp()
    const sess = await mint(t)
    const res = await t.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: `__Host-ns_sess=${sess}`, 'x-csrf-token': 'c_1' },
    })
    expect(res.statusCode).toBe(204)
    expect(setCookies(res)).toEqual([...clearSessionCookies()])
    const [row] = await t.deps.db.selectFrom('sessions').selectAll().execute()
    expect(row?.revoked_at).toBeTruthy()
    const spine = await audits(t)
    expect(spine).toHaveLength(1)
    expect(spine[0]).toMatchObject({
      actor_id: 'a_nils',
      token_id: null,
      action: 'session_revoked',
      entity_type: 'session',
      entity_id: 's_1',
      reason: 'logout',
    })
    await t.close()
  })

  it('O2: session actor, NO CSRF => 403 D-rr — the hook fires BEFORE the route (ordering pin)', async () => {
    const t = await sessionApp()
    const sess = await mint(t)
    const res = await t.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: `__Host-ns_sess=${sess}` },
    })
    expect(res.statusCode).toBe(403) // route-first would be 204/400 — the hook answers
    expect(res.json().detail).toBe(D_RR)
    const [row] = await t.deps.db.selectFrom('sessions').selectAll().execute()
    expect(row?.revoked_at).toBeNull() // the route never ran
    expect(await audits(t)).toHaveLength(0)
    await t.close()
  })

  it('O3: bearer actor => 400 invalid_request, pinned D-qq detail', async () => {
    const t = await sessionApp()
    const res = await t.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { authorization: `Bearer ${t.adminToken}` },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'invalid_request', detail: D_QQ })
    await t.close()
  })

  it('O4: no identity => hook 401 (the route never runs)', async () => {
    const t = await sessionApp()
    const res = await t.app.inject({ method: 'POST', url: '/auth/logout' })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ code: 'unauthenticated', detail: MISSING_BEARER })
    await t.close()
  })
})

describe('GET /auth/me (D-zz identity echo)', () => {
  it('M1: bearer token => 200 the ActorRef shape', async () => {
    const t = await makeTestApp()
    const res = await t.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${t.adminToken}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      id: 'a_nils',
      kind: 'human',
      handle: 'nils',
      display_name: 'Nils',
      role: 'admin',
    })
    await t.close()
  })

  it('M2: session cookie (CSRF-exempt GET) => 200, role rides (member after a C9 provision)', async () => {
    const issuer = freshIssuer()
    const h = await makeOidcApp({ rp, issuer, users: USERS })
    await allowAlice(h.t)
    const { flowRaw, cbQuery } = await loginRoundTrip(h, issuer)
    const cb = await callback(h, cbQuery, { flowRaw })
    const sess = String(cookieValue(cb, '__Host-ns_sess'))
    const res = await h.t.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: `__Host-ns_sess=${sess}` },
    })
    expect(res.statusCode).toBe(200)
    const [prov] = await h.t.deps.db
      .selectFrom('actors')
      .selectAll()
      .where('oidc_subject', '=', 'stub-alice')
      .execute()
    expect(res.json()).toEqual({
      id: prov?.id, // the FULL ActorRef shape — id included, nothing hidden
      kind: 'human',
      handle: 'alice',
      display_name: 'alice',
      role: 'member',
    })
    await h.close()
  })

  it('M3: no identity => 401 byte-identical missing-bearer', async () => {
    const t = await makeTestApp()
    const res = await t.app.inject({ method: 'GET', url: '/auth/me' })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ code: 'unauthenticated', detail: MISSING_BEARER })
    await t.close()
  })
})
