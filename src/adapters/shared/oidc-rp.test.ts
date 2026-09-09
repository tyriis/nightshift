// Task 5 (D-pp): the RP test list IS the spec — every RP leg rides the in-process
// stub IdP through inject (zero sockets); every negative is its own pin.
//
// Module freshness: discover's cache and the jwksCache are MODULE state — every
// test re-imports the module fresh (vi.resetModules) so no test inherits another
// test's discovery doc or RemoteJWKSet closure (each test's stub idp signs with
// its OWN key; a leaked jwksCache would fetch from a closed app).
import { createHash, generateKeyPairSync, sign as rsaSign } from 'node:crypto'
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import { DomainError } from '#root/domain/errors'
import { decodeSignedJson, encodeSignedJson } from '#root/adapters/shared/session-codec'
import { makeTestApp, type TestApp } from '#root/testing/test-app'
import { buildStubIdp, makeInjectFetch, type StubIdp, type StubUser } from '#root/testing/stub-idp'

const ISSUER = 'http://idp.test'
const KEY = 'k'.repeat(32)
const BASE_ENV: NodeJS.ProcessEnv = {
  NS_OIDC_ISSUER: ISSUER,
  NS_OIDC_CLIENT_ID: 'ns',
  NS_OIDC_CLIENT_SECRET: 'supersecret1',
  NS_PUBLIC_URL: 'http://board.test',
  NS_SESSION_KEY: KEY,
}

const USERS: Record<string, StubUser> = {
  alice: { sub: 'stub-alice', email: 'alice@example.test', preferred_username: 'alice' },
  nonceless: {
    sub: 'stub-nonceless',
    email: 'nonceless@example.test',
    preferred_username: 'nonceless',
    nonceAbsent: true,
  },
  nohash: {
    sub: 'stub-nohash',
    email: 'nohash@example.test',
    preferred_username: 'nohash',
    noAtHash: true,
  },
  // the expired arm signs exp-120s (fix4): exp-10s sits inside clockTolerance 60
  expired: {
    sub: 'stub-expired',
    email: 'expired@example.test',
    preferred_username: 'expired',
    expOffsetS: -120,
  },
  unverified: {
    sub: 'stub-unverified',
    email: 'unverified@example.test',
    preferred_username: 'unverified',
    email_verified: false,
  },
}

type Rp = typeof import('#root/adapters/shared/oidc-rp')
let rp!: Rp
const CLEANUP: Array<() => Promise<void>> = []

beforeEach(async () => {
  vi.resetModules()
  rp = await import('#root/adapters/shared/oidc-rp')
})

afterEach(async () => {
  vi.useRealTimers()
  for (const c of CLEANUP.splice(0)) await c()
})

// helper: makeOidcApp(userKey='alice', mutateEnv?) → { t, idp, log, fetch, runFlow }
const makeOidcApp = async (
  userKey = 'alice',
  mutateEnv?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv
) => {
  const env = mutateEnv ? mutateEnv({ ...BASE_ENV }) : { ...BASE_ENV }
  const idp = buildStubIdp({
    issuer: env.NS_OIDC_ISSUER as string,
    clientId: env.NS_OIDC_CLIENT_ID as string,
    ...(env.NS_OIDC_CLIENT_SECRET ? { clientSecret: env.NS_OIDC_CLIENT_SECRET } : {}),
    redirectUris: [`${env.NS_PUBLIC_URL}/auth/callback`],
    users: USERS,
  })
  const log: string[] = []
  const fetchFn = makeInjectFetch(env.NS_OIDC_ISSUER as string, idp.app, log)
  const t = await makeTestApp(env, fetchFn)
  CLEANUP.push(async () => {
    await t.close()
    await idp.app.close()
  })
  const authorizeOnly = async () => {
    const { url, flow } = rp.buildAuthorize(t.deps, '/ui/')
    const res = await idp.app.inject({
      method: 'GET',
      url: `${url.slice(ISSUER.length)}&login_hint=${userKey}`,
    })
    expect(res.statusCode).toBe(302)
    const loc = new URL(res.headers.location as string)
    expect(loc.searchParams.get('state')).toBe(flow.state) // the browser-side echo check
    expect(loc.searchParams.get('iss')).toBe(ISSUER) // RFC 9207
    return { flow, code: String(loc.searchParams.get('code')) }
  }
  const runFlow = async () => {
    const { flow, code } = await authorizeOnly()
    const tokens = await rp.exchangeCode(t.deps, code, flow.verifier)
    return { flow, code, tokens }
  }
  return { t, idp, log, fetch: fetchFn, authorizeOnly, runFlow }
}

