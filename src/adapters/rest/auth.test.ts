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

  it('public-path lookup tolerates slash spellings while protected paths stay fail-closed (Task 16)', async () => {
    const t = await makeTestApp()
    // PUBLIC_PATHS membership stays EXACTLY {/ping, /openapi.yaml} (binding); the
    // LOOKUP normalizes. Slash variants of a public path PASS AUTH (the block's effect:
    // no 401) — the router itself is strict (ignoreTrailingSlash unset, out of this
    // block's scope), so the variant answers 404 from routing, never the auth wall.
    const exact = await t.app.inject({ method: 'GET', url: '/ping' })
    expect(exact.statusCode).toBe(200)
    for (const url of ['/ping/', '/ping//', '//ping']) {
      const res = await t.app.inject({ method: 'GET', url })
      expect([200, 404]).toContain(res.statusCode) // never 401: the auth gate opened
      expect(res.json().code ?? 'served').not.toBe('unauthenticated')
    }
    // fail-closed: normalization matches MORE public spellings, never fewer auth walls —
    // '/audit/' without a token still answers 401, in every slash spelling
    for (const url of ['/audit/', '/audit//']) {
      const res = await t.app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(401)
      expect(res.json().code).toBe('unauthenticated')
    }
    // with auth the wall is passed — the router answers 404 (no trailing-slash route;
    // the block guessed 200, the probe says 404): auth opened, nothing leaked
    const authed = await t.app.inject({
      method: 'GET',
      url: '/audit/',
      headers: { authorization: `Bearer ${t.adminToken}` },
    })
    expect(authed.statusCode).toBe(404)
    expect(authed.json().code).toBe('not_found')
    await t.close()
  })
})

describe('auth guards', () => {
  // stub requests: requireHuman/actorCtx only read actorRef/tokenId
  const req = (actorRef: unknown, tokenId: string | null = null) =>
    ({ actorRef, tokenId }) as unknown as FastifyRequest

  it('requireHuman demands a human actor (spec D-h)', async () => {
    const reply = {} as FastifyReply
    await expect(requireHuman(req(null), reply)).rejects.toThrowError(
      expect.objectContaining({ code: 'forbidden' })
    )
    await expect(
      requireHuman(req({ id: 'a', kind: 'agent', handle: 'h', display_name: 'H' }), reply)
    ).rejects.toThrowError(expect.objectContaining({ code: 'forbidden' }))
    await expect(
      requireHuman(req({ id: 'a', kind: 'human', handle: 'h', display_name: 'H' }), reply)
    ).resolves.toBeUndefined()
  })

  it('actorCtx demands authentication and forwards the real tokenId', () => {
    expect(() => actorCtx(req(null))).toThrowError(
      expect.objectContaining({ code: 'unauthenticated' })
    )
    const actor = { id: 'a', kind: 'agent' as const, handle: 'h', display_name: 'H' }
    expect(actorCtx(req(actor, 'tok_1'))).toEqual({ actor, tokenId: 'tok_1' })
  })
})
