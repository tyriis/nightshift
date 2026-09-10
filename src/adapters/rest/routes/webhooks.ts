import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import { actorCtx, requireHuman, requireAdmin } from '#root/adapters/rest/auth'

// /admin/webhooks* — human-only (requireHuman stays async: sync-void deadlocks fastify
// 5's hook iterator, auth.ts/R4). Secrets: created/rotated shown once, never listable (D-ff).
export const registerWebhookRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  app.get('/admin/webhooks', { preHandler: [requireHuman, requireAdmin] }, async () =>
    deps.webhooksRoot.list()
  )

  app.post(
    '/admin/webhooks',
    {
      preHandler: [requireHuman, requireAdmin],
      schema: {
        body: {
          type: 'object',
          required: ['agent_id', 'url'],
          additionalProperties: false,
          properties: {
            agent_id: { type: 'string', minLength: 1, maxLength: 60 },
            // 8 = 'http://a', shortest parseable http(s) URL — links.ts precedent; the
            // http(s) SCHEME rule is the use-case's (ports speak validation of shape here)
            url: { type: 'string', minLength: 8, maxLength: 2000 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { agent_id: string; url: string }
      const created = await deps.useCases.createWebhook.run({
        ...body,
        ...actorCtx(request), // actorCtx LAST (binding)
      })
      return reply.code(201).send({ ...created.webhook, secret: created.secret })
    }
  )

  app.post(
    '/admin/webhooks/:id/rotate-secret',
    { preHandler: [requireHuman, requireAdmin] },
    async (request) => {
      const { id } = request.params as { id: string }
      const rotated = await deps.useCases.rotateWebhookSecret.run({
        ...actorCtx(request),
        webhook_id: id,
      })
      return { ...rotated.webhook, secret: rotated.secret }
    }
  )

  app.delete(
    '/admin/webhooks/:id',
    { preHandler: [requireHuman, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      await deps.useCases.deleteWebhook.run({ ...actorCtx(request), webhook_id: id })
      return reply.code(204).send()
    }
  )
}
