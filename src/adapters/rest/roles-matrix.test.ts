// src/adapters/rest/roles-matrix.test.ts
// The fourteen admin ops (ten + the three D-tt allow-list ops + the #23 role
// switch) + the exact
// rejection shape. Member => 403 with the pinned
// string; admin (t.adminToken) => today's behavior byte-unchanged (covered by
// the existing admin suites staying green). Members keep EVERYTHING else —
// the positive control is the same member 201 on POST /tasks.
import { describe, expect, it } from 'vitest'
import type { FastifyReply, FastifyRequest, InjectOptions } from 'fastify'
import { makeTestApp } from '#root/testing/test-app'
import { seedActor, seedToken } from '#root/testing/fixtures'
import { hashToken } from '#root/infra/token-hash'
import { requireAdmin } from '#root/adapters/rest/auth'

const ADMIN_OPS: ReadonlyArray<{ m: string; url: string; body?: unknown }> = [
  { m: 'GET', url: '/admin/actors' },
  { m: 'POST', url: '/admin/actors', body: { kind: 'agent', handle: 'h', display_name: 'H' } },
  // issue #23: the role switch joins the pinned set (thirteen -> fourteen)
  { m: 'PATCH', url: '/admin/actors/a_nils', body: { role: 'member' } },
  { m: 'POST', url: '/admin/actors/a_nils/tokens', body: { label: 'l' } },
  { m: 'POST', url: '/admin/tokens/tok_nils/revoke' },
  { m: 'GET', url: '/admin/policy/review_gate' },
  { m: 'PUT', url: '/admin/policy/review_gate', body: { value: 'on' } },
  // D-tt: the three allow-list ops join the pinned set (ten -> thirteen)
  { m: 'GET', url: '/admin/allowlist' },
  { m: 'POST', url: '/admin/allowlist', body: { email: 'x@y.example' } },
  { m: 'DELETE', url: '/admin/allowlist/x@y.example' },
  { m: 'GET', url: '/admin/webhooks' },
  { m: 'POST', url: '/admin/webhooks', body: { agent_id: 'a_none', url: 'http://x.example/h' } },
  { m: 'POST', url: '/admin/webhooks/w_none/rotate-secret' },
  { m: 'DELETE', url: '/admin/webhooks/w_none' },
]

describe('D-ss role matrix — role enforcement is an additional, separately pinned gate', () => {
  // member human seeded via seedActor (role member) + seedToken — bearer headers
  const memberApp = async () => {
    const t = await makeTestApp()
    await seedActor(t.deps.db, 'a_member', 'human', 'member', 'member')
    await seedToken(t.deps.db, 'tok_member', 'a_member', hashToken('member_raw_token'))
    return t
  }

  it('every one of the fourteen admin ops answers 403 to a member — one string, pinned', async () => {
    const t = await memberApp()
    expect(ADMIN_OPS).toHaveLength(14) // the exact-set duty: this matrix IS the fourteen ops
    for (const op of ADMIN_OPS) {
      const opts: InjectOptions = {
        method: op.m as InjectOptions['method'],
        url: op.url,
        headers: { authorization: 'Bearer member_raw_token' },
      }
      if (op.body !== undefined) opts.payload = op.body as Record<string, unknown>
      const res = await t.app.inject(opts)
      // object-equal shape so a failure names the op that opened (or wrongly closed)
      expect({
        op: `${op.m} ${op.url}`,
        status: res.statusCode,
        code: res.json().code,
        detail: res.json().detail,
      }).toEqual({
        op: `${op.m} ${op.url}`,
        status: 403,
        code: 'forbidden',
        detail: 'this endpoint requires the admin role (spec §5)',
      })
    }
    await t.close()
  })

  it('no widening: the same member keeps the rest of the board (POST /tasks => 201)', async () => {
    const t = await memberApp()
    const res = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { authorization: 'Bearer member_raw_token' },
      payload: { title: 'member work', status: 'todo' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().created_by).toBe('a_member')
    await t.close()
  })
})

describe('requireAdmin guard (same R4 async shape as requireHuman)', () => {
  // stub requests: requireAdmin only reads actorRef?.role (mirrors auth.test.ts guards)
  const req = (actorRef: unknown) => ({ actorRef }) as unknown as FastifyRequest

  it('demands role admin: null, agent, member all 403; admin resolves', async () => {
    const reply = {} as FastifyReply
    const forbidden = expect.objectContaining({ code: 'forbidden' })
    await expect(requireAdmin(req(null), reply)).rejects.toThrowError(forbidden)
    await expect(
      requireAdmin(
        req({ id: 'a', kind: 'agent', handle: 'h', display_name: 'H', role: null }),
        reply
      )
    ).rejects.toThrowError(forbidden)
    await expect(
      requireAdmin(
        req({ id: 'a', kind: 'human', handle: 'm', display_name: 'M', role: 'member' }),
        reply
      )
    ).rejects.toThrowError(forbidden)
    await expect(
      requireAdmin(
        req({ id: 'a', kind: 'human', handle: 'h', display_name: 'H', role: 'admin' }),
        reply
      )
    ).resolves.toBeUndefined()
  })
})
