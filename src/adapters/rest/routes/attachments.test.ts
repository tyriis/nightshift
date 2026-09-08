import { describe, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { makeTestApp, type TestApp } from '#root/testing/test-app'
import { DiskFileStore } from '#root/infra/files/disk-file-store'

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

const upload = (
  t: TestApp,
  taskId: string,
  bytes: Buffer,
  query: string,
  contentType = 'application/octet-stream'
) =>
  t.app.inject({
    method: 'POST',
    url: `/tasks/${taskId}/attachments?${query}`,
    headers: { ...bearer(t), 'content-type': contentType },
    payload: bytes,
  })

describe('attachment routes (spec §6.6, §10, D-s)', () => {
  it('upload → 201 metadata, list shows it, content round-trips with nosniff', async () => {
    const t = await makeTestApp()
    const taskId = await createTask(t, 'host')
    const res = await upload(
      t,
      taskId,
      Buffer.from('# spec\n'),
      'filename=spec.md&content_type=text/markdown'
    )
    expect(res.statusCode).toBe(201)
    const row = res.json()
    expect(row).toMatchObject({
      filename: 'spec.md',
      content_type: 'text/markdown',
      bytes: 7,
      task_id: taskId,
    })
    expect(row.id).toMatch(/^at_[a-z0-9]{16}$/)
    const list = (
      await t.app.inject({ method: 'GET', url: `/tasks/${taskId}/attachments`, headers: bearer(t) })
    ).json()
    expect(list.map((a: { id: string }) => a.id)).toEqual([row.id])
    const content = await t.app.inject({
      method: 'GET',
      url: `/attachments/${row.id as string}/content`,
      headers: bearer(t),
    })
    expect(content.statusCode).toBe(200)
    expect(content.body).toBe('# spec\n')
    expect(content.headers['x-content-type-options']).toBe('nosniff')
    expect(content.headers['content-type']).toContain('text/markdown')
    expect(content.headers['content-disposition']).toContain('inline; filename="spec.md"')
    await t.close()
  })

  it('html-family upload is served DOWNGRADED: octet-stream + attachment + nosniff (spec §10)', async () => {
    const t = await makeTestApp()
    const taskId = await createTask(t, 'xss host')
    const row = (
      await upload(
        t,
        taskId,
        Buffer.from('<script>alert(1)</script>'),
        'filename=x.html&content_type=text/html'
      )
    ).json()
    const content = await t.app.inject({
      method: 'GET',
      url: `/attachments/${row.id as string}/content`,
      headers: bearer(t),
    })
    expect(content.statusCode).toBe(200)
    expect(content.headers['content-type']).toContain('application/octet-stream')
    expect(content.headers['content-disposition']).toContain('attachment;')
    expect(content.headers['x-content-type-options']).toBe('nosniff')
    await t.close()
  })

  it('filename with quote/CR is stripped in the disposition header', async () => {
    const t = await makeTestApp()
    const taskId = await createTask(t, 'fn host')
    const row = (
      await upload(
        t,
        taskId,
        Buffer.from('x'),
        `filename=${encodeURIComponent('a"b\rc.txt')}&content_type=text/plain`
      )
    ).json()
    const content = await t.app.inject({
      method: 'GET',
      url: `/attachments/${row.id as string}/content`,
      headers: bearer(t),
    })
    const disp = content.headers['content-disposition'] as string
    expect(disp).toContain('filename="a_b_c.txt"') // quote→_, CR→_ (two replacements)
    expect(disp).not.toContain('\r')
    expect(disp.match(/"/g)).toHaveLength(2) // the wrapping pair only — injected quotes are gone
    await t.close()
  })

  it('oversize upload → 413 payload_too_large via the T2 map (route-level bodyLimit)', async () => {
    const t = await makeTestApp({ NS_MAX_UPLOAD_BYTES: '1024' })
    const taskId = await createTask(t, 'big host')
    const res = await upload(t, taskId, Buffer.alloc(2048, 7), 'filename=big.bin')
    expect(res.statusCode).toBe(413)
    expect(res.json().code).toBe('payload_too_large')
    await t.close()
  })

  it('non-octet-stream content-type on upload → invalid_request (route-level guard; 415 is parser-only and unreachable here)', async () => {
    const t = await makeTestApp()
    const taskId = await createTask(t, 'ct host')
    const res = await t.app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/attachments?filename=x.md`,
      headers: { ...bearer(t), 'content-type': 'application/json' },
      payload: { sneaky: true },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid_request')
    await t.close()
  })

  it('unknown attachment content → 404; list for unknown task → []', async () => {
    const t = await makeTestApp()
    const missing = await t.app.inject({
      method: 'GET',
      url: '/attachments/at_nope/content',
      headers: bearer(t),
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().code).toBe('not_found')
    const list = await t.app.inject({
      method: 'GET',
      url: '/tasks/t_ghost/attachments',
      headers: bearer(t),
    })
    expect(list.json()).toEqual([])
    await t.close()
  })

  it('row exists but the blob is gone → 404 "stored blob is missing" (corrupted store)', async () => {
    const t = await makeTestApp()
    const taskId = await createTask(t, 'orphan host')
    const row = (await upload(t, taskId, Buffer.from('doomed'), 'filename=o.bin')).json()
    const store = t.deps.files as DiskFileStore
    const sha = row.sha256 as string
    await rm(join(store.dir, sha.slice(0, 2), sha)) // simulate a lost blob
    const res = await t.app.inject({
      method: 'GET',
      url: `/attachments/${row.id as string}/content`,
      headers: bearer(t),
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().detail).toMatch(/blob is missing/)
    await t.close()
  })
})
