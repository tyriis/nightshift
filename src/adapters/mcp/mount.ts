// src/adapters/mcp/mount.ts
import { createMcpHandler } from '@modelcontextprotocol/server'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ActorContext } from '#root/application/ports'
import { mcpTools } from '#root/adapters/mcp/tools/index'
import { buildMcpServer } from '#root/adapters/mcp/server'
import { webRequestFromFastify, writeWebResponseToFastify } from '#root/adapters/mcp/http'
import { DomainError } from '#root/domain/errors'
import type { AppDeps } from '#root/main/deps'

// Identity arrives from the hook chain — same message as actorCtx (auth.ts:32),
// no second doctrine, no token re-lookup (D-ii). Unreachable in practice:
// PUBLIC_PATHS excludes /mcp, so the onRequest hook already 401'd.
const mcpActor = (request: FastifyRequest): ActorContext => {
  if (!request.actorRef) throw new DomainError('unauthenticated', 'authentication required')
  return { actor: request.actorRef, tokenId: request.tokenId }
}

export const mountMcp = (app: FastifyInstance, deps: AppDeps): void => {
  // Encapsulated scope: removeAllContentTypeParsers + the raw '*' parser are
  // SCOPE-LOCAL (REST keeps the built-in JSON parser — probe lesson: '*' alone
  // does NOT override it). Hooks inherit downward, so auth → idempotency →
  // rate-limit guard /mcp in the same order as REST (D-ii). GET/DELETE exist so
  // the 2025-era session ops reach the handler's 405, not fastify's 404.
  // plan block wrote the plugin async; lint (require-await) rejects an await-less
  // async — fastify accepts a plain sync plugin just the same (app.ts precedent)
  void app.register((scope) => {
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, payload, done) =>
      done(null, payload as Uint8Array)
    )
    scope.route({
      method: ['GET', 'POST', 'DELETE'],
      url: '/mcp',
      handler: async (request, reply: FastifyReply) => {
        const ctx = mcpActor(request) // before hijack: the defensive 401 stays problem+json
        const webRequest = webRequestFromFastify(request, request.body as Uint8Array | undefined)
        reply.hijack() // MCP owns the socket
        // Fresh handler per request carries the identity in the factory closure —
        // ~1.7 ms, no leaked timers, no process-wide state (probed, D-hh).
        const handler = createMcpHandler(() => buildMcpServer(deps, ctx, mcpTools))
        try {
          await writeWebResponseToFastify(await handler.fetch(webRequest), reply)
        } catch (error) {
          request.log.error({ err: error }, 'mcp mount failed')
          if (!reply.raw.headersSent)
            reply.raw.writeHead(500, { 'content-type': 'application/json' })
          reply.raw.end('{"error":"mcp_mount"}')
        } finally {
          await handler.close().catch(() => undefined) // modern leg only; the stateless legacy leg holds nothing
        }
      },
    })
  })
}
