// Task 7: the OIDC login surface (D-pp) + the first-login decision tree (D-tt) +
// cookie-session logout (D-qq) + the identity echo (D-zz). The two GET legs are
// hook-exempt (AUTH_PRE_SESSION, auth.ts); POST /auth/logout and GET /auth/me stay
// auth-gated. Every audit on this path is a ROOT-CONNECTION single statement (no
// tx — the delivery-loop doctrine; login is not a domain mutation). The only tx
// on the path is the provisioning use-case itself.
import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import type { ActorRow } from '#root/application/ports'
import { oidcEnabled } from '#root/main/config'
import { DomainError } from '#root/domain/errors'
import { sendProblem } from '#root/adapters/rest/problem'
import { actorCtx } from '#root/adapters/rest/auth'
import {
  clearSessionCookies,
  decodeSignedJson,
  encodeSignedJson,
  parseCookies,
  sessionCookieSet,
} from '#root/adapters/shared/session-codec'
import {
  buildAuthorize,
  exchangeCode,
  isOidcFlow,
  verifyIdToken,
  type IdClaims,
  type OidcFlow,
} from '#root/adapters/shared/oidc-rp'

// The flow cookie rides the Task-3 signed envelope ({state,nonce,verifier,returnTo,
// exp}); attribute order per the SHIPPED codec (HttpOnly right after the value).
// Flow life 600s IS the buildAuthorize flow.exp — one constant, two uses.
const FLOW_COOKIE = '__Host-ns_flow'
const FLOW_TTL_S = 600
const flowCookieSet = (flow: OidcFlow, key: string): string =>
  `${FLOW_COOKIE}=${encodeSignedJson(flow, key)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${FLOW_TTL_S}`
const flowCookieClear = (): string =>
  `${FLOW_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`

// ONE string for ALL validation rejections (C2/C3/C4-class) — no oracle into
// which leg failed; the flow cookie is cleared either way.
const VALIDATION_FAIL = 'oidc callback validation failed (D-pp)'