// canned (zero-network by construction) fetch for RP input-validation arms the
// stub cannot produce: non-OK/malformed discovery + token-response bodies.
const cannedFetch =
  (routes: Record<string, () => Response>): typeof globalThis.fetch =>
  async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const route = routes[url]
    if (!route) throw new Error(`canned: no route for ${url}`)
    return route()
  }

const cycled = (responses: Array<() => Response>): (() => Response) => {
  let i = 0
  return () => {
    const next = responses[i++]
    if (!next) throw new Error('canned: responses exhausted')
    return next()
  }
}

const makeCannedApp = async (routes: Record<string, () => Response>) => {
  const t = await makeTestApp(BASE_ENV)
  t.deps.fetch = cannedFetch(routes)
  CLEANUP.push(() => t.close())
  return { t }
}

const CANNED_DOC = {
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/api/oidc/token`,
  jwks_uri: `${ISSUER}/.well-known/jwks.json`,
}

const b64u = (buf: Buffer): string => buf.toString('base64url')

describe('oidc-rp (D-pp): discovery', () => {
  it('discover: doc fields + 5-min cache; second call = zero new fetches', async () => {
    const { t, log } = await makeOidcApp()
    const doc = await rp.discover(t.deps, ISSUER)
    expect(doc).toMatchObject({
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/api/oidc/token`,
      jwks_uri: `${ISSUER}/.well-known/jwks.json`,
    })
    expect(log).toEqual([`${ISSUER}/.well-known/openid-configuration`])
    expect(await rp.discover(t.deps, ISSUER)).toBe(doc) // cache — same object, zero fetches
    expect(log).toHaveLength(1)
  })

  it('discover: concurrent calls fetch ONCE (single-flight)', async () => {
    const { t, log } = await makeOidcApp()
    const [a, b] = await Promise.all([rp.discover(t.deps, ISSUER), rp.discover(t.deps, ISSUER)])
    expect(a).toEqual(b)
    expect(log).toHaveLength(1) // a stampede of unknown-kid logins fetches ONCE
  })

  it('discover: cache is fresh at +4min (zero fetches), refetches past the 5-min TTL', async () => {
    const { t, log } = await makeOidcApp()
    const d1 = await rp.discover(t.deps, ISSUER)
    const base = Date.now()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(base + 240_000)
    expect(await rp.discover(t.deps, ISSUER)).toBe(d1)
    expect(log).toHaveLength(1)
    vi.setSystemTime(base + 360_000)
    const d2 = await rp.discover(t.deps, ISSUER)
    expect(log).toHaveLength(2)
    expect(d2).toEqual(d1)
    expect(d2).not.toBe(d1) // refetched, not the stale object
  })

  it('discover: failure AFTER a cached entry keeps the cached doc (rollback arm)', async () => {
    const { t, log } = await makeOidcApp()
    const d1 = await rp.discover(t.deps, ISSUER)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 360_000) // past the TTL ⇒ refetch path
    t.deps.fetch = cannedFetch({}) // every URL refused ⇒ the refetch 500-arm below
    t.deps.fetch = async () => Response.json({ error: 'down' }, { status: 503 })
    await expect(rp.discover(t.deps, ISSUER)).rejects.toThrow(/oidc discovery failed: 503/)
    vi.useRealTimers() // real "now" is ~T0 again ⇒ restored entry is fresh
    // with the FAILED rollback (delete) instead of the restored entry, this would
    // reach the broken fetch and throw — resolving proves the stale-hit restore.
    expect(await rp.discover(t.deps, ISSUER)).toBe(d1)
    expect(log).toHaveLength(1) // neither the failed refetch (canned) nor the hit fetched
  })

  it('discover: non-OK answer ⇒ /oidc discovery failed: 500/ (delete arm — next call retries)', async () => {
    const { t } = await makeCannedApp({
      'http://broken.test/.well-known/openid-configuration': () =>
        Response.json({ error: 'boom' }, { status: 500 }),
    })
    await expect(rp.discover(t.deps, 'http://broken.test')).rejects.toThrow(
      /oidc discovery failed: 500/
    )
    await expect(rp.discover(t.deps, 'http://broken.test')).rejects.toThrow(
      /oidc discovery failed: 500/
    ) // cache deleted — it tried AGAIN, not a poisoned entry
  })

  it('discover: missing endpoints — each of the three fields is enforced', async () => {
    const { t } = await makeCannedApp({
      'http://b1.test/.well-known/openid-configuration': () =>
        Response.json({ token_endpoint: 'x', jwks_uri: 'y' }),
      'http://b2.test/.well-known/openid-configuration': () =>
        Response.json({ authorization_endpoint: 'x', jwks_uri: 'y' }),
      'http://b3.test/.well-known/openid-configuration': () =>
        Response.json({ authorization_endpoint: 'x', token_endpoint: 'y' }),
    })
    for (const issuer of ['http://b1.test', 'http://b2.test', 'http://b3.test']) {
      await expect(rp.discover(t.deps, issuer)).rejects.toThrow(/oidc discovery: missing endpoints/)
    }
  })
})

