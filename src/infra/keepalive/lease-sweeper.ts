import type { UnitOfWork } from '#root/application/ports'

export interface SweeperConfig {
  intervalMs: number // 0 = loop disabled (start() refuses — D-v kill lineage)
  timeoutS: number // silence budget; 0 refuses start (D-ggg's all-or-nothing pair)
}

/** One batch per tick — a long backlog drains across ticks (D-bb BATCH lineage). */
const BATCH = 50

/**
 * The keepalive sweeper (D-iii, spec §12): claims silent past `timeoutS` revert
 * to `todo`, generation bumped — the zombie's next write rides the EXISTING 412
 * stale_lease fence (no new error surface) — and the audit spine records action
 * `lease_expired` / reason `lease expired` (spec §6.7's pre-named reason), which
 * rides /events + webhooks for free (D-aa: the audit IS the outbox).
 *
 * Shaped on the delivery loop (kill-switch start, overlap-guarded injectable-now
 * tick, unref'd timer, drain-on-stop) with ONE stated divergence: the sweep is
 * pure DB with zero network I/O, so it HOLDS a transaction — revert + audit land
 * atomically (audit is the system's memory, §6.7; no half-story). NO Clock:
 * expiry windows are DECISIONS on real elapsed time — the raw Date.now seam the
 * delivery loop ships, comment deliberately here.
 */
export class LeaseSweeper {
  private timer: ReturnType<typeof setInterval> | undefined
  private sweeping: Promise<void> | undefined

  constructor(
    private readonly uow: UnitOfWork,
    private readonly config: SweeperConfig
  ) {}

  /** Composition-root entry (index.ts): refuses to start dormant (D-ggg). */
  start(): void {
    if (this.config.intervalMs <= 0 || this.config.timeoutS <= 0) return
    this.timer = setInterval(() => void this.tick().catch(() => undefined), this.config.intervalMs)
    this.timer.unref() // never hold shutdown hostage (index.ts owns close)
  }

  /** Observability seam (tests + ops): is the timer armed? */
  get isRunning(): boolean {
    return this.timer !== undefined
  }

  /**
   * One sweep pass. `nowMs` defaults to RAW Date.now (the T14 seam above);
   * tests inject. Overlap-guarded: a fire during an in-flight sweep is a no-op.
   */
  tick(nowMs: number = Date.now()): Promise<void> {
    if (this.sweeping) return this.sweeping
    this.sweeping = this.sweepAll(nowMs).finally(() => {
      this.sweeping = undefined
    })
    return this.sweeping
  }

  private async sweepAll(nowMs: number): Promise<void> {
    const cutoff = new Date(nowMs - this.config.timeoutS * 1000).toISOString()
    const at = new Date(nowMs).toISOString()
    await this.uow.withTransaction(async (repos) => {
      const stale = await repos.tasks.listStaleClaims(cutoff, BATCH)
      for (const row of stale) {
        // the staleness predicate is RE-CHECKED inside the UPDATE (D-hhh): a
        // heartbeat that landed since the read defeats the CAS — honest miss.
        const bumped = await repos.tasks.expireStaleClaim({
          taskId: row.id,
          tokenId: row.claim_token_id,
          generation: row.claim_generation,
          cutoff,
          at,
        })
        if (bumped === null) continue
        // attribution honesty (D-iii): actor = the token's holder, token = the
        // dying claim — the row answers WHOSE lease died; the reason says what
        // happened. The FK chain claim→tokens→actors makes the holder total (P6).
        const holder = (await repos.actors.findActorByTokenId(row.claim_token_id))!
        await repos.audit.append({
          actor_id: holder.id,
          token_id: row.claim_token_id,
          action: 'lease_expired',
          entity_type: 'task',
          entity_id: row.id,
          before: { status: 'in_progress', generation: row.claim_generation },
          after: { status: 'todo', generation: bumped.generation },
          reason: 'lease expired',
          created_at: at,
        })
      }
    })
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.sweeping // let an in-flight sweep finish (audit completeness across shutdown)
  }
}
