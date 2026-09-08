import { describe, expect, it } from 'vitest'
import { makeTestApp, type TestApp } from '#root/testing/test-app'

const bearer = (t: TestApp): Record<string, string> => ({ authorization: `Bearer ${t.adminToken}` })

const createTask = async (t: TestApp, title: string): Promise<string> =>
  (
    await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: bearer(t),
      payload: { title, status: 'todo' },
    })
  ).json().id as string

describe('link routes (spec §6.6, D-t)', () => {
  it('ghost task list → 404 not_found; real task lists empty, then its links', async () => {
    const t = await makeTestApp()
    const ghost = await t.app.inject({
      method: 'GET',
      url: '/tasks/t_ghost/links',
      headers: bearer(t),
    })
    expect(ghost.statusCode).toBe(404)
    expect(ghost.json().code).toBe('not_found')
    const taskId = await createTask(t, 'link host')
    const empty = await t.app.inject({
      method: 'GET',
      url: `/tasks/${taskId}/links`,
      headers: bearer(t),
    })
    expect(empty.statusCode).toBe(200)
    expect(empty.json()).toEqual([])
    const added = await t.app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/links`,
      headers: bearer(t),
      payload: { kind: 'pr', url: 'https://example/pr/9' },
    })
    expect(added.statusCode).toBe(201)
    const row = added.json()
    expect(row.id).toMatch(/^lk_[a-z0-9]{16}$/) // D-z family
    const list = (
      await t.app.inject({ method: 'GET', url: `/tasks/${taskId}/links`, headers: bearer(t) })
    ).json()
    expect(list.map((l: { id: string }) => l.id)).toEqual([row.id])
    await t.close()
  })

  it('POST is insert-or-get: re-post of the same triple returns the same row', async () => {
    const t = await makeTestApp()
    const taskId = await createTask(t, 'dedupe host')
    const body = { kind: 'doc', url: 'https://example/doc/1' }
    const a = await t.app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/links`,
      headers: bearer(t),
      payload: body,
    })
    const b = await t.app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/links`,
      headers: bearer(t),
      payload: body,
    })
    expect(a.statusCode).toBe(201)
    expect(b.json().id).toBe(a.json().id)
    await t.close()
  })

  it('DELETE removes (204), second delete 404, cross-task delete 404', async () => {
    const t = await makeTestApp()
    const taskId = await createTask(t, 'rm host')
    const other = await createTask(t, 'other host')
    const row = (
      await t.app.inject({
        method: 'POST',
        url: `/tasks/${taskId}/links`,
        headers: bearer(t),
        payload: { kind: 'commit', url: 'https://example/c/9' },
      })
    ).json()
    const del = await t.app.inject({
      method: 'DELETE',
      url: `/tasks/${taskId}/links/${row.id as string}`,
      headers: bearer(t),
    })
    expect(del.statusCode).toBe(204)
    const again = await t.app.inject({
      method: 'DELETE',
      url: `/tasks/${taskId}/links/${row.id as string}`,
      headers: bearer(t),
    })
    expect(again.statusCode).toBe(404)
    // another task's link is not addressable from this task
    const foreign = (
      await t.app.inject({
        method: 'POST',
        url: `/tasks/${other}/links`,
        headers: bearer(t),
        payload: { kind: 'other', url: 'https://example/o/1' },
      })
    ).json()
    const cross = await t.app.inject({
      method: 'DELETE',
      url: `/tasks/${taskId}/links/${foreign.id as string}`,
      headers: bearer(t),
    })
    expect(cross.statusCode).toBe(404)
    await t.close()
  })

  it('guards: bogus kind 400 (schema enum), ftp scheme 400 invalid_request (use-case)', async () => {
    const t = await makeTestApp()
    const taskId = await createTask(t, 'guard host')
    const badKind = await t.app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/links`,
      headers: bearer(t),
      payload: { kind: 'wiki', url: 'https://example/x' },
    })
    expect(badKind.statusCode).toBe(400)
    expect(badKind.json().code).toBe('invalid_request')
    const ftp = await t.app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/links`,
      headers: bearer(t),
      payload: { kind: 'doc', url: 'ftp://example/x' },
    })
    expect(ftp.statusCode).toBe(400)
    expect(ftp.json().code).toBe('invalid_request') // use-case scheme guard (past minLength 8)
    await t.close()
  })
})
