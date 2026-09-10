// D-pp: the OIDC relying-party core. Every HTTP egress goes through deps.fetch
// (tests: inject-backed, zero sockets). jose owns JWT verification (MIT, 0-dep,
// RFC 8725bis-conformant); at_hash + nonce are OURS (jose verifies neither).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createRemoteJWKSet, customFetch } from 'jose/jwks/remote'
import { jwtVerify } from 'jose/jwt/verify'
import type { AppDeps } from '#root/main/deps'

export interface OidcDiscovery {
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
}

// raw Date.now like rate-limit.ts (throttling decides on real elapsed time, T14 note).
const DISCOVERY_TTL_MS = 300_000
const cache = new Map<
  string,
  { doc: OidcDiscovery; fetchedAt: number; inflight?: Promise<OidcDiscovery> }
>()
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

export const discover = async (deps: AppDeps, issuer: string): Promise<OidcDiscovery> => {
  const hit = cache.get(issuer)
  if (hit && Date.now() - hit.fetchedAt < DISCOVERY_TTL_MS) return hit.doc
  if (hit?.inflight) return hit.inflight // single-flight: a stampede of unknown-kid logins fetches ONCE
  const inflight = (async (): Promise<OidcDiscovery> => {
    const res = await deps.fetch(`${issuer}/.well-known/openid-configuration`, {
      headers: { accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`oidc discovery failed: ${res.status}`)
    const doc = (await res.json()) as OidcDiscovery
    if (
      typeof doc.authorization_endpoint !== 'string' ||
      typeof doc.token_endpoint !== 'string' ||
      typeof doc.jwks_uri !== 'string'
    )
      throw new Error('oidc discovery: missing endpoints')
    cache.set(issuer, { doc, fetchedAt: Date.now() })
    return doc
  })()
  cache.set(issuer, {
    doc:
      hit?.doc ??
      ({ authorization_endpoint: '', token_endpoint: '', jwks_uri: '' } as OidcDiscovery),
    fetchedAt: hit?.fetchedAt ?? 0,
    inflight,
  })
  try {
    return await inflight
  } catch (e) {
    if (hit) cache.set(issuer, hit)
    else cache.delete(issuer)
    throw e
  }
}

const remoteJwks = (deps: AppDeps, jwksUri: string): ReturnType<typeof createRemoteJWKSet> => {
  let set = jwksCache.get(jwksUri)
  if (!set) {
    set = createRemoteJWKSet(new URL(jwksUri), {
      // PROBED (jose@6.2.12, P1/fix1): the fetch seam is the exported customFetch
      // symbol — a plain `fetch` option key does not exist and is silently IGNORED
      // (jose would fall through to globalThis.fetch and open real sockets in tests).
      [customFetch]: (url, options) => deps.fetch(url, options),
    })
    jwksCache.set(jwksUri, set)
  }
  return set
}

export interface OidcFlow {
  state: string
  nonce: string
  verifier: string
  returnTo: string
  exp: string
}

/**
 * Task 5's Step-2 duty (the codec pair shipped in Task 3): the flow-cookie
 * `validate` riding decodeSignedJson — decodeSignedJson already enforces the
 * exp:string-future outer bound; this guard owns the rest of the shape.
 */
export const isOidcFlow = (v: unknown): v is OidcFlow => {
  const f = v as OidcFlow
  return (
    typeof f.state === 'string' &&
    typeof f.nonce === 'string' &&
    typeof f.verifier === 'string' &&
    typeof f.returnTo === 'string'
  )
}

const rnd = (): string => randomBytes(32).toString('base64url')
const s256 = (verifier: string): string =>
  createHash('sha256').update(verifier, 'ascii').digest('base64url')

export const buildAuthorize = (
  deps: AppDeps,
  returnTo: string
): { url: string; flow: OidcFlow } => {
  const cfg = deps.config // narrowed by oidcEnabled at the route (Task 7) — rp keeps the raw config
  const flow: OidcFlow = {
    state: rnd(),
    nonce: rnd(),
    verifier: rnd(),
    returnTo,
    // flow expiry = now + 600s via the Clock port (the block's naive exp line
    // superseded at first run — Task 5 byte-sync amendment)
    exp: new Date(deps.clock.now().getTime() + 600_000).toISOString(),
  }
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.oidcClientId as string,
    redirect_uri: `${cfg.publicUrl}/auth/callback`,
    scope: cfg.oidcScope,
    state: flow.state,
    nonce: flow.nonce,
    code_challenge_method: 'S256',
    code_challenge: s256(flow.verifier),
  })
  return { url: `${deps.config.oidcIssuer}/authorize?${q}`, flow }
}

