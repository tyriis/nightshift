import { describe, expect, it } from 'vitest'
import { makeTestApp, type TestApp } from '#root/testing/test-app'

const nils = (t: TestApp): Record<string, string> => ({ authorization: `Bearer ${t.adminToken}` })

describe('per-actor rate limit (spec §10, D-v)', () => {
  it('429 rate_limited after the window budget; disabled with 0 (the default in makeTestApp)', async () => {
    // default (limit 0 = off): 5 requests fine
    const t = await makeTestApp()
    for (let i = 0; i < 5; i++) {
      const res = await t.app.inject({ method: 'GET', url: '/audit', headers: nils(t) })
      expect(res.statusCode).toBe(200)
    }
    await t.close()

    const t2 = await makeTestApp({ NS_RATE_LIMIT_PER_MIN: '2' })
    expect(
      (await t2.app.inject({ method: 'GET', url: '/audit', headers: nils(t2) })).statusCode
    ).toBe(200)
    expect(
      (await t2.app.inject({ method: 'GET', url: '/audit', headers: nils(t2) })).statusCode
    ).toBe(200)
    const third = await t2.app.inject({ method: 'GET', url: '/audit', headers: nils(t2) })
    expect(third.statusCode).toBe(429)
    expect(third.json().code).toBe('rate_limited')
    // the 429 rides the problem pipeline like every other error envelope
    expect(third.headers['content-type']).toContain('application/problem+json')
    expect(third.json().status).toBe(429)
    // per-actor: another actor has its own budget — agent token stays 401-uncle, so
    // use the public path probe: public paths bypass (actorRef null) → never throttled
    const pub = await t2.app.inject({ method: 'GET', url: '/ping' })
    expect(pub.statusCode).toBe(200)
    await t2.close()
  })

  it('per-actor isolation (the §10 headline): one exhausted actor never starves another', async () => {
    const t = await makeTestApp({ NS_RATE_LIMIT_PER_MIN: '2' })
    // spending admin's 2-request budget on the agent bootstrap (both are authenticated)
    const agent = (
      await t.app.inject({
        method: 'POST',
        url: '/admin/actors',
        headers: nils(t),
        payload: { kind: 'agent', handle: 'hermes-1', display_name: 'Hermes' },
      })
    ).json()
    const issued = (
      await t.app.inject({
        method: 'POST',
        url: `/admin/actors/${agent.id as string}/tokens`,
        headers: nils(t),
        payload: { label: 'ci' },
      })
    ).json()
    const agentBearer = { authorization: `Bearer ${issued.raw_token as string}` }
    // actor A (admin nils) is exhausted: budget spent on the two bootstrap calls
    const starved = await t.app.inject({ method: 'GET', url: '/audit', headers: nils(t) })
    expect(starved.statusCode).toBe(429)
    expect(starved.json().code).toBe('rate_limited')
    // actor B has its own untouched budget
    const fresh = await t.app.inject({ method: 'GET', url: '/audit', headers: agentBearer })
    expect(fresh.statusCode).toBe(200)
    await t.close()
  })
})