describe('oidc-rp (D-pp): authorize request', () => {
  it('buildAuthorize: exact query set, S256 challenge, flow envelope round-trip, exp=now+600s', async () => {
    const { t } = await makeOidcApp()
    const { url, flow } = rp.buildAuthorize(t.deps, '/ui/tasks/NS-1')
    expect(url.startsWith(`${ISSUER}/authorize?`)).toBe(true)
    const q = Object.fromEntries(new URL(url).searchParams)
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
      redirect_uri: 'http://board.test/auth/callback', // EXACT (the stub enforces)
      scope: 'openid profile email',
      state: flow.state,
      nonce: flow.nonce,
      code_challenge_method: 'S256',
    })
    expect(q.code_challenge).toBe(
      b64u(createHash('sha256').update(flow.verifier, 'ascii').digest())
    )
    // the flow cookie (Task 7) rides the signed envelope and decodes to the SAME triplet
    const raw = encodeSignedJson(flow, KEY)
    expect(decodeSignedJson(raw, KEY, new Date().toISOString(), rp.isOidcFlow)).toEqual(flow)
    expect(Math.abs(Date.parse(flow.exp) - (Date.now() + 600_000))).toBeLessThan(5_000)
  })

  it('flow validate: rejects a signed payload missing ANY flow member and an expired exp', async () => {
    const { t } = await makeOidcApp()
    const { flow } = rp.buildAuthorize(t.deps, '/ui/')
    const nowIso = new Date().toISOString()
    for (const member of ['state', 'nonce', 'verifier', 'returnTo'] as const) {
      const broken = { ...flow } as Record<string, unknown>
      delete broken[member]
      expect(decodeSignedJson(encodeSignedJson(broken, KEY), KEY, nowIso, rp.isOidcFlow)).toBeNull()
    }
    const stale = { ...flow, exp: new Date(Date.now() - 1_000).toISOString() }
    expect(decodeSignedJson(encodeSignedJson(stale, KEY), KEY, nowIso, rp.isOidcFlow)).toBeNull()
  })
})

describe('oidc-rp (D-pp): token exchange', () => {
  it('exchangeCode: form-encodes body incl. client_secret; returns {access_token, id_token}', async () => {
    const { t, runFlow } = await makeOidcApp()
    const { tokens } = await runFlow()
    expect(typeof tokens.access_token).toBe('string')
    expect(typeof tokens.id_token).toBe('string')
    // the secret rode the BODY (client_secret_post — never the URL): the stub's
    // invalid_client arm proves it server-side (next test).
    expect(t.deps.config.oidcClientSecret).toBeTruthy()
  })

  it('exchangeCode: client_secret mismatch ⇒ 401 arm ⇒ /token exchange failed: 401/', async () => {
    const { t, authorizeOnly } = await makeOidcApp()
    const { flow, code } = await authorizeOnly()
    t.deps.config.oidcClientSecret = 'wrongsecret2'
    await expect(rp.exchangeCode(t.deps, code, flow.verifier)).rejects.toThrow(
      /token exchange failed: 401/
    )
  })

  it('exchangeCode: public client — no secret configured ⇒ form omits client_secret, exchange succeeds', async () => {
    const { runFlow } = await makeOidcApp('alice', (env) => {
      delete env.NS_OIDC_CLIENT_SECRET
      return env
    })
    const { tokens } = await runFlow()
    expect(tokens.id_token.split('.')).toHaveLength(3)
  })

  it('exchangeCode: PKCE verifier mismatch ⇒ 400 ⇒ plain Error(/token exchange failed/), NEVER a DomainError', async () => {
    const { t, authorizeOnly } = await makeOidcApp()
    const { code } = await authorizeOnly()
    const err = await rp.exchangeCode(t.deps, code, 'x'.repeat(43)).then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(DomainError) // generic Error ⇒ 500 internal_error (D-tt/D-pp)
    expect((err as Error).message).toMatch(/token exchange failed: 400/)
  })

  it('exchangeCode: response gates — malformed body, unexpected token_type, DPoP accepted', async () => {
    const { t } = await makeCannedApp({
      [`${ISSUER}/.well-known/openid-configuration`]: () => Response.json(CANNED_DOC),
      [`${ISSUER}/api/oidc/token`]: cycled([
        () => Response.json({ access_token: 42, id_token: 'x', token_type: 'Bearer' }),
        () => Response.json({ access_token: 'a', id_token: 'b', token_type: 'Mac' }),
        () => Response.json({ access_token: 'a', id_token: 'b', token_type: 'DPoP' }),
      ]),
    })
    await expect(rp.exchangeCode(t.deps, 'c', 'v')).rejects.toThrow(
      /token exchange failed: malformed response/
    )
    await expect(rp.exchangeCode(t.deps, 'c', 'v')).rejects.toThrow(
      /token exchange failed: unexpected token_type/
    )
    await expect(rp.exchangeCode(t.deps, 'c', 'v')).resolves.toEqual({
      access_token: 'a',
      id_token: 'b',
    })
  })
})

