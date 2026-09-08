import { createServer, type Server } from 'node:http'
import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AddressInfo } from 'node:net'
import { sql } from 'kysely'
import type { AuditEntryDraft, AuditRepo, WebhookRepo } from '#root/application/ports'
import { makeDb } from '#root/infra/sqlite/db'
import { migrateToLatest } from '#root/infra/sqlite/migrations'
import { SqliteAuditRepo } from '#root/infra/sqlite/audit-repo'
import { SqliteWebhookRepo } from '#root/infra/sqlite/webhook-repo'
import { WebhookDeliveryLoop } from '#root/infra/webhooks/delivery-loop'

interface Received {
  body: string
  sig: string | undefined
  ts: string | undefined
}

// a REAL receiver (a real store pins the contract — no fakes): node:http on an
// ephemeral port, programmed per-test with a status queue
let receiver: Server
let received: Received[]
let statuses: number[] = []
let url: string

beforeAll(async () => {
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      received.push({
        body: Buffer.concat(chunks).toString('utf8'),
        sig: req.headers['x-nightshift-signature'] as string | undefined,
        ts: req.headers['x-nightshift-timestamp'] as string | undefined,
      })
      const status = statuses.length > 0 ? (statuses.shift() as number) : 200
      res.writeHead(status).end()
    })
  })
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/cb`
})
afterAll(async () => {
  await new Promise((r) => receiver.close(r))
})

const CFG = { intervalMs: 0, timeoutMs: 2_000, maxBackoffMs: 10_000 }

const setup = async (opts: { url?: string; secret?: string } = {}) => {
  const db = makeDb(':memory:')
  await migrateToLatest(db)
  await sql`insert into actors (id, kind, handle, display_name, description, created_at)
              values ('a_h','human','h','H','','2026-01-01'),
                     ('a_g','agent','g','G','','2026-01-01')`.execute(db)
  const audit = new SqliteAuditRepo(db)
  const webhooks = new SqliteWebhookRepo(db)
  await webhooks.add({
    id: 'wh_1',
    actor_id: 'a_g',
    url: opts.url ?? url,
    secret: opts.secret ?? 'k3y',
    created_by: 'a_h',
    created_at: '2026-01-01',
    delivered_cursor: 0,
  })
  return { db, audit, webhooks }
}
const audited = async (
  audit: SqliteAuditRepo,
  n: number,
  entity = 'task',
  id = 't_1'
): Promise<void> => {
  const e: AuditEntryDraft = {
    actor_id: 'a_h',
    token_id: null,
    action: `act_${n}`,
    entity_type: entity,
    entity_id: id,
    after: { payload: 'SECRET-PAYLOAD' },
    reason: `reason ${n}`,
    created_at: '2026-01-01',
  }
  await audit.append(e)
}

describe('WebhookDeliveryLoop (D-bb)', () => {
  it('delivers the envelope, signed, past the checkpoint — and nothing before it', async () => {
    received = []
    const s = await setup({ secret: 'topkey' })
    await audited(s.audit, 1)
    await s.webhooks.advance('wh_1', 1) // checkpoint PAST row 1 (watermark semantics)
    await audited(s.audit, 2)
    const loop = new WebhookDeliveryLoop(s.webhooks, s.audit, CFG)
    await loop.tick(1_000)
    expect(received).toHaveLength(1) // row 1 already checkpointed ⇒ only row 2 (D-bb)
    const msg = JSON.parse(received[0].body)
    expect(msg).toEqual({ event: 'act_2', task_id: 't_1', cursor: 2 }) // §6.8 envelope LITERAL
    expect(received[0].sig).toBe(
      `sha256=${createHmac('sha256', 'topkey').update(received[0].body).digest('hex')}`
    )
    expect(Number(received[0].ts)).toBeGreaterThan(0)
    expect((await s.webhooks.find('wh_1'))?.delivered_cursor).toBe(2)
    // minus-payloads rule: the audit after-snapshot NEVER crosses the wire
    expect(received[0].body).not.toContain('SECRET-PAYLOAD')
    await s.db.destroy()
  })

  it('non-task entity ⇒ task_id null; batch drains newest cursor only', async () => {
    received = []
    const s = await setup()
    await audited(s.audit, 1, 'thread', 'th_9')
    await audited(s.audit, 2)
    await new WebhookDeliveryLoop(s.webhooks, s.audit, CFG).tick(1_000)
    expect(received).toHaveLength(2)
    expect(JSON.parse(received[0].body)).toEqual({ event: 'act_1', task_id: null, cursor: 1 })
    expect((await s.webhooks.find('wh_1'))?.delivered_cursor).toBe(2)
    await s.db.destroy()
  })

  it('failure ⇒ checkpoint STAYS, attempts++ with backoff park; retry then advances (at-least-once)', async () => {
    received = []
    statuses = [500] // first attempt fails, later attempts default 200
    const s = await setup()
    await audited(s.audit, 1)
    const loop = new WebhookDeliveryLoop(s.webhooks, s.audit, CFG)
    await loop.tick(1_000)
    expect(received).toHaveLength(1) // tried
    const stuck = await s.webhooks.listDue(1_000) // still parked at now+2000
    expect(stuck).toEqual([]) // parked ⇒ not due at the same now
    const row = await sql<{ c: number; a: number; n: number }>`
      select delivered_cursor as c, attempts as a, next_attempt_at as n from webhooks`.execute(s.db)
    expect(row.rows[0]).toEqual({ c: 0, a: 1, n: 3_000 }) // min(10_000, 1000·2^1) (T14 raw Date.now domain)
    await loop.tick(3_000) // due now — succeeds ⇒ exactly-once becomes AT-least-once: event delivered TWICE total
    expect(received).toHaveLength(2)
    expect((await s.webhooks.find('wh_1'))?.delivered_cursor).toBe(1)
    expect((await s.webhooks.listDue(9_999))[0]?.attempts).toBe(0) // ACK resets backoff (advance)
    await s.db.destroy()
  })

  it('dead endpoint: network error is a retryable failure, identical bookkeeping to 500', async () => {
    received = []
    const s = await setup({ url: 'http://127.0.0.1:1/cb' }) // nothing listens
    await audited(s.audit, 1)
    await new WebhookDeliveryLoop(s.webhooks, s.audit, CFG).tick(1_000)
    const row = await sql<{
      c: number
      a: number
    }>`select delivered_cursor as c, attempts as a from webhooks`.execute(s.db)
    expect(row.rows[0]).toEqual({ c: 0, a: 1 })
    await s.db.destroy()
  })

  it('backoff caps at maxBackoffMs (geometric, capped)', async () => {
    received = []
    statuses = [500, 500, 500, 500, 500, 500, 500, 500, 500] // long failure streak
    const s = await setup()
    await audited(s.audit, 1)
    const loop = new WebhookDeliveryLoop(s.webhooks, s.audit, CFG) // maxBackoff 10_000
    let now = 1_000
    for (let i = 0; i < 8; i++) {
      await loop.tick(now)
      const row = await sql<{
        n: number
        a: number
      }>`select next_attempt_at as n, attempts as a from webhooks`.execute(s.db)
      const { n, a } = row.rows[0] as { n: number; a: number }
      expect(a).toBe(i + 1)
      expect(n - now).toBeLessThanOrEqual(10_000) // capped
      expect(n - now).toBe(Math.min(10_000, 1_000 * 2 ** (i + 1)))
      now = n
    }
    await s.db.destroy()
  })

  it('overlap guard: a tick() fired while a drain is in flight returns the SAME pass', async () => {
    // deterministic without any timing race: the guard is synchronous — the second
    // call lands before the first tick awaits anything, so identity proves the no-op
    received = []
    const s = await setup()
    await audited(s.audit, 1)
    const loop = new WebhookDeliveryLoop(s.webhooks, s.audit, CFG)
    const first = loop.tick(1_000)
    const second = loop.tick(1_000)
    expect(second).toBe(first)
    await Promise.all([first, second])
    expect(received).toHaveLength(1) // one event, exactly one POST despite two tick calls
    await s.db.destroy()
  })

  it('empty tail ⇒ no POST, no checkpoint churn; a webhook past the watermark receives nothing', async () => {
    received = []
    const s = await setup()
    await s.webhooks.advance('wh_1', 999) // D-bb watermark anchor state
    await new WebhookDeliveryLoop(s.webhooks, s.audit, CFG).tick(1_000)
    expect(received).toEqual([])
    expect((await s.webhooks.find('wh_1'))?.delivered_cursor).toBe(999)
    await s.db.destroy()
  })

  it('start() at intervalMs 0 refuses (no timer to leak); stop() on a never-started loop resolves', async () => {
    received = []
    const s = await setup()
    await audited(s.audit, 1) // an undelivered event: a leaked timer WOULD fire it
    const loop = new WebhookDeliveryLoop(s.webhooks, s.audit, CFG) // intervalMs 0
    loop.start()
    await new Promise((r) => setTimeout(r, 20)) // generous grace: any armed timer would have POSTed
    expect(received).toEqual([]) // config-level kill honored
    await loop.stop() // never started ⇒ resolves
    await s.db.destroy()
  })

  it('armed timer fires tick() on the default clock; a failing pass is swallowed; stop() tears down', async () => {
    // the dead-pool arm needs a REJECTING read — a stub repo is the honest seam here
    // (real repos cannot be torn down mid-fire without racing the teardown)
    const deadWebhooks: WebhookRepo = {
      add: async () => {},
      find: async () => null,
      list: async () => [],
      remove: async () => {},
      setSecret: async () => {},
      listDue: async () => {
        throw new Error('db gone') // a timer fire against a dead pool
      },
      advance: async () => {},
      scheduleRetry: async () => {},
      reanchor: async () => {},
    }
    const noAudit: AuditRepo = {
      append: async () => {},
      search: async () => [],
      tail: async () => [],
      watermark: async () => 0,
    }
    const loop = new WebhookDeliveryLoop(deadWebhooks, noAudit, { ...CFG, intervalMs: 1 })
    loop.start()
    await new Promise((r) => setTimeout(r, 15)) // >=1 fire: tick() rejects ⇒ the callback's .catch swallows
    await loop.stop() // timer set ⇒ clearInterval; resolving here pins the no-unhandled-rejection escape
  })
})
