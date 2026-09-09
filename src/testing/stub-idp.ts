// D-pp test harness: the in-process stub IdP (Task 5). Test-side ONLY —
// src/testing/** is coverage-excluded, but lint and typecheck DO apply here.
// Deliberately NOT jose: it hand-rolls the compact JWS with node:crypto so the
// RP's jose stays the SOLE verifier under test. Zero sockets: every RP call
// reaches it through makeInjectFetch (fastify inject).
import { createHash, generateKeyPairSync, randomBytes, sign as rsaSign } from 'node:crypto'
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify'

export interface StubUser {
  sub: string
  email: string
  preferred_username: string
  email_verified?: boolean // default true
  nonceAbsent?: boolean // Pocket-ID unconfirmed-echo arm: id_token drops nonce
  noAtHash?: boolean // omit at_hash entirely
  expOffsetS?: number // sign exp = now + offset (negative ⇒ expired token)
}

export interface StubIdpOptions {
  issuer: string
  clientId: string
  clientSecret?: string
  redirectUris: string[]
  users: Record<string, StubUser>
}

export interface StubIdp {
  app: FastifyInstance
  key: { kid: string; publicJwk: Record<string, unknown> }
  /**
   * Re-sign an id_token with the REAL stub key. Every negative arm must fail the
   * CHECK IT PINS (iss, aud, at_hash, exp, sub …), never die at the signature
   * gate — so arm tests re-sign rather than hand-forge. Defaults mirror a green
   * token; `null` deletes a claim; the at_hash default derives from `accessToken`.
   */
  signIdToken(overrides?: Record<string, unknown>, accessToken?: string): string
}

const b64u = (buf: Buffer): string => buf.toString('base64url')
const jw = (obj: object): string => b64u(Buffer.from(JSON.stringify(obj), 'utf8'))
const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'ascii').digest()
const atHash = (accessToken: string): string => b64u(sha256(accessToken).subarray(0, 16)) // left-128-bit

const KID = 'stub-key-1'

