import { describe, expect, it } from 'vitest'
import { makeTestApp } from '#root/testing/test-app'
import { DomainError } from '#root/domain/errors'

describe('app', () => {
  it('answers ping without auth', async () => {
    const t = await makeTestApp()
    const res = await t.app.inject({ method: 'GET', url: '/ping' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ pong: 'it worked!' })
    await t.close()
  })

  it('serves audit with bearer auth', async () => {
    const t = await makeTestApp()
    const anon = await t.app.inject({ method: 'GET', url: '/audit' })
    expect(anon.statusCode).toBe(401)
    expect(anon.headers['content-type']).toContain('application/problem+json')
    expect(anon.json().code).toBe('unauthenticated')

    const ok = await t.app.inject({
      method: 'GET',
      url: '/audit',
      headers: { authorization: `Bearer ${t.adminToken}` },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual([])
    await t.close()
  })

  it('answers unknown routes with a problem+json 404 (never the fastify default)', async () => {
    const t = await makeTestApp()
    const headers = { authorization: `Bearer ${t.adminToken}` }
    const missing = await t.app.inject({ method: 'GET', url: '/nope', headers })
    expect(missing.statusCode).toBe(404)
    expect(missing.headers['content-type']).toContain('application/problem+json')
    expect(missing.json().code).toBe('not_found')

    // fastify 5 answers method mismatch with 404 by design (fastify#862):
    // the not-found handler still owns the response, so it is problem+json too.
    const mismatch = await t.app.inject({ method: 'DELETE', url: '/ping', headers })
    expect(mismatch.statusCode).toBe(404)
    expect(mismatch.headers['content-type']).toContain('application/problem+json')
    expect(mismatch.json().code).toBe('not_found')
    await t.close()
  })

  it('spreads DomainError details into the problem body and never leaks 500 causes', async () => {
    const t = await makeTestApp()
    // probe routes (registered before the first inject boots the app)
    t.app.get('/p-stale', async () => {
      throw new DomainError('stale_lease', 'lease lost', { claimed: false })
    })
    t.app.get('/p-boom', async () => {
      throw new Error('super secret connection string')
    })
    const headers = { authorization: `Bearer ${t.adminToken}` }
    const stale = await t.app.inject({ method: 'GET', url: '/p-stale', headers })
    expect(stale.statusCode).toBe(412)
    expect(stale.json().code).toBe('stale_lease')
    expect(stale.json().claimed).toBe(false) // Task 14/17 assert this flag
    const boom = await t.app.inject({ method: 'GET', url: '/p-boom', headers })
    expect(boom.statusCode).toBe(500)
    expect(boom.json().code).toBe('internal_error')
    expect(boom.json().detail).toBe('internal error') // cause stays server-side
    expect(boom.body).not.toContain('secret')
    await t.close()
  })

  it('passes through plugin-style statusErrors (bare 401) as problem+json', async () => {
    const t = await makeTestApp()
    t.app.get('/p-401', async () => {
      // Plan E session plugins will throw plain statusErrors, not DomainErrors
      throw Object.assign(new Error('session expired'), { statusCode: 401 })
    })
    const res = await t.app.inject({
      method: 'GET',
      url: '/p-401',
      headers: { authorization: `Bearer ${t.adminToken}` },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('unauthenticated')
    expect(res.json().detail).toBe('session expired')
    await t.close()
  })

  it('maps malformed JSON bodies to 400 invalid_request (bare statusError path)', async () => {
    const t = await makeTestApp()
    t.app.post('/p-json', async () => ({ ok: true }))
    const res = await t.app.inject({
      method: 'POST',
      url: '/p-json',
      headers: { authorization: `Bearer ${t.adminToken}`, 'content-type': 'application/json' },
      body: '{oops',
    })
    expect(res.statusCode).toBe(400)
    expect(res.headers['content-type']).toContain('application/problem+json')
    expect(res.json().code).toBe('invalid_request')
    await t.close()
  })

  it('maps schema validation failures to 400 invalid_request problem+json', async () => {
    const t = await makeTestApp()
    const res = await t.app.inject({
      method: 'GET',
      url: '/audit?limit=0', // schema minimum is 1
      headers: { authorization: `Bearer ${t.adminToken}` },
    })
    expect(res.statusCode).toBe(400)
    expect(res.headers['content-type']).toContain('application/problem+json')
    expect(res.json().code).toBe('invalid_request')
    await t.close()
  })
})
