import { describe, expect, it } from 'vitest'
import { makeTestApp, type TestApp } from '#root/testing/test-app'

const bearer = (t: TestApp): Record<string, string> => ({ authorization: `Bearer ${t.adminToken}` })

const createActor = async (t: TestApp, kind: 'human' | 'agent', handle: string): Promise<string> =>
  (
    await t.app.inject({
      method: 'POST',
      url: '/admin/actors',
      headers: bearer(t),
      payload: { kind, handle, display_name: `D ${handle}` },
    })
  ).json().id as string

const issueToken = async (t: TestApp, actorId: string): Promise<Record<string, string>> => {
  const issued = (
    await t.app.inject({
      method: 'POST',
      url: `/admin/actors/${actorId}/tokens`,
      headers: bearer(t),
      payload: { label: 'ci' },
    })
  ).json()
  return { authorization: `Bearer ${issued.raw_token as string}` }
}

// agent hermes-1 posts a note mentioning @nils → exactly one item in nils' inbox
const seedNilsInbox = async (t: TestApp): Promise<{ taskId: string }> => {
  const agentId = await createActor(t, 'agent', 'hermes-1')
  const agentBearer = await issueToken(t, agentId)
  const taskId = (
    await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: bearer(t),
      payload: { title: 'inbox host', status: 'todo' },
    })
  ).json().id as string
  const posted = await t.app.inject({
    method: 'POST',
    url: `/tasks/${taskId}/threads`,
    headers: agentBearer,
    payload: { kind: 'note', body: '@nils review-ready note' },
  })
  expect(posted.statusCode).toBe(201)
  return { taskId }
}

describe('inbox routes (spec §6.8, D-r)', () => {
  it('GET /inbox shows the caller their own items only, newest view', async () => {
    const t = await makeTestApp()
    const anaId = await createActor(t, 'human', 'ana')
    await seedNilsInbox(t)
    const mine = await t.app.inject({ method: 'GET', url: '/inbox', headers: bearer(t) })
    expect(mine.statusCode).toBe(200)
    const items = mine.json() as { id: string; actor_id: string; kind: string; read: boolean }[]
    expect(items.map((i) => [i.kind, i.read])).toEqual([['mentioned', false]])
    expect(items[0]!.actor_id).toBe('a_nils')
    // ana — a real actor with her own inbox — sees none of nils' items (per-actor view)
    const anaBearer = await issueToken(t, anaId)
    const hers = await t.app.inject({ method: 'GET', url: '/inbox', headers: anaBearer })
    expect(hers.json()).toEqual([])
    await t.close()
  })

  it('read flow: 204, read flips, unread_only filters, limit caps, schema guards', async () => {
    const t = await makeTestApp()
    await seedNilsInbox(t)
    const first = (await t.app.inject({ method: 'GET', url: '/inbox', headers: bearer(t) })).json()
    const itemId = (first[0] as { id: string }).id
    const unread = await t.app.inject({
      method: 'GET',
      url: '/inbox?unread_only=true',
      headers: bearer(t),
    })
    expect((unread.json() as unknown[]).length).toBe(1)
    const read = await t.app.inject({
      method: 'POST',
      url: `/inbox/${itemId}/read`,
      headers: bearer(t),
    })
    expect(read.statusCode).toBe(204)
    const nowRead = await t.app.inject({
      method: 'GET',
      url: '/inbox?unread_only=true',
      headers: bearer(t),
    })
    expect(nowRead.json()).toEqual([])
    const all = (await t.app.inject({ method: 'GET', url: '/inbox', headers: bearer(t) })).json()
    expect(all[0]).toMatchObject({ id: itemId, read: true })
    // limit caps; limit=0 rejected by the schema (invalid_request pipeline)
    const capped = await t.app.inject({
      method: 'GET',
      url: '/inbox?limit=1',
      headers: bearer(t),
    })
    expect((capped.json() as unknown[]).length).toBe(1)
    const zero = await t.app.inject({ method: 'GET', url: '/inbox?limit=0', headers: bearer(t) })
    expect(zero.statusCode).toBe(400)
    expect(zero.json().code).toBe('invalid_request')
    await t.close()
  })

  it('POST /inbox/:id/read is owner-only: foreign item and unknown id both 404 (no leak)', async () => {
    const t = await makeTestApp()
    const anaId = await createActor(t, 'human', 'ana')
    await seedNilsInbox(t)
    const first = (await t.app.inject({ method: 'GET', url: '/inbox', headers: bearer(t) })).json()
    const itemId = (first[0] as { id: string }).id
    const anaBearer = await issueToken(t, anaId)
    const foreign = await t.app.inject({
      method: 'POST',
      url: `/inbox/${itemId}/read`,
      headers: anaBearer,
    })
    expect(foreign.statusCode).toBe(404)
    expect(foreign.json().code).toBe('not_found')
    const ghost = await t.app.inject({
      method: 'POST',
      url: '/inbox/ib_ghost/read',
      headers: bearer(t),
    })
    expect(ghost.statusCode).toBe(404)
    await t.close()
  })

  it('inbox routes require auth (app-level 401, PUBLIC_PATHS untouched)', async () => {
    const t = await makeTestApp()
    const anon = await t.app.inject({ method: 'GET', url: '/inbox' })
    expect(anon.statusCode).toBe(401)
    await t.close()
  })
})
