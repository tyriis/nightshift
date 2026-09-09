import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import type { ActorRef } from '#root/application/ports'
// sanctioned pure-util import (plan ruling): token-hash is node:crypto-only, no infra coupling
import { hashToken } from '#root/infra/token-hash'
import { DomainError } from '#root/domain/errors'

declare module 'fastify' {
  interface FastifyRequest {
    actorRef: ActorRef | null
    tokenId: string | null
    idemKey: string | null
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

  app.addHook('onRequest', async (request) => {
    // PUBLIC_PATHS membership stays EXACTLY {/ping, /openapi.yaml} (binding); the
    // LOOKUP normalizes slash spellings only — collapse duplicates, strip trailing
    // (root '/' survives: the strip requires a preceding char). Fail-closed: this can
    // only add PUBLIC spellings, never unprotect anything absent from the set.
    const path = (request.url.split('?')[0] ?? '/').replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1')
    if (PUBLIC_PATHS.has(path)) return
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
    await deps.actorsRoot.touchToken(hit.token.id, deps.clock.now().toISOString())
  })
}