export const registerAuthRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  app.get('/auth/login', async (request, reply) => {
    const cfg = deps.config
    if (!oidcEnabled(cfg)) {
      // review note (c): the EXPLICIT sendProblem — the generic Error path answers
      // detail 'internal error' (problem.ts:59-65); the pinned detail demands this call.
      return sendProblem(reply, 500, 'internal_error', 'oidc not configured')
    }
    // returnTo may only point INTO the UI — the SPA is the only place a login returns to
    const q = request.query as { returnTo?: string }
    const returnTo = q.returnTo?.startsWith('/ui/') ? q.returnTo : '/ui/'
    const { url, flow } = buildAuthorize(deps, returnTo)
    return reply
      .code(302)
      .header('location', url)
      .header('set-cookie', flowCookieSet(flow, cfg.sessionKey))
      .send()
  })

  app.get('/auth/callback', async (request, reply) => {
    const cfg = deps.config
    if (!oidcEnabled(cfg)) return sendProblem(reply, 500, 'internal_error', 'oidc not configured')
    const q = request.query as Record<string, string | undefined>
    const flowClear = flowCookieClear()
    // fastify MERGES repeated header() calls into an array — every response path
    // therefore sets set-cookie exactly once (mint sends the 3-element array,
    // deny/reject the single clear, the RP-failure catch the single clear).
    const rejectValidation = (): unknown => {
      reply.header('set-cookie', flowClear)
      return sendProblem(reply, 403, 'forbidden', VALIDATION_FAIL)
    }

    // the error leg FIRST (C5): nothing was verified, so unverified query data
    // never enters the spine — the deny audit says 'unknown'
    if (q.error) {
      await deps.auditRoot.append({
        actor_id: null,
        token_id: null,
        action: 'login_denied',
        entity_type: 'actor',
        entity_id: 'unknown',
        reason: 'idp_error', // pinned
        created_at: deps.clock.now().toISOString(),
      })
      return reply
        .header('location', '/ui/login?error=idp')
        .header('set-cookie', flowClear)
        .code(302)
        .send()
    }

    const flowRaw = parseCookies(request.headers.cookie)[FLOW_COOKIE]
    const flow = flowRaw
      ? decodeSignedJson(flowRaw, cfg.sessionKey, deps.clock.now().toISOString(), isOidcFlow)
      : null
    if (!flow || typeof q.state !== 'string' || q.state !== flow.state || !q.code) {
      return rejectValidation() // C2/C3-class
    }
    // RFC 9207: iss is checked WHEN PRESENT (Pocket ID always sends it; the absent
    // leg stays covered by verifyIdToken's iss verification server-side)
    if (q.iss !== undefined && q.iss !== cfg.oidcIssuer) return rejectValidation() // C4

    // exchange+verify throw a generic Error ⇒ the 500 internal_error path (C6:
    // logged, no detail leak). The consumed flow cookie dies on this response too:
    // one header set BEFORE the re-throw — the SAME Error reaches the error handler.
    let claims: IdClaims
    try {
      const tokens = await exchangeCode(deps, q.code, flow.verifier)
      claims = await verifyIdToken(deps, tokens.id_token, flow.nonce, tokens.access_token)
    } catch (error) {
      reply.header('set-cookie', flowClear)
      throw error
    }

    // ONE mint site (plan): sid/csrf 128-bit+, exp via Clock+TTL, cookie pair +
    // login_success + the cleared flow cookie as the third Set-Cookie element
    const mint = async (actor: ActorRow, sub: string): Promise<unknown> => {
      const sid = randomBytes(32).toString('base64url')
      const csrf = randomBytes(32).toString('base64url')
      const now = deps.clock.now()
      const expiresAt = new Date(now.getTime() + cfg.sessionTtlS * 1000).toISOString()
      await deps.sessionsRoot.create({
        id: sid,
        actor_id: actor.id,
        csrf,
        created_at: now.toISOString(),
        expires_at: expiresAt,
      })
      await deps.auditRoot.append({
        actor_id: actor.id,
        token_id: null,
        action: 'login_success', // pinned (§14-7: auth events ride the spine)
        entity_type: 'actor',
        entity_id: actor.id,
        after: { sub },
        reason: 'login success',
        created_at: now.toISOString(),
      })
      return reply
        .code(302)
        .header('location', flow.returnTo)
        .header('set-cookie', [
          ...sessionCookieSet({ sid, exp: expiresAt }, cfg.sessionTtlS, csrf, cfg.sessionKey),
          flowClear,
        ])
        .send()
    }
    // the D-tt deny, both accept-shapes (C7 browser / C8 API), same audit
    const deny = async (sub: string): Promise<unknown> => {
      await deps.auditRoot.append({
        actor_id: null,
        token_id: null,
        action: 'login_denied',
        entity_type: 'actor',
        entity_id: sub, // the VERIFIED sub — the deny knows exactly who was refused
        reason: 'not allow-listed', // pinned
        created_at: deps.clock.now().toISOString(),
      })
      reply.header('set-cookie', flowClear)
      if (request.headers.accept?.includes('application/json')) {
        return sendProblem(
          reply,
          403,
          'forbidden',
          'oidc identity not recognized (allow-list first)'
        )
      }
      return reply.header('location', '/ui/login?error=pending').code(302).send()
    }

    // tree (1): subject already bound → plain login (C12: zero new actor rows)
    const known = await deps.actorsRoot.findByOidcSubject(claims.sub)
    if (known) return mint(known, claims.sub)
    // tree (2): the fail-closed gate (update-status.ts lineage: (gate ?? 'off'))
    const gate = (await deps.actorsRoot.getPolicy('oidc_provisioning')) ?? 'off'
    // tree (4): allow-list — verified email, lowercase match against the table
    if (gate === 'allowlist' && claims.email_verified === true && claims.email) {
      const listed = await deps.allowlistRoot.findByEmail(claims.email.toLowerCase())
      if (listed) {
        // tree (4a): PROVISION (member, subject bound, human_provisioned audited
        // in the use-case; race-guard returns an existing row unchanged) then login
        const actor = await deps.useCases.provisionHumanFromOidc.run({
          sub: claims.sub,
          email: claims.email,
          preferred_username: claims.preferred_username,
        })
        return mint(actor, claims.sub)
      }
    }
    // tree (3)/(4b): off, unknown gate value, unverified or unlisted email ⇒ DENY
    return deny(claims.sub)
  })

  app.post('/auth/logout', async (request, reply) => {
    // CSRF rode the hook BEFORE this handler (D-rr) — O2 pins the ordering.
    // Only a SESSION identity owns a revocable row: a bearer token is not a
    // session (D-qq) — nothing on this endpoint revokes it.
    const sid = request.authVia === 'session' ? request.sessionId : null
    if (!sid) throw new DomainError('invalid_request', 'logout requires a cookie session (D-qq)')
    const at = deps.clock.now().toISOString()
    await deps.sessionsRoot.revoke(sid, at)
    await deps.auditRoot.append({
      actor_id: actorCtx(request).actor.id,
      token_id: null,
      action: 'session_revoked', // pinned
      entity_type: 'session',
      entity_id: sid,
      reason: 'logout',
      created_at: at,
    })
    // both cookies die with Max-Age=0 (D-qq: the companion dies with the session)
    return reply
      .code(204)
      .header('set-cookie', [...clearSessionCookies()])
      .send()
  })

  // D-zz identity echo for the SPA shell: reads actorCtx — NO new auth concept.
  // Any authenticated actor (bearer or session — M2 is the session leg).
  app.get('/auth/me', (request) => actorCtx(request).actor)
}