export interface OidcTokenSet {
  access_token: string
  id_token: string
}
export const exchangeCode = async (
  deps: AppDeps,
  code: string,
  verifier: string
): Promise<OidcTokenSet> => {
  const doc = await discover(deps, deps.config.oidcIssuer as string)
  const cfg = deps.config
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: `${cfg.publicUrl}/auth/callback`,
    client_id: cfg.oidcClientId as string,
    code_verifier: verifier,
  })
  if (cfg.oidcClientSecret) form.set('client_secret', cfg.oidcClientSecret) // D-ff: body-only, never the URL
  const res = await deps.fetch(doc.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form,
  })
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`) // generic Error ⇒ 500 internal_error (pinned test)
  const body = (await res.json()) as Partial<OidcTokenSet> & { token_type?: string }
  if (typeof body.access_token !== 'string' || typeof body.id_token !== 'string')
    throw new Error('token exchange failed: malformed response')
  if (body.token_type !== 'Bearer' && body.token_type !== 'DPoP')
    throw new Error('token exchange failed: unexpected token_type')
  return { access_token: body.access_token, id_token: body.id_token }
}

export interface IdClaims {
  sub: string
  email?: string
  email_verified?: boolean
  preferred_username?: string
}
// at_hash digest follows the SIGNING alg (Pocket ID derives it the same way).
// Under the pinned algorithms:['RS256'] allow-list the only reachable key IS
// 'RS256' — jwtVerify rejects every other alg upstream, so the block's defensive
// `!hash` arm is unsatisfiable (Task 5 amendment: it ships without that arm).
const ALG_HASH: Record<string, 'sha256' | 'sha384' | 'sha512'> = {
  RS256: 'sha256',
  RS384: 'sha384',
  RS512: 'sha512',
}
const eq = (a: string, b: string): boolean => {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

export const verifyIdToken = async (
  deps: AppDeps,
  idToken: string,
  expectedNonce: string,
  accessToken: string
): Promise<IdClaims> => {
  const cfg = deps.config
  const doc = await discover(deps, cfg.oidcIssuer as string)
  // D-pp: algorithms PINNED — allow-list, never derived from the token (RFC 8725bis).
  const { payload, protectedHeader } = await jwtVerify(idToken, remoteJwks(deps, doc.jwks_uri), {
    issuer: cfg.oidcIssuer,
    audience: cfg.oidcClientId,
    algorithms: ['RS256'],
    clockTolerance: 60,
  })
  if (typeof payload.nonce !== 'string' || !eq(payload.nonce, expectedNonce))
    throw new Error('id_token nonce mismatch')
  const hash = ALG_HASH[protectedHeader.alg] // alg IS 'RS256' here — the pinned allow-list rejects the rest
  if (typeof payload.at_hash !== 'string') throw new Error('id_token missing at_hash')
  const digest = createHash(hash).update(accessToken, 'ascii').digest()
  if (!eq(payload.at_hash, digest.subarray(0, digest.length / 2).toString('base64url')))
    throw new Error('id_token at_hash mismatch')
  if (typeof payload.sub !== 'string' || payload.sub.length === 0)
    throw new Error('id_token missing sub')
  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    email_verified: payload.email_verified === true,
    preferred_username:
      typeof payload.preferred_username === 'string' ? payload.preferred_username : undefined,
  }
}
