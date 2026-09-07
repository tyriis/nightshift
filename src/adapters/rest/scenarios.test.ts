import { describe, expect, it } from 'vitest'
import { makeTestApp, type TestApp } from '#root/testing/test-app'

const bearer = (t: TestApp, token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
})

const createActor = async (t: TestApp, kind: 'human' | 'agent', handle: string): Promise<string> =>
  (
    await t.app.inject({
      method: 'POST',
      url: '/admin/actors',
      headers: bearer(t, t.adminToken),
      payload: { kind, handle, display_name: handle },
    })
  ).json().id as string

const issueToken = async (t: TestApp, actorId: string): Promise<string> =>
  (
    await t.app.inject({
      method: 'POST',
      url: `/admin/actors/${actorId}/tokens`,
      headers: bearer(t, t.adminToken),
      payload: { label: 'acceptance' },
    })
  ).json().raw_token as string

describe('acceptance (spec §14 — agent side; human OIDC login and threads arrive in Plans B/E)', () => {
  it('full multi-actor story: file, race, split, parallel work, review gate, audit story', async () => {
    const t = await makeTestApp()
    const nils = bearer(t, t.adminToken) // bootstrap human

    // §14.1 — admin enables a second human + creates agent hermes-1 (two tokens = two sessions)
    const anaId = await createActor(t, 'human', 'ana')
    expect(anaId).toMatch(/^a_[a-z0-9]{16}$/)
    const anaToken = await issueToken(t, anaId)
    const hermes = await createActor(t, 'agent', 'hermes-1')
    const sess1 = await issueToken(t, hermes)
    const sess2 = await issueToken(t, hermes)

    // §14.2 — human files task with AC → todo (spec.md upload is Plan B)
    const task = (
      await t.app.inject({
        method: 'POST',
        url: '/tasks',
        headers: nils,
        payload: {
          title: 'Rate limiter',
          description: 'protect /api',
          acceptance_criteria: '429 under load',
          status: 'todo',
        },
      })
    ).json()

    // §14.3 — two concurrent sessions race: exactly one wins
    const [r1, r2] = await Promise.all([
      t.app.inject({ method: 'POST', url: `/tasks/${task.id}/claim`, headers: bearer(t, sess1) }),
      t.app.inject({ method: 'POST', url: `/tasks/${task.id}/claim`, headers: bearer(t, sess2) }),
    ])
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 409])
    const winner = r1.statusCode === 200 ? r1 : r2
    const loser = r1.statusCode === 200 ? r2 : r1
    expect(winner.json().lease_token).toBe(`${task.id}:1`) // first claim ⇒ generation 1
    expect(loser.json().code).toBe('already_claimed')
    expect(loser.json().holder_handle).toBe('hermes-1')

    // §14.4 — winner splits into 2 children; claim auto-released; claims a child
    const split = (
      await t.app.inject({
        method: 'POST',
        url: `/tasks/${task.id}/split`,
        headers: bearer(t, sess1),
        payload: {
          children: [
            { title: 'redis window', acceptance_criteria: 'sliding', status: 'todo' },
            { title: '429 payload', acceptance_criteria: 'RFC', status: 'todo' },
          ],
        },
      })
    ).json()
    const parentAfter = (
      await t.app.inject({ method: 'GET', url: `/tasks/${task.id}`, headers: nils })
    ).json()
    expect(parentAfter.claim_token_id).toBeNull()
    const c1 = split.created[0].id as string
    const c2 = split.created[1].id as string
    const c1Claim = await t.app.inject({
      method: 'POST',
      url: `/tasks/${c1}/claim`,
      headers: bearer(t, sess1),
    })
    expect(c1Claim.statusCode).toBe(200)

    // §14.5 — question gate seam: no threads exist in Plan A, so review proceeds (gate wired in B)

    // §14.6 — second session claims the sibling; each session reviews with its own live lease
    const c2Claim = await t.app.inject({
      method: 'POST',
      url: `/tasks/${c2}/claim`,
      headers: bearer(t, sess2),
    })
    expect(c2Claim.statusCode).toBe(200)
    for (const [child, tok, lease] of [
      [c1, sess1, c1Claim.json().lease_token as string],
      [c2, sess2, c2Claim.json().lease_token as string],
    ] as const) {
      expect(
        (
          await t.app.inject({
            method: 'PATCH',
            url: `/tasks/${child}/status`,
            headers: bearer(t, tok),
            payload: { status: 'in_review', reason: 'PR ready', lease_token: lease },
          })
        ).statusCode
      ).toBe(200)
    }

    // agents still cannot close:
    expect(
      (
        await t.app.inject({
          method: 'PATCH',
          url: `/tasks/${c1}/status`,
          headers: bearer(t, sess1),
          payload: { status: 'done', reason: 'nope' },
        })
      ).json().code
    ).toBe('agent_close_forbidden')

    for (const child of [c1, c2]) {
      expect(
        (
          await t.app.inject({
            method: 'PATCH',
            url: `/tasks/${child}/status`,
            headers: bearer(t, anaToken),
            payload: { status: 'done', reason: 'reviewed, LGTM' },
          })
        ).statusCode
      ).toBe(200)
    }
    expect(
      (
        await t.app.inject({
          method: 'PATCH',
          url: `/tasks/${task.id}/status`,
          headers: nils,
          payload: { status: 'done', reason: 'all leaves done' },
        })
      ).statusCode
    ).toBe(200)

    // §14.7 — audit reconstructs the story; rollups visible; nothing hidden (ana sees nils' actions)
    const audit = (
      await t.app.inject({ method: 'GET', url: '/audit?limit=200', headers: bearer(t, anaToken) })
    ).json()
    const story = audit.map((a: { action: string }) => a.action)
    expect(story).toEqual(
      expect.arrayContaining([
        'actor_created',
        'token_created',
        'task_created',
        'claim_acquired',
        'claim_released',
        'task_split',
        'status_changed',
      ])
    )
    // release reasons pinned at use-case level (grep-exact — do not paraphrase):
    expect(audit.some((a: { reason: string }) => a.reason === 'claim released by split')).toBe(true)
    expect(audit.some((a: { reason: string }) => a.reason === 'claim released on review')).toBe(
      true
    )
    // lower bounds only — STATE is reconstructed from the tables below, never from audit counts
    expect(story.filter((a: string) => a === 'claim_acquired').length).toBeGreaterThanOrEqual(3)
    expect(story.filter((a: string) => a === 'status_changed').length).toBeGreaterThanOrEqual(5)

    const board = (
      await t.app.inject({ method: 'GET', url: '/tasks', headers: bearer(t, anaToken) })
    ).json()
    const parent = board.find((x: { id: string }) => x.id === task.id)
    expect(parent.status).toBe('done')
    expect(parent.child_count).toBe(2)
    expect(
      board
        .filter((x: { parent_id: string | null }) => x.parent_id === task.id)
        .every((x: { status: string }) => x.status === 'done')
    ).toBe(true)
    expect(
      (
        await t.app.inject({ method: 'GET', url: '/tasks/next', headers: bearer(t, anaToken) })
      ).json()
    ).toEqual([])

    await t.close()
  })
})
