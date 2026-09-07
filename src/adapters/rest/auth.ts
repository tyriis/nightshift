import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import type { ActorRef } from '#root/application/ports'
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

export const requireHuman = (_request: FastifyRequest, _reply: FastifyReply): void => {
  if (!_request.actorRef || _request.actorRef.kind !== 'human') {
    throw new DomainError('forbidden', 'this endpoint requires a human actor (spec D-h)')
  }
}

export const actorCtx = (request: FastifyRequest): { actor: ActorRef; tokenId: string | null } => {
  if (!request.actorRef) throw new DomainError('unauthenticated', 'authentication required')
  return { actor: request.actorRef, tokenId: request.tokenId }
}

export const registerAuth = (app: FastifyInstance, deps: AppDeps): void => {
  app.decorateRequest('actorRef', null)
  app.decorateRequest('tokenId', null)
  app.decorateRequest('idemKey', null)

  app.addHook('onRequest', async (request) => {
    const path = request.url.split('?')[0]
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
    }
    request.tokenId = hit.token.id
    await deps.actorsRoot.touchToken(hit.token.id, deps.clock.now().toISOString())
  })
}
