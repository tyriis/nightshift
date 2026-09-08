import { describe, expect, it } from 'vitest'
import { CreateTask } from '#root/application/usecases/create-task'
import { AddLink, RemoveLink } from '#root/application/usecases/manage-links'
import { SqliteAuditRepo } from '#root/infra/sqlite/audit-repo'
import { buildUow, fixedClock, human, seqIds } from '#root/application/usecases/create-task.test'
import type { LinkRecord } from '#root/application/ports'

const setup = async () => {
  const { db, uow } = await buildUow()
  const ids = seqIds()
  const task = await new CreateTask(uow, fixedClock(), ids).run({ ...human, title: 'link host' })
  const add = new AddLink(uow, fixedClock(), ids)
  const remove = new RemoveLink(uow, fixedClock())
  const audit = new SqliteAuditRepo(db)
  return { db, uow, ids, task, add, remove, audit }
}

const linkActions = (rows: { action: string }[]) => rows.map((a) => a.action)

describe('AddLink / RemoveLink (spec §6.6, D-t)', () => {
  it('adds a link with audit; same triple dedupes WITHOUT a second audit row', async () => {
    const { db, task, add, audit } = await setup()
    const row = await add.run({
      ...human,
      taskId: task.id,
      kind: 'pr',
      url: 'https://example/pr/1',
    })
    expect(row).toMatchObject({ kind: 'pr', url: 'https://example/pr/1', task_id: task.id })
    const dup = await add.run({
      ...human,
      taskId: task.id,
      kind: 'pr',
      url: 'https://example/pr/1',
    })
    expect(dup.id).toBe(row.id) // D-t: insert-or-get idempotency
    const auditRows = await audit.search({ entity_type: 'link', entity_id: row.id, limit: 10 })
    expect(linkActions(auditRows)).toEqual(['link_added']) // exact: one row, no re-audit
    expect(auditRows[0]).toMatchObject({ reason: 'link added' })
    const other = await add.run({
      ...human,
      taskId: task.id,
      kind: 'pr',
      url: 'https://example/pr/2',
    })
    expect(other.id).not.toBe(row.id) // different url → new row
    await db.destroy()
  })

  it('rejects bogus kind and non-http(s)/unparsable urls with invalid_request', async () => {
    const { db, task, add } = await setup()
    await expect(
      add.run({ ...human, taskId: task.id, kind: 'wiki' as never, url: 'https://example/x' })
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(
      add.run({ ...human, taskId: task.id, kind: 'doc', url: 'ftp://x' })
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(
      add.run({ ...human, taskId: task.id, kind: 'doc', url: 'not a url' })
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(
      add.run({ ...human, taskId: 't_ghost', kind: 'doc', url: 'https://example/x' })
    ).rejects.toMatchObject({ code: 'not_found' })
    await db.destroy()
  })

  it('remove audits and deletes; second remove and cross-task remove are 404 (task-scoped)', async () => {
    const { db, ids, task, add, remove, audit, uow } = await setup()
    const row: LinkRecord = await add.run({
      ...human,
      taskId: task.id,
      kind: 'commit',
      url: 'https://example/c/1',
    })
    await remove.run({ ...human, taskId: task.id, linkId: row.id })
    const auditRows = await audit.search({ entity_type: 'link', entity_id: row.id, limit: 10 })
    expect(linkActions(auditRows)).toEqual(['link_removed', 'link_added']) // exact trail
    expect(auditRows[0]).toMatchObject({ action: 'link_removed', reason: 'link removed' })
    await expect(remove.run({ ...human, taskId: task.id, linkId: row.id })).rejects.toMatchObject({
      code: 'not_found',
    })
    // another task's link is not addressable from this task
    const task2 = await new CreateTask(uow, fixedClock(), ids).run({ ...human, title: 'host 2' })
    const foreign = await add.run({
      ...human,
      taskId: task2.id,
      kind: 'doc',
      url: 'https://example/d/1',
    })
    await expect(
      remove.run({ ...human, taskId: task.id, linkId: foreign.id })
    ).rejects.toMatchObject({ code: 'not_found' })
    await db.destroy()
  })
})
