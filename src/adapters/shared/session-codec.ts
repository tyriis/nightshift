// D-qq: signed envelope cookie codec — pure crypto + strings, no db, no fastify.
// The TABLE is the revocation truth; the cookie is a signed pointer that cannot
// outlive its own signed exp (OWASP session-management: sid>=128-bit entropy,
// expiry inside the payload, constant-time verify, __Host- prefix).
import { createHmac, timingSafeEqual } from 'node:crypto'

export interface SessionCookieValue {
  sid: string
  exp: string // ISO — the OUTER bound; the sessions row is authoritative (D-qq)
}

const mac = (payload: string, key: string): string =>
  createHmac('sha256', key).update(payload, 'utf8').digest('base64url')

// Generic signed-JSON envelope — the ONE payload.sig pair (Task 5's planned
// refactor, landed early per the dispatch); the session functions below DELEGATE.
// The OIDC callback flow cookie ({state, nonce, verifier, returnTo, exp}) rides
// the same envelope, so the crypto/verify/parse path exists exactly once.
export const encodeSignedJson = (obj: object, key: string): string => {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url')
  return `${payload}.${mac(payload, key)}`
}

/**
 * Constant-time verify BEFORE any parse (D-qq garbage-reject), then the shape
 * gate. Every Plan E signed payload carries `exp` — the outer bound — so the
 * generic decode enforces exp:string + exp>now (ISO sorts lexicographically);
 * `validate` owns the rest of the shape. A signed non-object (e.g. `null`)
 * is rejected, never dereferenced.
 */
export const decodeSignedJson = <T>(
  raw: string,
  key: string,
  nowIso: string,
  validate: (v: unknown) => v is T
): T | null => {
  const dot = raw.lastIndexOf('.')
  if (dot < 1) return null
  const payload = raw.slice(0, dot)
  const want = Buffer.from(mac(payload, key), 'utf8')
  const got = Buffer.from(raw.slice(dot + 1), 'utf8')
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  let v: unknown
  try {
    v = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const e = (v as { exp: unknown }).exp
  if (typeof e !== 'string' || e <= nowIso) return null
  return validate(v) ? v : null
}

const isSessionCookieValue = (v: unknown): v is SessionCookieValue => {
  const c = v as SessionCookieValue
  return typeof c.sid === 'string' && typeof c.exp === 'string'
}

export const encodeSessionCookie = (v: SessionCookieValue, key: string): string =>
  encodeSignedJson(v, key)

export const decodeSessionCookie = (
  raw: string,
  key: string,
  nowIso: string
): SessionCookieValue | null => decodeSignedJson(raw, key, nowIso, isSessionCookieValue)

// Byte-pinned attribute strings (D-rr companion leg is deliberately NOT HttpOnly —
// the SPA must read it into X-CSRF-Token). __Host- demands Secure+Path=/+no Domain;
// on inject the attributes ride as inert strings — homelab runs behind https.
const ATTRS = 'Secure; SameSite=Lax; Path=/'
export const sessionCookieSet = (
  v: SessionCookieValue,
  ttlS: number,
  csrf: string,
  key: string
): [session: string, csrf: string] => [
  `__Host-ns_sess=${encodeSessionCookie(v, key)}; HttpOnly; ${ATTRS}; Max-Age=${ttlS}`,
  `__Host-ns_csrf=${csrf}; ${ATTRS}; Max-Age=${ttlS}`,
]

export const clearSessionCookies = (): [session: string, csrf: string] => [
  `__Host-ns_sess=; HttpOnly; ${ATTRS}; Max-Age=0`,
  `__Host-ns_csrf=; ${ATTRS}; Max-Age=0`,
]

export const parseCookies = (header: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const pair = part.trim()
    const eq = pair.indexOf('=')
    if (eq < 1) continue
    const name = pair.slice(0, eq)
    if (!(name in out)) out[name] = pair.slice(eq + 1) // first wins (RFC 6265 §5.4)
  }
  return out
}
