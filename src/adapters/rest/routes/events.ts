import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import type { AuditRow } from '#root/application/ports'

// wire shape = yaml Event (explicit because the repo lints return types; tasks.ts
// precedent for local interface + arrow): audit spine minus payloads, cursor = id
interface FeedEvent {
  cursor: number
  actor_id: string | null
  token_id: string | null
  action: string
  entity_type: string
  entity_id: string
  reason: string | null
  created_at: string
}

// minus payloads (D-aa, spec §6.8 "everything audit-worthy minus payloads"): the
// before/after snapshots ARE the payloads; actor/token attribution, the machine
// action+entity, the machine reason and the timestamp all ride. cursor = audit_log.id.
const toEvent = (r: AuditRow): FeedEvent => ({
  cursor: r.id,
  actor_id: r.actor_id,
  token_id: r.token_id,
  action: r.action,
  entity_type: r.entity_type,
  entity_id: r.entity_id,
  reason: r.reason,
  created_at: r.created_at,
})

export const registerEventRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  // D-dd: NO rate-limit exemption — this GET reaches the budget like every other
  // route (burn rule pinned in events.test.ts); tailing at NS_RATE_LIMIT_PER_MIN
  // is the designed posture, webhooks are the push path
  app.get(
    '/events',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            cursor: { type: 'integer', minimum: 0, default: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
          },
        },
      },
    },
    async (request) => {
      const q = request.query as { cursor: number; limit: number }
      const rows = await deps.auditRoot.tail(q.cursor, q.limit)
      return rows.map(toEvent)
    }
  )
}
