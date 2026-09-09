import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { timingSafeEqual } from 'node:crypto'
import type { AppDeps } from '#root/main/deps'
import type { ActorRef } from '#root/application/ports'
// sanctioned pure-util import (plan ruling): token-hash is node:crypto-only, no infra coupling
import { hashToken } from '#root/infra/token-hash'
import { parseCookies, decodeSessionCookie } from '#root/adapters/shared/session-codec'
import { MUTATING } from '#root/adapters/rest/idempotency'
import { DomainError } from '#root/domain/errors'

declare module 'fastify' {
  interface FastifyRequest {
    actorRef: ActorRef | null
    tokenId: string | null
    idemKey: string | null
    // D-ww: identity channel set where identity resolves (zero re-lookup)
    authVia: 'bearer' | 'session' | null
    sessionId: string | null
  }
}

export const PUBLIC_PATHS = new Set(['/ping', '/openapi.yaml'])

// async on purpose: fastify's hook iterator advances via the hook's returned thenable,
// so this guard is a real Promise; a sync-throwing preHandler would deadlock the
// iterator (R4). Fixed at the source — routes wire requireHuman directly.
export const requireHuman = async (
  _request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> => {
  if (!_request.actorRef || _request.actorRef.kind !== 'human') {
    throw new DomainError('forbidden', 'this endpoint requires a human actor (spec D-h)')
  }
}

// async on purpose (identical R4 rationale to requireHuman). D-ss: EXACTLY the
// admin ops carry it; the roles-matrix pins both directions (no widening AND
// no narrowing). requireHuman stays attached — role implies human, and the
// defense is deliberately redundant (a session on an agent actor is unshapeable,
// but the gate does not trust that).
export const requireAdmin = async (
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> => {
  if (request.actorRef?.role !== 'admin') {
    throw new DomainError('forbidden', 'this endpoint requires the admin role (spec §5)')
  }
}

// convention: when merging a request body into use-case input, spread actorCtx LAST —
// trusted identity cannot be shadowed by body keys
export const actorCtx = (request: FastifyRequest): { actor: ActorRef; tokenId: string | null } => {
  if (!request.actorRef) throw new DomainError('unauthenticated', 'authentication required')
  return { actor: request.actorRef, tokenId: request.tokenId }
}

export const registerAuth = (app: FastifyInstance, deps: AppDeps): void => {
  app.decorateRequest('actorRef', null)
  app.decorateRequest('tokenId', null)
  app.decorateRequest('idemKey', null)
  app.decorateRequest('authVia', null)
  app.decorateRequest('sessionId', null)

  app.addHook('onRequest', async (request) => {
    // PUBLIC_PATHS membership stays EXACTLY {/ping, /openapi.yaml} (binding); the
    // LOOKUP normalizes slash spellings only — collapse duplicates, strip trailing
    // (root '/' survives: the strip requires a preceding char). Fail-closed: this
    // can only add PUBLIC spellings, never unprotect anything absent from the set.
    const path = (request.url.split('?')[0] ?? '/').replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1')
    if (PUBLIC_PATHS.has(path)) return
    // ---- Plan E session arm (D-qq/D-rr): IN THIS HOOK, at the commented seam — no
    // new onRequest hook exists; hook order auth→idem→rate-limit is byte-unchanged.
    // A garbage/expired/absent-key cookie FALLS THROUGH to the bearer arm: a
    // caller without a bearer gets the byte-identical missing-bearer 401 —
    // fail-closed, zero new machine strings.
    // Precedence (R1/D-rr): a VALID cookie resolves FIRST — cookie+bearer ⇒ session;
    // an explicit bearer does not preempt an ambient cookie.
    const sessRaw = parseCookies(request.headers.cookie)['__Host-ns_sess']
    if (sessRaw && deps.config.sessionKey) {
      const decoded = decodeSessionCookie(
        sessRaw,
        deps.config.sessionKey,
        deps.clock.now().toISOString()
      )
      if (decoded) {
        const hit = await deps.sessionsRoot.findValid(decoded.sid, deps.clock.now().toISOString())
        if (hit) {
          request.actorRef = {
            id: hit.actor.id,
            kind: hit.actor.kind,
            handle: hit.actor.handle,
            display_name: hit.actor.display_name,
            role: hit.actor.role,
          }
          request.authVia = 'session'
          request.sessionId = hit.session.id
          // D-ww: cookie identity has no MCP surface (spec §5/§10 bearer-only agents).
          if (path === '/mcp' || path.startsWith('/mcp/')) {
            throw new DomainError('forbidden', 'mcp requires a bearer token (D-ww)')
          }
          // D-rr: session-bound CSRF token on every state-changing browser request
          // (OWASP 2026: session-bound double-submit; SameSite is NOT the replacement).
          if (MUTATING.has(request.method)) {
            const hdr = request.headers['x-csrf-token']
            const want = Buffer.from(hit.session.csrf, 'utf8')
            const got = Buffer.from(typeof hdr === 'string' ? hdr : '\u0000no-header', 'utf8')
            if (want.length !== got.length || !timingSafeEqual(want, got)) {
              throw new DomainError('forbidden', 'missing or invalid CSRF token (D-rr)')
            }
          }
          return // session identity resolved; bearer never consulted
        }
      }
    }
    // ---- bearer arm: everything below this line is byte-unchanged from Plan D ----
    // (amendment honesty: the ONLY addition is the authVia='bearer' stamp below —
    // D-ww requires the channel decoration at identity resolution, arm 9 pins it)
    const header = request.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      throw new DomainError(
        'unauthenticated',
        'missing bearer token (Plan E adds human cookie sessions)'
      )
    }
    const hit = await deps.actorsRoot.findActiveTokenByHash(
      hashToken(header.slice('Bearer '.length))
    )
    if (!hit) throw new DomainError('unauthenticated', 'invalid or revoked token')
    request.actorRef = {
      id: hit.actor.id,
      kind: hit.actor.kind,
      handle: hit.actor.handle,
      display_name: hit.actor.display_name,
      role: hit.actor.role,
    }
    request.tokenId = hit.token.id
    request.authVia = 'bearer' // D-ww: set where identity resolves
    await deps.actorsRoot.touchToken(hit.token.id, deps.clock.now().toISOString())
  })
}
