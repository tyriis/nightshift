import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import { DomainError } from '#root/domain/errors'

/**
 * D-v: fixed one-minute windows per authenticated actor id, in-memory. Honest for the
 * single-container model (spec §9); public paths bypass (no actor → no budget to burn).
 * Window = Math.floor(now/60_000); first hit of a window resets the counter.
 */
export const registerRateLimit = (app: FastifyInstance, deps: AppDeps): void => {
  const limit = deps.config.rateLimitPerMin
  if (limit <= 0) return // disabled (test default)
  const buckets = new Map<string, { window: number; count: number }>()
  // registered AFTER auth (needs actorRef resolved) and BEFORE idempotency? No —
  // order: auth → idempotency → rate-limit keeps replayed responses cheap (a replay
  // does not burn budget): register LAST among onRequest hooks in app.ts.
  // async form is deliberate: fastify's hook iterator never resumes a sync-void
  // onRequest handler (probe: the request hangs); require-await has no await to want here.
  // eslint-disable-next-line @typescript-eslint/require-await
  app.addHook('onRequest', async (request) => {
    if (!request.actorRef) return
    const window = Math.floor(Date.now() / 60_000)
    const hit = buckets.get(request.actorRef.id)
    if (hit && hit.window === window) {
      hit.count += 1
    } else {
      buckets.set(request.actorRef.id, { window, count: 1 })
      return
    }
    if (buckets.size > 1000) {
      // bounded memory hygiene: drop entries from previous windows
      for (const [key, b] of buckets) if (b.window !== window) buckets.delete(key)
    }
    if ((buckets.get(request.actorRef.id)?.count ?? 0) > limit) {
      throw new DomainError(
        'rate_limited',
        `per-actor limit of ${limit} requests/minute exceeded (spec §10)`
      )
    }
  })
}
