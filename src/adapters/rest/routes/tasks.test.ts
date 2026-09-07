import { describe, expect, it } from 'vitest'
import { makeTestApp, type TestApp } from '#root/testing/test-app'
import { randomBytes } from 'node:crypto'
import { hashToken } from '#root/infra/token-hash'

const bearer = (t: TestApp): Record<string, string> => ({ authorization: `Bearer ${t.adminToken}` })

const newAgent = async (t: TestApp, handle: string): Promise<string> => {
  const raw = randomBytes(32).toString('base64url')
  const now = new Date().toISOString()
  const id = `a_${handle}`
  await t.deps.db
    .insertInto('actors')
    .values({
      id,
      kind: 'agent',
      handle,
      display_name: handle,
      description: '',
      created_at: now,
    })
    .execute()
  await t.deps.db
    .insertInto('tokens')
    .values({
      id: `tok_${handle}`,
      actor_id: id,
      token_hash: hashToken(raw),
      label: 'test',
      created_at: now,
      last_used_at: null,
      revoked_at: null,
    })
    .execute()
  return raw
}

const asAgent = (raw: string): Record<string, string> => ({ authorization: `Bearer ${raw}` })

describe('agent loop over HTTP (spec §7.4, §11.2)', () => {
  it('file → race → split → claim → review → done, with every rejection code', async () => {
    const t = await makeTestApp()

    // 1. human files task
    const filed = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: bearer(t),
      payload: {
        title: 'Add rate limiter',
        acceptance_criteria: 'AC: 429s',
        status: 'todo',
        labels: ['infra'],
      },
    })
    expect(filed.statusCode).toBe(201)
    const task = filed.json()
    expect(task.status).toBe('todo')

    // 2. two agents race to claim — exactly one wins
    const tokenA = await newAgent(t, 'hermes-a')
    const tokenB = await newAgent(t, 'hermes-b')
    const [ra, rb] = await Promise.all([
      t.app.inject({ method: 'POST', url: `/tasks/${task.id}/claim`, headers: asAgent(tokenA) }),
      t.app.inject({ method: 'POST', url: `/tasks/${task.id}/claim`, headers: asAgent(tokenB) }),
    ])
    const winner = ra.statusCode === 200 ? ra : rb
    const loser = ra.statusCode === 200 ? rb : ra
    expect(winner.statusCode).toBe(200)
    expect(loser.statusCode).toBe(409)
    expect(loser.json().code).toBe('already_claimed')
    expect(loser.json().holder_handle).toMatch(/^hermes-/)
    const lease = winner.json().lease_token as string

    // 3. context bundle
    const ctx = await t.app.inject({
      method: 'GET',
      url: `/tasks/${task.id}/context`,
      headers: bearer(t),
    })
    expect(ctx.json().task.acceptance_criteria).toBe('AC: 429s')

    // heartbeat — sent as the winning agent (the plan block's
    // `winner.headers.authorization ? … : {}` was a transcription bug: a response never
    // echoes the request's authorization header, so it always degraded to `{}` → 401)
    const hb = await t.app.inject({
      method: 'POST',
      url: `/tasks/${task.id}/heartbeat`,
      headers: asAgent(ra.statusCode === 200 ? tokenA : tokenB),
      payload: { lease_token: lease },
    })
    expect(hb.statusCode).toBe(200)
    expect(hb.json().last_heartbeat_at).not.toBeNull()

    // 4. split releases the claim; old lease is dead
    const split = await t.app.inject({
      method: 'POST',
      url: `/tasks/${task.id}/split`,
      headers: bearer(t),
      payload: {
        children: [
          { title: 'redis window', status: 'todo' },
          { title: '429 body', status: 'todo' },
        ],
      },
    })
    expect(split.statusCode).toBe(201)
    // (the plan block conflated this `created` destructure with the step-7 audit
    // fetch — transcription bug; the fetch belongs at step 7, see there)
    const [c1, c2] = split.json().created
    const afterSplit = (
      await t.app.inject({ method: 'GET', url: `/tasks/${task.id}`, headers: bearer(t) })
    ).json()
    expect(afterSplit.claim_token_id).toBeNull()
    expect(afterSplit.child_count).toBe(2)

    const stale = await t.app.inject({
      method: 'PATCH',
      url: `/tasks/${c1.id}/status`,
      headers: asAgent(ra.statusCode === 200 ? tokenA : tokenB),
      payload: { status: 'in_review', reason: 'zombie', lease_token: lease },
    })
    expect(stale.statusCode).toBe(412)
    expect(stale.json().code).toBe('stale_lease')
    // full problem shape through the route (Task 13 pin: details spread FIRST, so
    // `claimed` survives; app.test.ts only proves this on a probe route)
    expect(stale.headers['content-type']).toContain('application/problem+json')
    expect(stale.json().claimed).toBe(false) // claim was already released by the split
    expect(stale.json().type).toBe('https://nightshift.local/errors/stale_lease')
    expect(stale.json().title).toBe('stale lease')
    expect(stale.json().status).toBe(412)

    // parent with children is not claimable
    const notLeaf = await t.app.inject({
      method: 'POST',
      url: `/tasks/${task.id}/claim`,
      headers: asAgent(tokenB),
    })
    expect(notLeaf.statusCode).toBe(409)
    expect(notLeaf.json().code).toBe('not_a_leaf')

    // 5. both agents claim children, open PRs, move to review with their own leases
    for (const [child, tok] of [
      [c1, tokenA],
      [c2, tokenB],
    ] as const) {
      const claim = await t.app.inject({
        method: 'POST',
        url: `/tasks/${child.id}/claim`,
        headers: asAgent(tok),
      })
      expect(claim.statusCode).toBe(200)
      // without the lease token: 412
      const noLease = await t.app.inject({
        method: 'PATCH',
        url: `/tasks/${child.id}/status`,
        headers: asAgent(tok),
        payload: { status: 'in_review', reason: 'pr up' },
      })
      expect(noLease.statusCode).toBe(412)
      expect(noLease.json().claimed).toBe(true) // still-claimed sibling of the stale case
      const review = await t.app.inject({
        method: 'PATCH',
        url: `/tasks/${child.id}/status`,
        headers: asAgent(tok),
        payload: { status: 'in_review', reason: 'pr up', lease_token: claim.json().lease_token },
      })
      expect(review.statusCode).toBe(200)
      expect(review.json().claim_token_id).toBeNull() // released on review (D-c)

      // agents may not close (invariant 5)
      const closeByAgent = await t.app.inject({
        method: 'PATCH',
        url: `/tasks/${child.id}/status`,
        headers: asAgent(tok),
        payload: { status: 'done', reason: 'self-merge' },
      })
      expect(closeByAgent.statusCode).toBe(403)
      expect(closeByAgent.json().code).toBe('agent_close_forbidden')
    }

    // parent cannot be done while children are open
    const parentDoneEarly = await t.app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}/status`,
      headers: bearer(t),
      payload: { status: 'done', reason: 'eager' },
    })
    expect(parentDoneEarly.statusCode).toBe(409)
    expect(parentDoneEarly.json().code).toBe('open_descendants')

    // 6. human closes both children, then parent
    for (const child of [c1, c2]) {
      const done = await t.app.inject({
        method: 'PATCH',
        url: `/tasks/${child.id}/status`,
        headers: bearer(t),
        payload: { status: 'done', reason: 'ship it' },
      })
      expect(done.statusCode).toBe(200)
    }
    const parentDone = await t.app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}/status`,
      headers: bearer(t),
      payload: { status: 'done', reason: 'all leaves done' },
    })
    expect(parentDone.statusCode).toBe(200)

    // 7. the audit log reconstructs the story; board rollup is computable
    // (fetched here, at its step-7 point of use: the plan's merged one-liner would
    // have read the log right after the split, missing every later status_changed)
    const audit = (
      await t.app.inject({
        method: 'GET',
        url: `/audit?entity_id=${task.id}&limit=100`,
        headers: bearer(t),
      })
    ).json()
    const actions = audit.map((a: { action: string }) => a.action)
    expect(actions).toEqual(
      expect.arrayContaining([
        'task_created',
        'claim_acquired',
        'claim_released',
        'task_split',
        'status_changed',
      ])
    )
    expect(audit.some((a: { reason: string }) => a.reason === 'claim released by split')).toBe(true)

    const board = (await t.app.inject({ method: 'GET', url: '/tasks', headers: bearer(t) })).json()
    const parent = board.find((x: { id: string }) => x.id === task.id)
    expect(parent.child_count).toBe(2)

    // ready-work query now empty for that label
    const next = (
      await t.app.inject({ method: 'GET', url: '/tasks/next?label=infra', headers: bearer(t) })
    ).json()
    expect(next).toEqual([])

    await t.close()
  })

  it('validation and idempotency at the API level', async () => {
    const t = await makeTestApp()
    const bad = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: bearer(t),
      payload: {},
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('invalid_request')

    // M-2 pin: the ROUTE schema, not the use-case, owns title length validation —
    // empty and over-long titles die at AJV (the use-case deliberately does not check)
    const emptyTitle = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: bearer(t),
      payload: { title: '' },
    })
    expect(emptyTitle.statusCode).toBe(400)
    expect(emptyTitle.json().code).toBe('invalid_request')
    const longTitle = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: bearer(t),
      payload: { title: 'x'.repeat(301) },
    })
    expect(longTitle.statusCode).toBe(400)
    expect(longTitle.json().code).toBe('invalid_request')

    // pin: unknown status is an AJV 400 problem, never the use-case's invalid_request
    const badStatus = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: bearer(t),
      payload: { title: 'ok', status: 'banana' },
    })
    expect(badStatus.statusCode).toBe(400)
    expect(badStatus.json().code).toBe('invalid_request')
    expect(badStatus.json().detail).not.toContain("unknown status 'banana'")
    const badStatusPatch = await t.app.inject({
      method: 'PATCH',
      url: '/tasks/t_nope/status',
      headers: bearer(t),
      payload: { status: 'banana', reason: 'x' },
    })
    expect(badStatusPatch.statusCode).toBe(400)
    expect(badStatusPatch.json().code).toBe('invalid_request')
    expect(badStatusPatch.json().detail).not.toContain("unknown status 'banana'")

    const headers = { ...bearer(t), 'idempotency-key': 'file-1' }
    const a = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers,
      payload: { title: 'dup-safe' },
    })
    const b = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers,
      payload: { title: 'dup-safe' },
    })
    expect(a.body).toBe(b.body) // replay — no double-file (spec §7.3)

    await t.close()
  })

  // The §7.4 loop leaves these two handlers untouched (it never PATCHes content or
  // releases manually); the new-file coverage rule demands they be exercised.
  it('content patch and manual release work over HTTP', async () => {
    const t = await makeTestApp()
    const filed = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: bearer(t),
      payload: { title: 'patchable', acceptance_criteria: 'old', status: 'todo' },
    })
    expect(filed.statusCode).toBe(201)
    const id = filed.json().id

    const patched = await t.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      headers: bearer(t),
      payload: { title: 'patched', acceptance_criteria: 'new', blocked_flag: true },
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().title).toBe('patched')
    expect(patched.json().acceptance_criteria).toBe('new')
    expect(patched.json().blocked_flag).toBe(true)
    expect(patched.json().child_count).toBe(0) // DTO, not raw record

    // M-2 again on the PATCH side: empty title dies at the route schema
    const emptyPatch = await t.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      headers: bearer(t),
      payload: { title: '' },
    })
    expect(emptyPatch.statusCode).toBe(400)
    expect(emptyPatch.json().code).toBe('invalid_request')

    const token = await newAgent(t, 'release-bot')
    const claim = await t.app.inject({
      method: 'POST',
      url: `/tasks/${id}/claim`,
      headers: asAgent(token),
    })
    expect(claim.statusCode).toBe(200)
    const released = await t.app.inject({
      method: 'POST',
      url: `/tasks/${id}/release`,
      headers: asAgent(token),
    })
    expect(released.statusCode).toBe(200)
    expect(released.json().claim_token_id).toBeNull()

    // route-composed DomainError (not a use-case throw) still maps to problem+json
    const ghost = await t.app.inject({
      method: 'GET',
      url: '/tasks/t_ghost',
      headers: bearer(t),
    })
    expect(ghost.statusCode).toBe(404)
    expect(ghost.json().code).toBe('not_found')

    await t.close()
  })
})
