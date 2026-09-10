// events.ts — live board via the cursor feed (spec §8: polling; SSE §12 later).
// SHAPE (review R4/B9 — verified routes/events.ts:54): GET /events answers a BARE
// ARRAY (rows.map(toEvent); cursor = audit_log.id — toEvent is the exported single
// source; FeedEvent is transcribed in types.ts from its FULL field list, not just
// cursor). The former `import { api }` here was unused (the loop takes `load` as a
// parameter) — dropped: no dead imports.
import type { FeedEvent } from './types'

export const POLL_BASE_MS = 2000
export const POLL_MAX_MS = 10000

/** Pure next-delay decision — Task 9's e2e-adjacent honesty hook: cursor NEVER
 * decreases; failures back off ×2 up to POLL_MAX_MS; success returns to base. */
export interface PollState {
  cursor: number
  delayMs: number
}

export const initialPollState = (): PollState => ({ cursor: 0, delayMs: POLL_BASE_MS })

export const afterSuccess = (s: PollState, page: FeedEvent[]): PollState => ({
  cursor: page.reduce((m, e) => Math.max(m, e.cursor), s.cursor), // monotonic, never re-reads back
  delayMs: POLL_BASE_MS,
})

export const afterFailure = (s: PollState): PollState => ({
  cursor: s.cursor,
  delayMs: Math.min(s.delayMs * 2, POLL_MAX_MS),
})

/** Drives the loop; onBatch runs only when fresh events arrived. `alive` gates
 * across SPA navigations. */
export async function pollFeed(
  load: (cursor: number) => Promise<FeedEvent[]>,
  onBatch: (events: FeedEvent[]) => void,
  alive: () => boolean,
  schedule: (fn: () => void, ms: number) => unknown = setTimeout
): Promise<void> {
  let state = initialPollState()
  while (alive()) {
    try {
      const page = await load(state.cursor)
      const next = afterSuccess(state, page)
      if (page.length > 0) onBatch(page)
      state = next
    } catch {
      state = afterFailure(state) // feed failure NEVER kills the loop; the tick just refetches
    }
    await new Promise<void>((r) => schedule(() => r(), state.delayMs))
  }
}