export const buildStubIdp = (opts: StubIdpOptions): StubIdp => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const publicJwk = {
    ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
    alg: 'RS256',
    kid: KID,
    use: 'sig',
  }
  const codes = new Map<
    string,
    { userKey: string; challenge: string; nonce: string; redirectUri: string }
  >()

  const compactSign = (header: object, claims: object): string => {
    const input = `${jw(header)}.${jw(claims)}`
    return `${input}.${b64u(rsaSign('sha256', Buffer.from(input, 'utf8'), privateKey))}`
  }

  const app = Fastify({ logger: false })
  // fastify@5.12.3 has NO built-in urlencoded parser (preflight P2/fix2) — without
  // this registration every token POST answers 415 FST_ERR_CTP_INVALID_MEDIA_TYPE.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body))))
  )

  app.get('/.well-known/openid-configuration', () => ({
    issuer: opts.issuer, // string-equality (D-pp)
    authorization_endpoint: `${opts.issuer}/authorize`,
    token_endpoint: `${opts.issuer}/api/oidc/token`,
    jwks_uri: `${opts.issuer}/.well-known/jwks.json`,
    id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'],
  }))

  app.get('/.well-known/jwks.json', () => ({ keys: [publicJwk] }))

  app.get('/authorize', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>
    const userKey = q.login_hint
    if (
      q.client_id !== opts.clientId ||
      !q.redirect_uri ||
      !opts.redirectUris.includes(q.redirect_uri) || // EXACT match
      q.code_challenge_method !== 'S256' ||
      !q.state ||
      !q.nonce ||
      !q.code_challenge ||
      !userKey ||
      !opts.users[userKey] // test-only leg: login_hint picks the user
    ) {
      return reply.code(400).send({ error: 'invalid_request' })
    }
    const code = b64u(randomBytes(16))
    codes.set(code, {
      userKey,
      challenge: q.code_challenge,
      nonce: q.nonce,
      redirectUri: q.redirect_uri,
    })
    // RFC 9207: iss rides the authorization redirect
    const loc = `${q.redirect_uri}?${new URLSearchParams({ code, state: q.state, iss: opts.issuer })}`
    return reply.code(302).header('location', loc).send()
  })

  app.post('/api/oidc/token', async (request, reply) => {
    const form = request.body as Record<string, string | undefined>
    const code = form.code
    const entry = code ? codes.get(code) : undefined
    if (
      !code ||
      !entry ||
      form.grant_type !== 'authorization_code' ||
      form.redirect_uri !== entry.redirectUri ||
      form.client_id !== opts.clientId
    ) {
      return reply.code(400).send({ error: 'invalid_grant' })
    }
    codes.delete(code) // single-use, success or error (RFC 6749 §4.1.2)
    if (opts.clientSecret && form.client_secret !== opts.clientSecret) {
      return reply.code(401).send({ error: 'invalid_client' })
    }
    const verifier = form.code_verifier
    if (!verifier || b64u(sha256(verifier)) !== entry.challenge) {
      return reply.code(400).send({ error: 'invalid_grant' })
    }
    const user = opts.users[entry.userKey]
    const now = Math.floor(Date.now() / 1000)
    const access = b64u(randomBytes(24))
    const claims: Record<string, unknown> = {
      iss: opts.issuer,
      sub: user.sub,
      aud: opts.clientId,
      iat: now,
      exp: now + (user.expOffsetS ?? 300),
      ...(user.nonceAbsent ? {} : { nonce: entry.nonce }),
      email: user.email,
      email_verified: user.email_verified ?? true,
      preferred_username: user.preferred_username,
      ...(user.noAtHash ? {} : { at_hash: atHash(access) }),
    }
    const idToken = compactSign({ alg: 'RS256', kid: KID }, claims)
    return { access_token: access, token_type: 'Bearer', expires_in: 300, id_token: idToken }
  })

  const signIdToken = (overrides: Record<string, unknown> = {}, accessToken = ''): string => {
    const now = Math.floor(Date.now() / 1000)
    const claims: Record<string, unknown> = {
      iss: opts.issuer,
      sub: 'stub-signed',
      aud: opts.clientId,
      iat: now,
      exp: now + 300,
      nonce: 'sign-nonce',
      email: 'signer@example.test',
      email_verified: true,
      preferred_username: 'signer',
      at_hash: atHash(accessToken),
      ...overrides,
    }
    for (const key of Object.keys(claims)) if (claims[key] === null) delete claims[key]
    return compactSign({ alg: 'RS256', kid: KID }, claims)
  }

  return { app, key: { kid: KID, publicJwk }, signIdToken }
}

/**
 * THE zero-network pin (D-pp): every RP egress URL must start with the issuer;
 * anything else THROWS instead of touching a socket. Response adaptors are the
 * Plan-D client-smoke shape (rawPayload→Uint8Array + header entries String-joined).
 */
export const makeInjectFetch =
  (issuer: string, idp: FastifyInstance, log: string[] = []): typeof globalThis.fetch =>
  async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    log.push(url)
    if (!url.startsWith(issuer)) throw new Error(`stub-idp: refusing non-issuer fetch ${url}`)
    // jose's customFetch hands a Headers INSTANCE (types.d: FetchImplementation) —
    // light-my-request wants a plain object, so normalize before inject.
    const headers =
      init?.headers instanceof Headers
        ? Object.fromEntries(init.headers)
        : ((init?.headers as Record<string, string> | undefined) ?? {})
    const res = await idp.inject({
      method: (init?.method ?? 'GET') as InjectOptions['method'],
      url: url.slice(issuer.length) || '/',
      headers,
      payload:
        typeof init?.body === 'string'
          ? init.body
          : init?.body instanceof URLSearchParams
            ? init.body.toString() // fix3: exchangeCode posts `body: form` (URLSearchParams)
            : undefined,
    })
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(res.headers)) {
      out[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '')
    }
    return new Response(new Uint8Array(res.rawPayload), { status: res.statusCode, headers: out })
  }
