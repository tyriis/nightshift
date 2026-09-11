// routes/search.ts — D-ppp (Plan H): GET /search, the §12 search slice over the D-gg
// read-only FTS port. Zero new error surface: malformed MATCH strings map to
// invalid_request inside the port (search-repo.ts), and fastify querystring validation
// rides the shipped 400 problem arm (problem.ts). Auth: NOT in PUBLIC_PATHS — every
// AUTHENTICATED actor may read everything (spec §5). MCP stays frozen at 35 (D-nn).
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'

export const registerSearchRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  app.get(
    '/search',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['q'],
          properties: {
            q: { type: 'string', minLength: 1 },
            // the D-gg clamp's ceiling becomes a 400 — the route schema owns input
            // bounds (M-2 doctrine, /tasks/next's limit pin is the sibling)
            limit: { type: 'integer', minimum: 1, maximum: 200 },
          },
        },
      },
    },
    async (request) => {
      const { q, limit } = request.query as { q: string; limit?: number }
      return deps.searchRoot.search(q, limit ?? 20) // the yaml-documented default (D-ppp)
    }
  )
}