describe('oidc-rp (D-pp): id_token verification', () => {
  it('verifyIdToken: green path claims ride out; second verify = zero new fetches (jwks cache hit)', async () => {
    const { t, log, runFlow } = await makeOidcApp()
    const { flow, tokens } = await runFlow()
    expect(log).toEqual([`${ISSUER}/.well-known/openid-configuration`, `${ISSUER}/api/oidc/token`])
    const claims = await rp.verifyIdToken(t.deps, tokens.id_token, flow.nonce, tokens.access_token)
    expect(claims).toEqual({
      sub: 'stub-alice',
      email: 'alice@example.test',
      email_verified: true,
      preferred_username: 'alice',
    })
    expect(log).toHaveLength(3) // discovery was cached; the jwks fetch is the third URL
    expect(log[2]).toBe(`${ISSUER}/.well-known/jwks.json`)
    // remoteJwks cache hit AND jose's own key cache: nothing new goes out
    expect(
      await rp.verifyIdToken(t.deps, tokens.id_token, flow.nonce, tokens.access_token)
    ).toEqual(claims)
    expect(log).toHaveLength(3)
  })

  it('verifyIdToken: bad nonce ⇒ throws', async () => {
    const { t, runFlow } = await makeOidcApp()
    const { flow, tokens } = await runFlow()
    await expect(
      rp.verifyIdToken(t.deps, tokens.id_token, `${flow.nonce}x`, tokens.access_token)
    ).rejects.toThrow(/id_token nonce mismatch/)
  })

  it('verifyIdToken: nonce absent from the token (unconfirmed-echo arm) ⇒ throws', async () => {
    const { t, runFlow } = await makeOidcApp('nonceless')
    const { flow, tokens } = await runFlow()
    await expect(
      rp.verifyIdToken(t.deps, tokens.id_token, flow.nonce, tokens.access_token)
    ).rejects.toThrow(/id_token nonce mismatch/)
  })

  it('verifyIdToken: tampered payload (real signature, swapped claims) ⇒ throws', async () => {
    const { t, runFlow } = await makeOidcApp()
    const { flow, tokens } = await runFlow()
    const [h, , s] = tokens.id_token.split('.')
    const claims = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString())
    claims.sub = 'mallory'
    const forged = `${h}.${b64u(Buffer.from(JSON.stringify(claims), 'utf8'))}.${s}`
    await expect(
      rp.verifyIdToken(t.deps, forged, flow.nonce, tokens.access_token)
    ).rejects.toThrow()
  })

  it('verifyIdToken: alg none hand-compacted ⇒ jose refuses outside the RS256 allow-list', async () => {
    const { t, runFlow } = await makeOidcApp()
    const { flow, tokens } = await runFlow()
    const [, p] = tokens.id_token.split('.')
    const none = `${b64u(Buffer.from(JSON.stringify({ alg: 'none', kid: 'stub-key-1' }), 'utf8'))}.${p}.`
    await expect(rp.verifyIdToken(t.deps, none, flow.nonce, tokens.access_token)).rejects.toThrow(
      /alg|none/i
    )
  })

  it('verifyIdToken: id_token signed with an unknown kid ⇒ throws', async () => {
    const { t, idp } = await makeOidcApp()
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const now = Math.floor(Date.now() / 1000)
    const input = `${b64u(
      Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'rogue-key-9' }), 'utf8')
    )}.${b64u(
      Buffer.from(
        JSON.stringify({
          iss: ISSUER,
          sub: 'stub-rogue',
          aud: 'ns',
          iat: now,
          exp: now + 300,
          nonce: 'sign-nonce',
        }),
        'utf8'
      )
    )}`
    const rogue = `${input}.${b64u(rsaSign('sha256', Buffer.from(input, 'utf8'), privateKey))}`
    await expect(rp.verifyIdToken(t.deps, rogue, 'sign-nonce', '')).rejects.toThrow(/kid|key/i)
    // sanity: the SAME jose stack accepts the real key — the failure was the kid
    expect(idp.key.kid).toBe('stub-key-1')
  })

  it('verifyIdToken: expired id_token (stub signs exp-120s > clockTolerance 60) ⇒ throws', async () => {
    const { t, runFlow } = await makeOidcApp('expired')
    const { flow, tokens } = await runFlow()
    await expect(
      rp.verifyIdToken(t.deps, tokens.id_token, flow.nonce, tokens.access_token)
    ).rejects.toThrow(/exp/i)
  })

  it('verifyIdToken: aud mismatch (stub re-signed for another client) ⇒ throws', async () => {
    const { t, idp } = await makeOidcApp()
    const forged = idp.signIdToken({ aud: 'someone-else' })
    await expect(rp.verifyIdToken(t.deps, forged, 'sign-nonce', '')).rejects.toThrow(/aud/i)
  })

  it('verifyIdToken: iss mismatch ⇒ throws', async () => {
    const { t, idp } = await makeOidcApp()
    const forged = idp.signIdToken({ iss: 'http://evil.test' })
    await expect(rp.verifyIdToken(t.deps, forged, 'sign-nonce', '')).rejects.toThrow(/iss/i)
  })

  it('verifyIdToken: at_hash missing (noAtHash user) ⇒ throws', async () => {
    const { t, runFlow } = await makeOidcApp('nohash')
    const { flow, tokens } = await runFlow()
    await expect(
      rp.verifyIdToken(t.deps, tokens.id_token, flow.nonce, tokens.access_token)
    ).rejects.toThrow(/id_token missing at_hash/)
  })

  it('verifyIdToken: at_hash wrong (equal-length flip — the timingSafeEqual-false arm) ⇒ throws', async () => {
    const { t, idp } = await makeOidcApp()
    const accessToken = 'at.equal-length-flip'
    const good = b64u(createHash('sha256').update(accessToken, 'ascii').digest().subarray(0, 16))
    const flipped = (good[0] === 'A' ? 'B' : 'A') + good.slice(1)
    const forged = idp.signIdToken({ at_hash: flipped }, accessToken)
    await expect(rp.verifyIdToken(t.deps, forged, 'sign-nonce', accessToken)).rejects.toThrow(
      /id_token at_hash mismatch/
    )
  })

  it('verifyIdToken: sub missing or empty ⇒ throws', async () => {
    const { t, idp } = await makeOidcApp()
    await expect(
      rp.verifyIdToken(t.deps, idp.signIdToken({ sub: null }), 'sign-nonce', '')
    ).rejects.toThrow(/id_token missing sub/)
    await expect(
      rp.verifyIdToken(t.deps, idp.signIdToken({ sub: '' }), 'sign-nonce', '')
    ).rejects.toThrow(/id_token missing sub/)
  })

  it('verifyIdToken: minimal claims — absent email/preferred_username ride undefined, email_verified false', async () => {
    const { t, idp } = await makeOidcApp()
    const accessToken = 'at-minimal'
    const tok = idp.signIdToken(
      { sub: 'stub-minimal', email: null, preferred_username: null, email_verified: false },
      accessToken
    )
    await expect(rp.verifyIdToken(t.deps, tok, 'sign-nonce', accessToken)).resolves.toEqual({
      sub: 'stub-minimal',
      email: undefined,
      email_verified: false,
      preferred_username: undefined,
    })
  })
})

describe('makeInjectFetch (D-pp zero-network pin)', () => {
  it('refuses ANY non-issuer URL — no socket, no fallthrough (tonight’s guarantee)', async () => {
    const { idp, log, fetch } = await makeOidcApp()
    await expect(fetch('https://niflheim.example/token')).rejects.toThrow(
      /refusing non-issuer fetch/
    )
    await expect(fetch(new URL('http://169.254.169.254/latest/meta-data'))).rejects.toThrow(
      /refusing non-issuer fetch/
    )
    await expect(
      fetch('https://evil.example/x', {
        method: 'POST',
        body: new URLSearchParams({ a: 'b' }),
      })
    ).rejects.toThrow(/refusing non-issuer fetch/)
    expect(log).toHaveLength(3) // every attempted URL is logged, then refused
  })
})
