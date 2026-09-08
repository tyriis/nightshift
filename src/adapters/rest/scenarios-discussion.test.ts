import { describe, expect, it } from 'vitest'
import { makeTestApp, type TestApp } from '#root/testing/test-app'

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

describe('acceptance — threads, questions, attachments (spec §14 steps 2, 5, 6)', () => {
  it('file → upload spec → agent asks question (gates review) → human answers → PR link → in_review → done', async () => {
    const t = await makeTestApp()
    const nils = bearer(t.adminToken)
    // actors: ana (human, second circle member) + hermes-1 agent with a token
    const anaId = (
      await t.app.inject({
        method: 'POST',
        url: '/admin/actors',
        headers: nils,
        payload: { kind: 'human', handle: 'ana', display_name: 'Ana' },
      })
    ).json().id as string
    const anaToken = (
      await t.app.inject({
        method: 'POST',
        url: `/admin/actors/${anaId}/tokens`,
        headers: nils,
        payload: { label: 'ana-session' },
      })
    ).json().raw_token as string
    const hermesId = (
      await t.app.inject({
        method: 'POST',
        url: '/admin/actors',
        headers: nils,
        payload: { kind: 'agent', handle: 'hermes-1', display_name: 'Hermes' },
      })
    ).json().id as string
    const sess = bearer(
      (
        await t.app.inject({
          method: 'POST',
          url: `/admin/actors/${hermesId}/tokens`,
          headers: nils,
          payload: { label: 'session-1' },
        })
      ).json().raw_token as string
    )

    // §14.2 — human files task + uploads spec.md attachment → todo
    const task = (
      await t.app.inject({
        method: 'POST',
        url: '/tasks',
        headers: nils,
        payload: { title: 'Rate limiter', acceptance_criteria: '429 under load', status: 'todo' },
      })
    ).json()
    const upload = await t.app.inject({
      method: 'POST',
      url: `/tasks/${task.id}/attachments?filename=spec.md&content_type=text/markdown`,
      headers: { ...nils, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('# Rate limiter\nprotect /api\n'),
    })
    expect(upload.statusCode).toBe(201)

    // agent claims, plans in a note (mention ana), context bundle shows the file
    const claim = (
      await t.app.inject({ method: 'POST', url: `/tasks/${task.id}/claim`, headers: sess })
    ).json()
    const note = await t.app.inject({
      method: 'POST',
      url: `/tasks/${task.id}/threads`,
      headers: sess,
      payload: { kind: 'note', body: 'starting; plan in spec.md — @ana FYI' },
    })
    expect(note.statusCode).toBe(201) // self-naming: a failing step names itself, not a downstream audit mismatch
    const context = (
      await t.app.inject({ method: 'GET', url: `/tasks/${task.id}/context`, headers: sess })
    ).json()
    expect(context.attachments.map((a: { filename: string }) => a.filename)).toContain('spec.md')

    // ana sees the mention in HER inbox
    const inbox = (
      await t.app.inject({ method: 'GET', url: '/inbox', headers: bearer(anaToken) })
    ).json()
    expect(inbox.map((i: { kind: string }) => i.kind)).toEqual(['mentioned'])

    // §14.5 — agent asks a question assigned to a human → gates review
    const q = (
      await t.app.inject({
        method: 'POST',
        url: `/tasks/${task.id}/threads`,
        headers: sess,
        payload: {
          kind: 'question',
          body: '429 body shape — JSON problem or plain?',
          assignee_handle: 'ana',
        },
      })
    ).json()
    const blocked = await t.app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}/status`,
      headers: sess,
      payload: { status: 'in_review', reason: 'pr ready', lease_token: claim.lease_token },
    })
    expect(blocked.statusCode).toBe(409)
    // the T12-verified flat envelope: problem.ts spreads details top-level beside code
    expect(blocked.json()).toMatchObject({ code: 'open_questions', open: 1 })

    // ana answers (her own inbox shows the question_assigned too), resolves
    const qInbox = (
      await t.app.inject({
        method: 'GET',
        url: '/inbox?unread_only=true',
        headers: bearer(anaToken),
      })
    ).json()
    expect(qInbox.map((i: { kind: string }) => i.kind)).toContain('question_assigned')
    const answered = await t.app.inject({
      method: 'POST',
      url: `/tasks/${task.id}/threads/${q.thread.id}/answer`,
      headers: bearer(anaToken),
      payload: { body: 'RFC 9457 problem+json' },
    })
    expect(answered.statusCode).toBe(200)
    const resolved = await t.app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}/threads/${q.thread.id}`,
      headers: bearer(anaToken),
      payload: { state: 'resolved' },
    })
    expect(resolved.statusCode).toBe(200) // self-naming: the gate-lift step reports itself

    // §14.6 — agent links the PR, moves to in_review (auto-releases claim), human closes
    const link = await t.app.inject({
      method: 'POST',
      url: `/tasks/${task.id}/links`,
      headers: sess,
      payload: { kind: 'pr', url: 'https://git.example/nightshift/pr/1' },
    })
    expect(link.statusCode).toBe(201)
    const review = await t.app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}/status`,
      headers: sess,
      payload: { status: 'in_review', reason: 'pr ready', lease_token: claim.lease_token },
    })
    expect(review.statusCode).toBe(200)
    const done = await t.app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}/status`,
      headers: nils,
      payload: { status: 'done', reason: 'verified' },
    })
    expect(done.statusCode).toBe(200)

    // audit reconstructs the story; question rows carry their state path
    const audit = (
      await t.app.inject({
        method: 'GET',
        url: `/audit?entity_id=${q.thread.id}&limit=50`,
        headers: nils,
      })
    )
      .json()
      .map((a: { action: string }) => a.action)
    expect(audit).toEqual(
      expect.arrayContaining(['thread_created', 'question_answered', 'question_state_changed'])
    )
    await t.close()
  })
})
