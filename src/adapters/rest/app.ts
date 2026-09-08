import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import Fastify, { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import { registerProblemHandlers } from '#root/adapters/rest/problem'
import { registerAuth } from '#root/adapters/rest/auth'
import { registerIdempotency } from '#root/adapters/rest/idempotency'
import { registerRateLimit } from '#root/adapters/rest/rate-limit'
import { registerAdminRoutes } from '#root/adapters/rest/routes/admin'
import { registerWebhookRoutes } from '#root/adapters/rest/routes/webhooks'
import { registerAuditRoutes } from '#root/adapters/rest/routes/audit'
import { registerEventRoutes } from '#root/adapters/rest/routes/events'
import { registerInboxRoutes } from '#root/adapters/rest/routes/inbox'
import { registerDependencyRoutes } from '#root/adapters/rest/routes/dependencies'
import { registerLabelRoutes } from '#root/adapters/rest/routes/labels'
import { registerTaskRoutes } from '#root/adapters/rest/routes/tasks'
import { registerThreadRoutes } from '#root/adapters/rest/routes/threads'
import { registerAttachmentRoutes } from '#root/adapters/rest/routes/attachments'
import { registerLinkRoutes } from '#root/adapters/rest/routes/links'

export interface BuildAppOptions {
  logger?: boolean
}

export const buildApp = (deps: AppDeps, opts: BuildAppOptions = {}): FastifyInstance => {
  const server: FastifyInstance = Fastify({ logger: opts.logger ?? false })

  // D-s: raw-body uploads (application/octet-stream) — parseAs buffer, no multipart dep.
  // Registered app-level, before routes; JSON/text keep their default parsers untouched.
  server.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body)
  )

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
  registerRateLimit(server, deps) // LAST onRequest: idempotent replays skip the budget (D-v)

  registerAuditRoutes(server, deps)
  registerEventRoutes(server, deps) // the cursor feed reads the same spine (D-aa)
  registerTaskRoutes(server, deps)
  registerThreadRoutes(server, deps) // threads are task-surface (spec §7.2)
  registerInboxRoutes(server, deps)
  registerAttachmentRoutes(server, deps)
  registerLinkRoutes(server, deps)
  registerDependencyRoutes(server, deps)
  registerLabelRoutes(server, deps)
  registerAdminRoutes(server, deps)
  registerWebhookRoutes(server, deps) // admin surface groups together (plan Task 9)

  return server
}
