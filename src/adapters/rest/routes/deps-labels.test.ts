import { describe, expect, it } from 'vitest'
import { makeTestApp, type TestApp } from '#root/testing/test-app'

const bearer = (t: TestApp): Record<string, string> => ({ authorization: `Bearer ${t.adminToken}` })

const mkTask = async (t: TestApp, title: string): Promise<string> =>
  (
    await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: bearer(t),
      payload: { title, status: 'todo' },
    })
  ).json().id as string

describe('dependency + label routes', () => {
  it('blocks: add, cycle rejection via API, ready-work exclusion, remove re-readies', async () => {
    const t = await makeTestApp()
    const blocker = await mkTask(t, 'blocker')
    const blocked = await mkTask(t, 'blocked')

    const before = (
      await t.app.inject({ method: 'GET', url: '/tasks/next', headers: bearer(t) })
    ).json()
    expect(before.map((x: { id: string }) => x.id)).toContain(blocked)

    const ok = await t.app.inject({
      method: 'PUT',
      url: `/tasks/${blocked}/blocks/${blocker}`,
      headers: bearer(t),
    })
    expect(ok.statusCode).toBe(204)

    const dup = await t.app.inject({
      method: 'PUT',
      url: `/tasks/${blocked}/blocks/${blocker}`,
      headers: bearer(t),
    })
    expect(dup.statusCode).toBe(204) // idempotent PUT

    const gone = (
      await t.app.inject({ method: 'GET', url: '/tasks/next', headers: bearer(t) })
    ).json()
    expect(gone.map((x: { id: string }) => x.id)).not.toContain(blocked)

    const cycle = await t.app.inject({
      method: 'PUT',
      url: `/tasks/${blocker}/blocks/${blocked}`,
      headers: bearer(t),
    })
    expect(cycle.statusCode).toBe(409)
    expect(cycle.json().code).toBe('dependency_cycle')

    const self = await t.app.inject({
      method: 'PUT',
      url: `/tasks/${blocker}/blocks/${blocker}`,
      headers: bearer(t),
    })
    expect(self.statusCode).toBe(400)

    const unknown = await t.app.inject({
      method: 'PUT',
      url: `/tasks/${blocked}/blocks/t_ghost`,
      headers: bearer(t),
    })
    expect(unknown.statusCode).toBe(404)

    const rm = await t.app.inject({
      method: 'DELETE',
      url: `/tasks/${blocked}/blocks/${blocker}`,
      headers: bearer(t),
    })
    expect(rm.statusCode).toBe(204)
    const readyAgain = (
      await t.app.inject({ method: 'GET', url: '/tasks/next', headers: bearer(t) })
    ).json()
    expect(readyAgain.map((x: { id: string }) => x.id)).toContain(blocked)
    await t.close()
  })

  it('labels: create, attach, appears in context, detach', async () => {
    const t = await makeTestApp()
    const task = await mkTask(t, 'labelled')
    const label = (
      await t.app.inject({
        method: 'POST',
        url: '/labels',
        headers: bearer(t),
        payload: { name: 'infra' },
      })
    ).json()
    expect(label.name).toBe('infra')

    const att = await t.app.inject({
      method: 'PUT',
      url: `/tasks/${task}/labels/${label.id}`,
      headers: bearer(t),
    })
    expect(att.statusCode).toBe(204)

    const ctx = (
      await t.app.inject({ method: 'GET', url: `/tasks/${task}/context`, headers: bearer(t) })
    ).json()
    expect(ctx.labels.map((l: { name: string }) => l.name)).toEqual(['infra'])

    const missing = await t.app.inject({
      method: 'PUT',
      url: `/tasks/${task}/labels/l_ghost`,
      headers: bearer(t),
    })
    expect(missing.statusCode).toBe(404)

    const det = await t.app.inject({
      method: 'DELETE',
      url: `/tasks/${task}/labels/${label.id}`,
      headers: bearer(t),
    })
    expect(det.statusCode).toBe(204)
    const after = (
      await t.app.inject({ method: 'GET', url: `/tasks/${task}/context`, headers: bearer(t) })
    ).json()
    expect(after.labels).toEqual([])

    // both label actions must surface in the audit feed (Task 18 greps these strings)
    const audit = (
      await t.app.inject({ method: 'GET', url: `/audit?entity_id=${task}`, headers: bearer(t) })
    ).json()
    const actions = audit.map((a: { action: string }) => a.action)
    expect(actions).toContain('label_attached')
    expect(actions).toContain('label_detached')
    await t.close()
  })

  // Coverage the plan block left open (Task 15 brief): 204+Idempotency-Key replay on
  // a real route, GET/POST /labels happy + rejection, not_found on the task-side paths.
  it('204 replays via Idempotency-Key; remaining routes and 404/400 shapes', async () => {
    const t = await makeTestApp()
    const blocker = await mkTask(t, 'idem-blocker')
    const blocked = await mkTask(t, 'idem-blocked')

    const idemHeaders = { ...bearer(t), 'idempotency-key': 'k-block' }
    const first = await t.app.inject({
      method: 'PUT',
      url: `/tasks/${blocked}/blocks/${blocker}`,
      headers: idemHeaders,
    })
    expect(first.statusCode).toBe(204)
    const replay = await t.app.inject({
      method: 'PUT',
      url: `/tasks/${blocked}/blocks/${blocker}`,
      headers: idemHeaders,
    })
    expect(replay.statusCode).toBe(204) // key completed, not stranded in flight (D-j)
    expect(replay.body).toBe('') // 204 replays carry no body

    const created = await t.app.inject({
      method: 'POST',
      url: '/labels',
      headers: bearer(t),
      payload: { name: 'ops', color: '#ff8800' },
    })
    expect(created.statusCode).toBe(201)
    const labelId = created.json().id as string

    const listed = (
      await t.app.inject({ method: 'GET', url: '/labels', headers: bearer(t) })
    ).json()
    expect(listed.map((l: { name: string }) => l.name)).toEqual(['ops'])
    expect(listed[0].color).toBe('#ff8800')

    const unauth = await t.app.inject({ method: 'GET', url: '/labels' })
    expect(unauth.statusCode).toBe(401)
    expect(unauth.headers['content-type']).toContain('application/problem+json')
    expect(unauth.json().code).toBe('unauthenticated')

    // fastify's default ajv strips unknown props (removeAdditional), so the 400
    // pin is the missing required 'name', not an unknown key
    const bad = await t.app.inject({
      method: 'POST',
      url: '/labels',
      headers: bearer(t),
      payload: { color: '#ffffff', extra: true },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('invalid_request')

    const putGhostTask = await t.app.inject({
      method: 'PUT',
      url: `/tasks/t_ghost/labels/${labelId}`,
      headers: bearer(t),
    })
    expect(putGhostTask.statusCode).toBe(404)
    expect(putGhostTask.json().code).toBe('not_found')

    const delGhostTask = await t.app.inject({
      method: 'DELETE',
      url: `/tasks/t_ghost/labels/${labelId}`,
      headers: bearer(t),
    })
    expect(delGhostTask.statusCode).toBe(404)
    expect(delGhostTask.json().code).toBe('not_found')

    const delBlockGhostTask = await t.app.inject({
      method: 'DELETE',
      url: `/tasks/t_ghost/blocks/${blocker}`,
      headers: bearer(t),
    })
    expect(delBlockGhostTask.statusCode).toBe(404)
    expect(delBlockGhostTask.json().code).toBe('not_found')

    const delGhostBlocker = await t.app.inject({
      method: 'DELETE',
      url: `/tasks/${blocked}/blocks/t_ghost`,
      headers: bearer(t),
    })
    expect(delGhostBlocker.statusCode).toBe(204) // block-side twin of the label idempotency pin

    const detached = await t.app.inject({
      method: 'DELETE',
      url: `/tasks/${blocked}/labels/l_ghost`,
      headers: bearer(t),
    })
    expect(detached.statusCode).toBe(204) // detach is idempotent; task-side owns the 404
    await t.close()
  })
})
