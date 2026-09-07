import Fastify, { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import { registerProblemHandlers } from '#root/adapters/rest/problem'
import { registerAuth } from '#root/adapters/rest/auth'
import { registerIdempotency } from '#root/adapters/rest/idempotency'
import { registerAuditRoutes } from '#root/adapters/rest/routes/audit'

export interface BuildAppOptions {
  logger?: boolean
}

export const buildApp = (deps: AppDeps, opts: BuildAppOptions = {}): FastifyInstance => {
  const server: FastifyInstance = Fastify({ logger: opts.logger ?? false })

  registerProblemHandlers(server)
  // plan block wrote this async; lint (require-await) rejects an await-less async —
  // fastify accepts a plain object return just the same
  server.get('/ping', () => {
    return { pong: 'it worked!' }
  })

  // hook order matters: auth resolves the actor, then idempotency reserves per-actor keys
  registerAuth(server, deps)
  registerIdempotency(server, deps)

  registerAuditRoutes(server, deps)

  return server
}
