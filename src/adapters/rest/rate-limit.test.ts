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
    // per-actor: another actor has its own budget — agent token stays 401-uncle, so
    // use the public path probe: public paths bypass (actorRef null) → never throttled
    const pub = await t2.app.inject({ method: 'GET', url: '/ping' })
    expect(pub.statusCode).toBe(200)
    await t2.close()
  })
})
