// src/adapters/rest/session-auth.test.ts
// Cookie sessions handcrafted WITHOUT OIDC — the codec + sessionsRoot are tonight's
// seams (Task 5 ships the OIDC login that mints sessions; the auth hook only ever
// sees a signed {sid, exp} resolving through the sessions table).
import { describe, expect, it } from 'vitest'
import { makeTestApp } from '#root/testing/test-app'
import { encodeSessionCookie } from '#root/adapters/shared/session-codec'

type TestApp = Awaited<ReturnType<typeof makeTestApp>>

const HOUR = 3_600_000
// zero new machine strings: every session reject falls through to THIS 401
const MISSING_BEARER = 'missing bearer token (Plan E adds human cookie sessions)'
const D_RR = 'missing or invalid CSRF token (D-rr)'
const D_WW = 'mcp requires a bearer token (D-ww)'

const sessionApp = async (): Promise<TestApp> => makeTestApp({ NS_SESSION_KEY: 'k'.repeat(32) })

// mint = sessionsRoot.create + encodeSessionCookie — the two seams Task 3 shipped.
// The cookie exp stays +8h future for EVERY arm: the row is the truth (D-qq).
const mint = async (
  t: TestApp,
  opts: { sid?: string; rowExpiresInMs?: number; revoke?: boolean } = {}
): Promise<string> => {
  const sid = opts.sid ?? 's_1'
  const nowMs = Date.now()
  await t.deps.sessionsRoot.create({
    id: sid,
    actor_id: 'a_nils',
    csrf: 'c_1',
    created_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + (opts.rowExpiresInMs ?? 8 * HOUR)).toISOString(),
  })
  if (opts.revoke) await t.deps.sessionsRoot.revoke(sid, new Date(nowMs).toISOString())
  return encodeSessionCookie(
    { sid, exp: new Date(nowMs + 8 * HOUR).toISOString() },
    t.deps.config.sessionKey!
  )
}

