import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'

export const registerAuditRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  // "nothing hidden": any authenticated actor may read the audit log (spec §5/§6.7)
  app.get(
    '/audit',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            entity_type: { type: 'string' },
            entity_id: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
          },
        },
      },
    },
    async (request) => {
      const q = request.query as { entity_type?: string; entity_id?: string; limit: number }
      return deps.auditRoot.search({
        entity_type: q.entity_type,
        entity_id: q.entity_id,
        limit: q.limit,
      })
    }
  )
}
