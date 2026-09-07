import { describe, expect, it } from 'vitest'
import { makeTestApp } from '#root/testing/test-app'

describe('Idempotency-Key middleware (spec §7.3)', () => {
  const setup = async () => {
    const t = await makeTestApp()
    // routes are added before the first inject, which is what boots the app
    t.app.post('/idem-echo', async () => ({ ok: true, stamp: Math.random() }))
    return t
  }

  it('replays the stored response for a repeated key', async () => {
    const t = await setup()
    const headers = { authorization: `Bearer ${t.adminToken}`, 'idempotency-key': 'k-1' }
    const first = await t.app.inject({ method: 'POST', url: '/idem-echo', headers })
    const second = await t.app.inject({ method: 'POST', url: '/idem-echo', headers })
    expect(second.statusCode).toBe(first.statusCode)
    expect(second.body).toBe(first.body) // byte-identical replay
    expect(second.headers['content-type']).toContain('application/json')
    await t.close()
  })

  it('different keys are independent; no key = no dedupe', async () => {
    const t = await setup()
    const base = { authorization: `Bearer ${t.adminToken}` }
    const a = await t.app.inject({
      method: 'POST',
      url: '/idem-echo',
      headers: { ...base, 'idempotency-key': 'k-a' },
    })
    const b = await t.app.inject({
      method: 'POST',
      url: '/idem-echo',
      headers: { ...base, 'idempotency-key': 'k-b' },
    })
    expect(a.body).not.toBe(b.body)
    const noKey = await t.app.inject({ method: 'POST', url: '/idem-echo', headers: base })
    const noKey2 = await t.app.inject({ method: 'POST', url: '/idem-echo', headers: base })
    expect(noKey.body).not.toBe(noKey2.body)
    await t.close()
  })

  it('in-flight duplicate is rejected 409 idempotency_in_flight', async () => {
    const t = await setup()
    await t.deps.idemRoot.reserve({
      actor_id: 'a_nils',
      idem_key: 'k-busy',
      request_method: 'POST',
      request_path: '/idem-echo',
      created_at: new Date().toISOString(),
    })
    const res = await t.app.inject({
      method: 'POST',
      url: '/idem-echo',
      headers: { authorization: `Bearer ${t.adminToken}`, 'idempotency-key': 'k-busy' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('idempotency_in_flight')
    await t.close()
  })

  it('oversized or blank keys are ignored (no reservation made)', async () => {
    const t = await setup()
    const base = { authorization: `Bearer ${t.adminToken}` }
    const blank = await t.app.inject({
      method: 'POST',
      url: '/idem-echo',
      headers: { ...base, 'idempotency-key': '' },
    })
    const oversized = await t.app.inject({
      method: 'POST',
      url: '/idem-echo',
      headers: { ...base, 'idempotency-key': 'x'.repeat(201) },
    })
    expect(blank.statusCode).toBe(200)
    expect(oversized.statusCode).toBe(200)
    const rows = await t.deps.db.selectFrom('idempotency_keys').selectAll().execute()
    expect(rows).toEqual([])
    await t.close()
  })

  it('a 204 response completes the key instead of stranding it (D-j)', async () => {
    const t = await setup()
    t.app.delete('/idem-quiet', async (_req, reply) => reply.code(204).send())
    const headers = { authorization: `Bearer ${t.adminToken}`, 'idempotency-key': 'k-204' }
    const first = await t.app.inject({ method: 'DELETE', url: '/idem-quiet', headers })
    expect(first.statusCode).toBe(204)
    const replay = await t.app.inject({ method: 'DELETE', url: '/idem-quiet', headers })
    expect(replay.statusCode).toBe(204)
    expect(replay.body).toBe(first.body)
    await t.close()
  })

  it('a Buffer payload completes as its utf8 text and replays identically', async () => {
    const t = await setup()
    t.app.put('/idem-blob', async (_req, reply) => {
      reply.header('content-type', 'text/plain')
      return reply.send(Buffer.from('blob-body'))
    })
    const headers = { authorization: `Bearer ${t.adminToken}`, 'idempotency-key': 'k-blob' }
    const first = await t.app.inject({ method: 'PUT', url: '/idem-blob', headers })
    expect(first.body).toBe('blob-body')
    const replay = await t.app.inject({ method: 'PUT', url: '/idem-blob', headers })
    expect(replay.statusCode).toBe(first.statusCode)
    expect(replay.body).toBe('blob-body')
    await t.close()
  })

  it('5xx deletes the reservation so retries re-execute (D-j)', async () => {
    const t = await setup()
    t.app.post('/idem-boom', async () => {
      throw new Error('boom')
    })
    const headers = { authorization: `Bearer ${t.adminToken}`, 'idempotency-key': 'k-boom' }
    const first = await t.app.inject({ method: 'POST', url: '/idem-boom', headers })
    expect(first.statusCode).toBe(500)
    expect(first.headers['content-type']).toContain('application/problem+json')
    const outcome = await t.deps.idemRoot.reserve({
      actor_id: 'a_nils',
      idem_key: 'k-boom',
      request_method: 'POST',
      request_path: '/idem-boom',
      created_at: new Date().toISOString(),
    })
    expect(outcome).toEqual({ state: 'reserved' }) // free again
    await t.close()
  })
})
