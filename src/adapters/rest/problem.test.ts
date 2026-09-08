import { describe, expect, it } from 'vitest'
import { makeTestApp } from '#root/testing/test-app'

const nils = (t: { adminToken: string }): Record<string, string> => ({
  authorization: `Bearer ${t.adminToken}`,
})

describe('adapter error mapping (backlog: 413/415 surfaced as 500)', () => {
  it('unparseable content-type on a JSON route → 415 problem unsupported_media_type', async () => {
    // application/x-sh never gets a content-type parser — fastify's defaults cover
    // application/json + text/plain (text/plain alone would parse and 400 at validation)
    const t = await makeTestApp()
    const res = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { ...nils(t), 'content-type': 'application/x-sh' },
      payload: 'echo hello',
    })
    expect(res.statusCode).toBe(415)
    expect(res.headers['content-type']).toContain('application/problem+json')
    expect(res.json().code).toBe('unsupported_media_type')
    await t.close()
  })

  it('body over the route limit → 413 problem payload_too_large', async () => {
    const t = await makeTestApp()
    // bodyLimit is a direct route option (fastify lib/route.js: opts.bodyLimit),
    // NOT route config — { config: { bodyLimit } } is silently inert
    t.app.post('/probe-body-limit', { bodyLimit: 8 }, async () => ({ ok: true }))
    const res = await t.app.inject({
      method: 'POST',
      url: '/probe-body-limit',
      headers: nils(t),
      payload: { s: '0123456789' },
    })
    expect(res.statusCode).toBe(413)
    expect(res.json().code).toBe('payload_too_large')
    await t.close()
  })

  it('unknown thrown error still funnels to 500 internal_error (no regression)', async () => {
    const t = await makeTestApp()
    t.app.get('/probe-boom', async () => {
      throw new Error('kaboom')
    })
    const res = await t.app.inject({ method: 'GET', url: '/probe-boom', headers: nils(t) })
    expect(res.statusCode).toBe(500)
    expect(res.json().code).toBe('internal_error')
    await t.close()
  })
})
