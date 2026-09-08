import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CreateTask } from '#root/application/usecases/create-task'
import { UploadAttachment } from '#root/application/usecases/upload-attachment'
import { DiskFileStore } from '#root/infra/files/disk-file-store'
import { SqliteAuditRepo } from '#root/infra/sqlite/audit-repo'
import { buildUow, fixedClock, human, seqIds } from '#root/application/usecases/create-task.test'

const setup = async () => {
  const { db, uow } = await buildUow()
  const ids = seqIds()
  const files = new DiskFileStore(join(await mkdtemp(join(tmpdir(), 'ns-upload-')), 'files'))
  const task = await new CreateTask(uow, fixedClock(), ids).run({ ...human, title: 'host' })
  const uc = new UploadAttachment(uow, fixedClock(), ids, files)
  return { db, uow, files, ids, uc, taskId: task.id }
}

const md = () => new TextEncoder().encode('# spec\n')

describe('UploadAttachment (spec §6.6, D-s)', () => {
  it('stores bytes content-addressed, dedupes re-upload of same (task, sha, filename) without second audit', async () => {
    const { db, uc, taskId } = await setup()
    const first = await uc.run({
      ...human,
      taskId,
      filename: 'spec.md',
      contentType: 'text/markdown',
      content: md(),
    })
    expect(first).toMatchObject({ filename: 'spec.md', bytes: 7 })
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/)
    const again = await uc.run({
      ...human,
      taskId,
      filename: 'spec.md',
      contentType: 'text/markdown',
      content: md(),
    })
    expect(again.id).toBe(first.id)
    const audit = await new SqliteAuditRepo(db).search({
      entity_type: 'attachment',
      entity_id: first.id,
      limit: 5,
    })
    expect(audit).toHaveLength(1) // D-s: dedupe does not re-audit
    expect(audit[0]).toMatchObject({ action: 'attachment_uploaded', reason: 'attachment uploaded' })
    await db.destroy()
  })

  it('same bytes DIFFERENT filename → new row (identity is the triple, not the blob)', async () => {
    const { db, uc, taskId } = await setup()
    const a = await uc.run({
      ...human,
      taskId,
      filename: 'one.md',
      contentType: 'text/markdown',
      content: md(),
    })
    const b = await uc.run({
      ...human,
      taskId,
      filename: 'two.md',
      contentType: 'text/markdown',
      content: md(),
    })
    expect(b.id).not.toBe(a.id)
    expect(b.sha256).toBe(a.sha256) // same blob, different rows (D-s)
    await db.destroy()
  })

  it('empty content → invalid_request; unknown task → not_found', async () => {
    const { db, uc, taskId } = await setup()
    await expect(
      uc.run({
        ...human,
        taskId,
        filename: 'x.md',
        contentType: 'text/markdown',
        content: new Uint8Array(0),
      })
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(
      uc.run({
        ...human,
        taskId: 't_ghost',
        filename: 'x.md',
        contentType: 'text/markdown',
        content: md(),
      })
    ).rejects.toMatchObject({ code: 'not_found' })
    await db.destroy()
  })
})
