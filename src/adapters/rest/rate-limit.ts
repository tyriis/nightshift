import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import { DomainError } from '#root/domain/errors'

/**
 * D-v: fixed one-minute windows per authenticated actor id, in-memory. Honest for the
 * single-container model (spec §9). The bypass is UNAUTHENTICATED/actor-less requests
 * (they keep auth's 401 as their throttle — unauth floods never reach a budget), not
 * merely PUBLIC_PATHS: the gate below is a null actorRef, so future non-public
 * actor-less requests bypass on the same honest mechanism.
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
  // onRequest handler (probe: the request hangs); require-await has no await to want
  // here (same deadlock class as requireHuman — auth.ts).
  // eslint-disable-next-line @typescript-eslint/require-await
  app.addHook('onRequest', async (request) => {
    if (!request.actorRef) return
    // raw Date.now: throttling decides on real elapsed time (not recorded data like
    // idempotency's clock timestamps) — a test clock must not slow the flood
    const window = Math.floor(Date.now() / 60_000)
    if (buckets.size > 1000) {
      // bounded memory hygiene: drop entries from previous windows. CONFESSION (T14
      // review): this sweep used to sit BELOW the if/else, where the first-hit path
      // returned before reaching it — a window rollover of many fresh actors could
      // grow the map unbounded until some actor took a second hit. Hoisted so any
      // authenticated request can sweep.
      for (const [key, b] of buckets) if (b.window !== window) buckets.delete(key)
    }
    const hit = buckets.get(request.actorRef.id)
    if (hit && hit.window === window) {
      hit.count += 1
    } else {
      buckets.set(request.actorRef.id, { window, count: 1 })
      return
    }
    if ((buckets.get(request.actorRef.id)?.count ?? 0) > limit) {
      throw new DomainError(
        'rate_limited',
        `per-actor limit of ${limit} requests/minute exceeded (spec §10)`
      )
    }
  })
}
