import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import Fastify, { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import { registerProblemHandlers } from '#root/adapters/rest/problem'
import { registerAuth } from '#root/adapters/rest/auth'
import { registerIdempotency } from '#root/adapters/rest/idempotency'
import { registerAdminRoutes } from '#root/adapters/rest/routes/admin'
import { registerAuditRoutes } from '#root/adapters/rest/routes/audit'
import { registerDependencyRoutes } from '#root/adapters/rest/routes/dependencies'
import { registerLabelRoutes } from '#root/adapters/rest/routes/labels'
import { registerTaskRoutes } from '#root/adapters/rest/routes/tasks'

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

  // the committed contract is served publicly (D-k); PUBLIC_PATHS already lists the path
  server.get('/openapi.yaml', async (_request, reply) => {
    const spec = await readFile(join(process.cwd(), 'openapi', 'openapi.yaml'), 'utf8')
    return reply.type('application/yaml').send(spec)
  })

  // hook order matters: auth resolves the actor, then idempotency reserves per-actor keys
  registerAuth(server, deps)
  registerIdempotency(server, deps)

  registerAuditRoutes(server, deps)
  registerTaskRoutes(server, deps)
  registerDependencyRoutes(server, deps)
  registerLabelRoutes(server, deps)
  registerAdminRoutes(server, deps)

  return server
}
