// D-iii — the sweeper on the WIRE path (inject, zero sockets): agent+token seeded
// on the test db (test-app.ts's hashToken pattern), claim/heartbeat/status through
// the ROUTES; the sweep is driven through the injectable tick(nowMs) seam (the
// delivery loop's T14 lineage). The timer itself is proven only as START-REFUSAL —
// dormant defaults keep the whole suite inert (makeTestApp never starts it).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Repos, UnitOfWork } from '#root/application/ports'
import { hashToken } from '#root/infra/token-hash'
import { makeTestApp } from '#root/testing/test-app'
import { LeaseSweeper } from '#root/infra/keepalive/lease-sweeper'

let t: Awaited<ReturnType<typeof makeTestApp>>
beforeEach(async () => {
  t = await makeTestApp()
})
afterEach(async () => {
  await t.close()
})

const SECRET = 'sweep-agent-secret-0123456789abcdef'
const asHold = { authorization: `Bearer ${SECRET}` }

const setupClaimed = async (): Promise<{ id: string; lease: string }> => {
  const now = new Date().toISOString()
  await t.deps.db
    .insertInto('actors')
    .values({
      id: 'a_hold',
      kind: 'agent',
      handle: 'hold',
      display_name: 'Hold',
      description: '',
      created_at: now,
      role: null,
    })
    .execute()
  await t.deps.db
    .insertInto('tokens')
    .values({
      id: 'tok_hold',
      actor_id: 'a_hold',
      token_hash: hashToken(SECRET),
      label: 'sweep',
      created_at: now,
      last_used_at: null,
      revoked_at: null,
    })
    .execute()
  const created = await t.app.inject({
    method: 'POST',
    url: '/tasks',
    headers: { authorization: `Bearer ${t.adminToken}`, 'content-type': 'application/json' },
    payload: { title: 'swept', status: 'todo' },
  })
  expect(created.statusCode).toBeLessThan(300)
  const id = (created.json() as { id: string }).id
  const claim = await t.app.inject({
    method: 'POST',
    url: `/tasks/${id}/claim`,
    headers: asHold,
  })
  expect(claim.statusCode).toBe(200)
  return { id, lease: (claim.json() as { lease_token: string }).lease_token }
}
const sweep = (timeoutS: number, intervalMs = 1000) =>
  new LeaseSweeper(t.deps.uow, { intervalMs, timeoutS })
const auditOf = async (id: string, action: string) =>
  (await t.deps.auditRoot.search({ entity_id: id, limit: 50 })).filter((a) => a.action === action)