describe('auth hook session arm (D-qq/D-rr/D-ww) — arms 1-10 as pinned', () => {
  it('arm 1: GET /tasks with a valid cookie (no bearer) => 200', async () => {
    const t = await sessionApp()
    const sess = await mint(t)
    const res = await t.app.inject({
      method: 'GET',
      url: '/tasks',
      headers: { cookie: `__Host-ns_sess=${sess}` },
    })
    expect(res.statusCode).toBe(200)
    await t.close()
  })

  it('arm 2: POST /tasks cookie, NO X-CSRF-Token => 403 (D-rr)', async () => {
    const t = await sessionApp()
    const sess = await mint(t)
    const res = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: `__Host-ns_sess=${sess}` },
      payload: { title: 'no csrf' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('forbidden')
    expect(res.json().detail).toBe(D_RR)
    await t.close()
  })

  it('arm 3: POST /tasks cookie + right X-CSRF-Token => 201; reads need no token', async () => {
    const t = await sessionApp()
    const sess = await mint(t)
    const post = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: `__Host-ns_sess=${sess}`, 'x-csrf-token': 'c_1' },
      payload: { title: 'with csrf', status: 'todo' },
    })
    expect(post.statusCode).toBe(201)
    expect(post.json().created_by).toBe('a_nils')
    // GET /tasks/next-style reads unaffected: no CSRF companion demanded
    const next = await t.app.inject({
      method: 'GET',
      url: '/tasks/next',
      headers: { cookie: `__Host-ns_sess=${sess}` },
    })
    expect(next.statusCode).toBe(200)
    await t.close()
  })

  it('arm 4: POST /tasks cookie + WRONG X-CSRF-Token => 403 (D-rr)', async () => {
    const t = await sessionApp()
    const sess = await mint(t)
    // same length as the row token 'c_1': reaches the timingSafeEqual false arm,
    // not just the length short-circuit (arm 2's absent-header sentinel covers that)
    const res = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie: `__Host-ns_sess=${sess}`, 'x-csrf-token': 'x_1' },
      payload: { title: 'wrong csrf' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().detail).toBe(D_RR)
    await t.close()
  })

  it('arm 5: tampered cookie, no bearer => byte-identical missing-bearer 401 (fall-through)', async () => {
    const t = await sessionApp()
    const sess = await mint(t)
    const res = await t.app.inject({
      method: 'GET',
      url: '/tasks',
      headers: { cookie: `__Host-ns_sess=${sess}x` }, // signature gate rejects
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('unauthenticated')
    expect(res.json().detail).toBe(MISSING_BEARER) // zero new strings
    await t.close()
  })

  it('arm 6: valid signature, row revoked => 401 same (revocation is the table)', async () => {
    const t = await sessionApp()
    const sess = await mint(t, { revoke: true })
    const res = await t.app.inject({
      method: 'GET',
      url: '/tasks',
      headers: { cookie: `__Host-ns_sess=${sess}` },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().detail).toBe(MISSING_BEARER)
    await t.close()
  })

  it('arm 7: valid signature, row expires_at past while cookie exp future => 401 — TABLE is truth (D-qq)', async () => {
    const t = await sessionApp()
    const sess = await mint(t, { rowExpiresInMs: -HOUR })
    const res = await t.app.inject({
      method: 'GET',
      url: '/tasks',
      headers: { cookie: `__Host-ns_sess=${sess}` },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().detail).toBe(MISSING_BEARER)
    await t.close()
  })

  it('arm 8: session GET/POST /mcp (+ subpath) => 403 D-ww; both-credentials /mcp => the SAME 403', async () => {
    const t = await sessionApp()
    const sess = await mint(t)
    for (const [method, url, headers] of [
      ['GET', '/mcp', { cookie: `__Host-ns_sess=${sess}` }],
      ['POST', '/mcp', { cookie: `__Host-ns_sess=${sess}` }],
      ['GET', '/mcp/anything', { cookie: `__Host-ns_sess=${sess}` }], // startsWith('/mcp/') arm
      // R1 precedence: cookie resolves FIRST, so the session rejection answers (D-ww)
      [
        'GET',
        '/mcp',
        { cookie: `__Host-ns_sess=${sess}`, authorization: `Bearer ${t.adminToken}` },
      ],
    ] as const) {
      const res = await t.app.inject({ method, url, headers })
      expect(res.statusCode).toBe(403)
      expect(res.headers['content-type']).toContain('application/problem+json')
      expect({ method, url, code: res.json().code, detail: res.json().detail }).toEqual({
        method,
        url,
        code: 'forbidden',
        detail: D_WW,
      })
    }
    await t.close()
  })

  it('arm 9: cookie+bearer BOTH valid => SESSION wins (arm resolves before the bearer read)', async () => {
    const t = await sessionApp()
    t.app.get('/_authvia', async (request) => ({
      authVia: request.authVia,
      sessionId: request.sessionId,
    }))
    const sess = await mint(t)
    const both = { cookie: `__Host-ns_sess=${sess}`, authorization: `Bearer ${t.adminToken}` }
    // a bearer-preferred world would answer 201 here (bearer skips CSRF) — 403 proves session won
    const noCsrf = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: both,
      payload: { title: 'x' },
    })
    expect(noCsrf.statusCode).toBe(403)
    expect(noCsrf.json().detail).toBe(D_RR)
    const withCsrf = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { ...both, 'x-csrf-token': 'c_1' },
      payload: { title: 'x' },
    })
    expect(withCsrf.statusCode).toBe(201)
    const via = await t.app.inject({ method: 'GET', url: '/_authvia', headers: both })
    expect(via.json()).toEqual({ authVia: 'session', sessionId: 's_1' })
    // bearer ALONE (no cookie header): today's byte-path untouched — no-CSRF 201
    const bearerPost = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { authorization: `Bearer ${t.adminToken}` },
      payload: { title: 'bearer no csrf' },
    })
    expect(bearerPost.statusCode).toBe(201)
    const bearerVia = await t.app.inject({
      method: 'GET',
      url: '/_authvia',
      headers: { authorization: `Bearer ${t.adminToken}` },
    })
    expect(bearerVia.json()).toEqual({ authVia: 'bearer', sessionId: null })
    await t.close()
  })

  it('arm 10: cookie present but config.sessionKey absent (default test env) => ignored, falls through', async () => {
    const t = await makeTestApp() // no NS_SESSION_KEY
    await t.deps.sessionsRoot.create({
      id: 's_1',
      actor_id: 'a_nils',
      csrf: 'c_1',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 8 * HOUR).toISOString(),
    })
    // signed with the key the OTHER app instances would use — without config.sessionKey
    // the arm cannot consult it: fail-closed fall-through, 401 exactly like arm 5
    const sess = encodeSessionCookie(
      { sid: 's_1', exp: new Date(Date.now() + 8 * HOUR).toISOString() },
      'k'.repeat(32)
    )
    const res = await t.app.inject({
      method: 'GET',
      url: '/tasks',
      headers: { cookie: `__Host-ns_sess=${sess}` },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().detail).toBe(MISSING_BEARER)
    await t.close()
  })
})

describe('D-ww second layer (mount.ts defensive arm — reachable by design)', () => {
  it('a session identity that REACHES the mcp handler answers the same pinned 403', async () => {
    const t = await sessionApp()
    // The hook arm (arm 8) fires before the handler, so the mount layer is only
    // reachable through a future hook refactor. Simulate exactly that world: a
    // LATE onRequest hook (registered after the auth chain, so it runs last)
    // stamps authVia='session' — auth's own /mcp arm cannot fire because no
    // cookie resolves. The handler's first statement must still answer D-ww.
    t.app.addHook('onRequest', async (request) => {
      request.authVia = 'session'
    })
    const res = await t.app.inject({
      method: 'GET',
      url: '/mcp',
      headers: { authorization: `Bearer ${t.adminToken}` },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('forbidden')
    expect(res.json().detail).toBe(D_WW)
    await t.close()
  })
})
