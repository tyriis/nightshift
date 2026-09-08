import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import { actorCtx } from '#root/adapters/rest/auth'

export const registerInboxRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  app.get(
    '/inbox',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            unread_only: { type: 'boolean' },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
          },
        },
      },
    },
    async (request) => {
      const q = request.query as { unread_only?: boolean; limit?: number }
      const ctx = actorCtx(request) // 401 without an actor; per-actor view (D-r)
      return deps.inboxRoot.listForActor(ctx.actor.id, {
        unreadOnly: q.unread_only ?? false,
        limit: q.limit ?? 50,
      })
    }
  )

  app.post('/inbox/:id/read', async (request, reply) => {
    const { id } = request.params as { id: string }
    await deps.useCases.markInboxRead.run({ itemId: id, ...actorCtx(request) })
    return reply.code(204).send()
  })
}