describe('lease sweeper (D-iii)', () => {
  it('the dormant pair refuses to arm; stop() on a never-started sweeper resolves', async () => {
    for (const cfg of [
      { intervalMs: 0, timeoutS: 300 },
      { intervalMs: 1000, timeoutS: 0 },
    ] as const) {
      const s = new LeaseSweeper(t.deps.uow, cfg)
      s.start()
      expect(s.isRunning).toBe(false)
      await s.stop() // the FALSE timer arm (delivery-loop test:201-238 lineage)
    }
  })

  it('an armed timer fires tick() on the default clock; a failing pass is SWALLOWED (P10 arms)', async () => {
    // scripted rejecting UoW is the ONLY way to exercise the real interval
    // callback FUNCTION, the Date.now() default-param arm and the
    // .catch(() => undefined) swallow arm — the delivery loop pins it the
    // same way (delivery-loop.test.ts armed-timer lineage).
    let fired = 0
    const uow = {
      withTransaction: async () => {
        fired += 1
        throw new Error('scripted sweep failure')
      },
    } as unknown as UnitOfWork
    const s = new LeaseSweeper(uow, { intervalMs: 10, timeoutS: 300 })
    s.start()
    expect(s.isRunning).toBe(true)
    await new Promise((r) => setTimeout(r, 50))
    await s.stop()
    expect(s.isRunning).toBe(false)
    expect(fired).toBeGreaterThan(0) // the timer REALLY fired; nothing rejected
  })

  it('a silent claim reverts: todo, unclaimed, generation bumped, audit "lease expired"', async () => {
    const { id } = await setupClaimed()
    const before = (await t.deps.tasksRoot.findById(id))!
    await sweep(300).tick(Date.now() + 301_000) // liveness = the CLAIM stamp (D-hhh)
    const after = (await t.deps.tasksRoot.findById(id))!
    expect([after.status, after.claim_token_id, after.last_heartbeat_at]).toEqual([
      'todo',
      null,
      null,
    ])
    expect(after.claim_generation).toBe(before.claim_generation + 1)
    const rows = await auditOf(id, 'lease_expired')
    expect(rows.length).toBe(1)
    expect(rows[0].reason).toBe('lease expired') // spec §6.7's pre-named reason
    expect(rows[0].actor_id).toBe('a_hold')
    expect(rows[0].token_id).toBe('tok_hold')
  })

  it('a heartbeat inside the budget saves the claim; later silence still sweeps', async () => {
    const { id, lease } = await setupClaimed()
    const hb = await t.app.inject({
      method: 'POST',
      url: `/tasks/${id}/heartbeat`,
      headers: { ...asHold, 'content-type': 'application/json' },
      payload: { lease_token: lease },
    })
    expect(hb.statusCode).toBe(200)
    await sweep(300).tick(Date.now() + 100_000) // cutoff = now-200 s → fresh hb survives
    expect((await t.deps.tasksRoot.findById(id))?.status).toBe('in_progress')
    await sweep(300).tick(Date.now() + 600_000) // cutoff past the last liveness
    expect((await t.deps.tasksRoot.findById(id))?.status).toBe('todo')
  })

  it('ZOMBIE FENCE (§12 sentence 3): post-sweep writes on the dead lease answer 412 stale_lease', async () => {
    const { id, lease } = await setupClaimed()
    await sweep(300).tick(Date.now() + 301_000)
    const hb = await t.app.inject({
      method: 'POST',
      url: `/tasks/${id}/heartbeat`,
      headers: { ...asHold, 'content-type': 'application/json' },
      payload: { lease_token: lease },
    })
    expect([hb.statusCode, (hb.json() as { code: string }).code]).toEqual([412, 'stale_lease'])
    const st = await t.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}/status`,
      headers: { ...asHold, 'content-type': 'application/json' },
      payload: { status: 'in_progress', reason: 'zombie commits', lease_token: lease },
    })
    expect([st.statusCode, (st.json() as { code: string }).code]).toEqual([412, 'stale_lease'])
  })

  it('the overlap guard is provable: concurrent ticks share ONE in-flight sweep, ONE audit row', async () => {
    const { id } = await setupClaimed()
    const s = sweep(300)
    const a = s.tick(Date.now() + 301_000)
    const b = s.tick(Date.now() + 301_000) // re-entrant while in flight
    expect(b).toBe(a) // the guard's identity proof — the same in-flight promise
    await Promise.all([a, b])
    expect((await auditOf(id, 'lease_expired')).length).toBe(1)
  })

  it('start() arms the timer when enabled; stop() disarms AND drains the in-flight sweep', async () => {
    const { id } = await setupClaimed()
    const s = sweep(300, 50) // the ARMED face: 50 ms interval (the only timer the
    // suite ever arms — stopped inside the test, so the suite still ends timer-free)
    s.start()
    expect(s.isRunning).toBe(true)
    const flight = s.tick(Date.now() + 301_000)
    await s.stop()
    await flight // stop() drained it — the sweep landed before the db went away
    expect(s.isRunning).toBe(false)
    expect((await t.deps.tasksRoot.findById(id))?.status).toBe('todo')
  })

  it('the honest miss skips the audit (scripted seam — the CAS-defeat branch is uninterleavable via wire)', async () => {
    const repos = {
      tasks: {
        listStaleClaims: async () => [
          { id: 't_r', claim_token_id: 'tok_r', claim_generation: 3, last_heartbeat_at: null },
        ],
        expireStaleClaim: async () => null, // a heartbeat raced the read (D-hhh's miss)
      },
      actors: { findActorByTokenId: async () => ({ id: 'a_r' }) },
      audit: {
        append: async () => {
          throw new Error('MUST NOT append on a CAS miss')
        },
      },
    } as unknown as Repos
    const uow = {
      withTransaction: async (fn: (r: Repos) => Promise<unknown>) => fn(repos),
    } as unknown as UnitOfWork
    await new LeaseSweeper(uow, { intervalMs: 0, timeoutS: 300 }).tick(Date.now())
  })
})
