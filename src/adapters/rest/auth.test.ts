import { describe, expect, it } from 'vitest'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { makeTestApp } from '#root/testing/test-app'
import { hashToken } from '#root/infra/token-hash'
import { actorCtx, requireHuman } from '#root/adapters/rest/auth'

describe('auth', () => {
  it('rejects missing, malformed, and unknown tokens with problem+json 401', async () => {
    const t = await makeTestApp()
    for (const headers of [
      undefined,
      { authorization: 'Basic dXNlcjpwYXNz' },
      { authorization: 'Bearer nope' },
    ]) {
      const res = await t.app.inject({ method: 'GET', url: '/audit', headers })
      expect(res.statusCode).toBe(401)
      expect(res.headers['content-type']).toContain('application/problem+json')
      expect(res.json().code).toBe('unauthenticated')
      expect(res.json().status).toBe(401)
    }
    await t.close()
  })

  it('records token last-used on auth', async () => {
    const t = await makeTestApp()
    const res = await t.app.inject({
      method: 'GET',
      url: '/audit',
      headers: { authorization: `Bearer ${t.adminToken}` },
    })
    expect(res.statusCode).toBe(200)
    const tok = await t.deps.actorsRoot.findActiveTokenByHash(hashToken(t.adminToken))
    expect(tok?.token.last_used_at).not.toBeNull()
    await t.close()
  })

  it('revoked tokens are rejected', async () => {
    const t = await makeTestApp()
    await t.deps.actorsRoot.revokeToken('tok_nils', new Date().toISOString())
    const res = await t.app.inject({
      method: 'GET',
      url: '/audit',
      headers: { authorization: `Bearer ${t.adminToken}` },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('unauthenticated')
    await t.close()
  })
})

describe('auth guards', () => {
  // stub requests: requireHuman/actorCtx only read actorRef/tokenId
  const req = (actorRef: unknown, tokenId: string | null = null) =>
    ({ actorRef, tokenId }) as unknown as FastifyRequest

  it('requireHuman demands a human actor (spec D-h)', () => {
    const reply = {} as FastifyReply
    expect(() => requireHuman(req(null), reply)).toThrowError(
      expect.objectContaining({ code: 'forbidden' })
    )
    expect(() =>
      requireHuman(req({ id: 'a', kind: 'agent', handle: 'h', display_name: 'H' }), reply)
    ).toThrowError(expect.objectContaining({ code: 'forbidden' }))
    expect(() =>
      requireHuman(req({ id: 'a', kind: 'human', handle: 'h', display_name: 'H' }), reply)
    ).not.toThrow()
  })

  it('actorCtx demands authentication and forwards the real tokenId', () => {
    expect(() => actorCtx(req(null))).toThrowError(
      expect.objectContaining({ code: 'unauthenticated' })
    )
    const actor = { id: 'a', kind: 'agent' as const, handle: 'h', display_name: 'H' }
    expect(actorCtx(req(actor, 'tok_1'))).toEqual({ actor, tokenId: 'tok_1' })
  })
})
