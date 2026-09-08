import { describe, expect, it } from 'vitest'
import { makeTestApp } from '#root/testing/test-app'

const bearer = (t: string) => ({ authorization: `Bearer ${t}` })

const createTask = async (t: Awaited<ReturnType<typeof makeTestApp>>, title: string) =>
  t.app.inject({ method: 'POST', url: '/tasks', headers: bearer(t.adminToken), payload: { title } })

describe('GET /events (D-aa, D-dd)', () => {
  it('requires auth (PUBLIC_PATHS stays exactly {/ping,/openapi.yaml})', async () => {
    const t = await makeTestApp()
    const res = await t.app.inject({ method: 'GET', url: '/events' })
    expect(res.statusCode).toBe(401)
    await t.close()
  })

  it('cursor advances monotonically; caught-up ⇒ empty; payloads excluded', async () => {
    const t = await makeTestApp()
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: '/events?cursor=0',
          headers: bearer(t.adminToken),
        })
      ).json()
    ).toEqual([])
    await createTask(t, 'one')
    const r1 = await t.app.inject({
      method: 'GET',
      url: '/events?cursor=0',
      headers: bearer(t.adminToken),
    })
    const events = r1.json()
    expect(events.map((e: { action: string }) => e.action)).toEqual(['task_created'])
    const e0 = events[0]
    // minus payloads (D-aa): the before/after snapshots are the excluded payloads —
    // every OTHER audit-worthy field rides
    expect(Object.keys(e0).sort()).toEqual(
      [
        'action',
        'actor_id',
        'created_at',
        'cursor',
        'entity_id',
        'entity_type',
        'reason',
        'token_id',
      ].sort()
    )
    expect(e0.entity_type).toBe('task')
    expect(e0.reason).toBe('task created')
    const cursorA = e0.cursor
    await createTask(t, 'two')
    const r2 = await t.app.inject({
      method: 'GET',
      url: `/events?cursor=${cursorA}`,
      headers: bearer(t.adminToken),
    })
    const next = r2.json()
    expect(next).toHaveLength(1)
    expect(next[0].cursor).toBeGreaterThan(cursorA) // monotonic, ASCENDING
    const tail = await t.app.inject({
      method: 'GET',
      url: `/events?cursor=${next[0].cursor}`,
      headers: bearer(t.adminToken),
    })
    expect(tail.json()).toEqual([]) // caught up
    await t.close()
  })

  it('query validation: negative/fractional/non-integer cursor → 400 invalid_request; limit bounds', async () => {
    const t = await makeTestApp()
    for (const q of ['cursor=-1', 'cursor=1.5', 'cursor=abc', 'limit=0', 'limit=501']) {
      const res = await t.app.inject({
        method: 'GET',
        url: `/events?${q}`,
        headers: bearer(t.adminToken),
      })
      expect(res.statusCode, q).toBe(400)
      expect(res.json().code, q).toBe('invalid_request')
    }
    await t.close()
  })

  it('tailing BURNS the per-actor rate-limit budget like any GET (D-dd pin)', async () => {
    const t = await makeTestApp({ NS_RATE_LIMIT_PER_MIN: '2' })
    const h = bearer(t.adminToken)
    expect((await t.app.inject({ method: 'GET', url: '/events', headers: h })).statusCode).toBe(200)
    expect((await t.app.inject({ method: 'GET', url: '/events', headers: h })).statusCode).toBe(200)
    const third = await t.app.inject({ method: 'GET', url: '/events', headers: h })
    expect(third.statusCode).toBe(429)
    expect(third.json().code).toBe('rate_limited')
    await t.close()
  })

  it('limit caps the batch (default 100, max 500 — yaml schema parity)', async () => {
    const t = await makeTestApp()
    for (let i = 0; i < 4; i++) await createTask(t, `t${i}`)
    const res = await t.app.inject({
      method: 'GET',
      url: '/events?cursor=0&limit=2',
      headers: bearer(t.adminToken),
    })
    const batch = res.json()
    expect(batch).toHaveLength(2)
    expect(batch[0].cursor).toBeLessThan(batch[1].cursor) // ASCENDING slice from the cursor
    const all = await t.app.inject({
      method: 'GET',
      url: '/events?cursor=0',
      headers: bearer(t.adminToken),
    })
    expect(all.json().length).toBeGreaterThan(2) // the cap, not the data, produced the 2
    await t.close()
  })
})
