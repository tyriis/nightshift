import { createHmac } from 'node:crypto'
import type { AuditRepo, DueWebhook, WebhookRepo } from '#root/application/ports'

export interface DeliveryConfig {
  intervalMs: number // 0 = loop disabled (config-level kill; start() refuses)
  timeoutMs: number
  maxBackoffMs: number
}

/** One batch per webhook per tick — a long backlog drains across ticks (D-bb). */
const BATCH = 50

/**
 * The webhook delivery loop (D-bb): reads the audit spine PAST each webhook's
 * checkpoint (audit IS the outbox, D-aa), POSTs `{event, task_id, cursor}` signed
 * with the webhook's HMAC key, advances the checkpoint per ACK. At-least-once —
 * a crash between POST and advance re-delivers; consumers dedupe on the cursor.
 *
 * Never holds a transaction across network I/O (binding): the loop owns NO UoW —
 * its writes are single statements (uow.ts: global safety is Kysely's driver mutex),
 * and its reads ride root repos. This is the §9 "outbox table → delivery loop"
 * realized on the audit spine; the §9 "DeliveryQueue port" materializes as exactly
 * this class + WebhookRepo's checkpoint methods — there is no separate enqueue.
 *
 * Single-process honesty (D-v lineage): one interval timer per container.
 */
export class WebhookDeliveryLoop {
  private timer: ReturnType<typeof setInterval> | undefined
  private draining: Promise<void> | undefined

  constructor(
    private readonly webhooks: WebhookRepo,
    private readonly audit: AuditRepo,
    private readonly config: DeliveryConfig
  ) {}

  /** Composition-root entry (index.ts): refuses to start disabled (intervalMs 0). */
  start(): void {
    if (this.config.intervalMs <= 0) return
    this.timer = setInterval(() => void this.tick().catch(() => undefined), this.config.intervalMs)
    this.timer.unref() // the loop must never hold shutdown hostage (index.ts owns close)
  }

  /**
   * One drain pass. `nowMs` defaults to RAW Date.now — T14 seam: retry windows are
   * throttle/retry DECISIONS on real elapsed time (comment deliberately here).
   * Overlap-guarded: an interval fire while a drain is in flight is a no-op
   * (sequential delivery per webhook keeps the checkpoint race-free).
   */
  tick(nowMs: number = Date.now()): Promise<void> {
    if (this.draining) return this.draining // re-entrant tick() is a no-op while draining
    this.draining = this.drainAll(nowMs).finally(() => {
      this.draining = undefined
    })
    return this.draining
  }

  private async drainAll(nowMs: number): Promise<void> {
    for (const hook of await this.webhooks.listDue(nowMs)) {
      await this.drainOne(hook, nowMs)
    }
  }

  private async drainOne(hook: DueWebhook, nowMs: number): Promise<void> {
    const events = await this.audit.tail(hook.delivered_cursor, BATCH)
    for (const ev of events) {
      try {
        await this.post(hook, ev.action, ev.entity_type === 'task' ? ev.entity_id : null, ev.id)
        await this.webhooks.advance(hook.id, ev.id) // per-ACK advance ⇒ at-least-once
      } catch {
        // honest at-least-once boundary: on failure the checkpoint STAYS at the last
        // ACK'd id and the webhook parks until next_attempt_at (D-bb backoff)
        const attempts = hook.attempts + 1
        const delay = Math.min(this.config.maxBackoffMs, 1_000 * 2 ** attempts)
        await this.webhooks.scheduleRetry(hook.id, attempts, nowMs + delay)
        return
      }
    }
  }

  /** Envelope is LITERALLY spec §6.8: {event, task_id, cursor}. No additions. */
  private async post(
    hook: DueWebhook,
    event: string,
    taskId: string | null,
    cursor: number
  ): Promise<void> {
    const body = JSON.stringify({ event, task_id: taskId, cursor })
    // HMAC over the exact wire bytes (D-bb); key plaintext at rest by D-ff's stated exception
    const signature = `sha256=${createHmac('sha256', hook.secret).update(body, 'utf8').digest('hex')}`
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-nightshift-signature': signature,
        'x-nightshift-timestamp': String(Date.now()), // replay-window aid (runner-side policy; board never enforces)
      },
      body,
      signal: AbortSignal.timeout(this.config.timeoutMs),
    })
    if (!res.ok) throw new Error(`webhook ${hook.id} answered ${res.status}`)
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.draining // let an in-flight drain finish (at-least-once across shutdown)
  }
}
