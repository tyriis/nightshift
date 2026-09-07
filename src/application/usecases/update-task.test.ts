import { describe, expect, it } from 'vitest'
import { CreateTask } from '#root/application/usecases/create-task'
import { UpdateTask } from '#root/application/usecases/update-task'
import { buildUow, fixedClock, human, seqIds } from '#root/application/usecases/create-task.test'
import { SqliteTaskRepo } from '#root/infra/sqlite/task-repo'
import { SqliteAuditRepo } from '#root/infra/sqlite/audit-repo'
import { seedActor } from '#root/testing/fixtures'
import { DomainError } from '#root/domain/errors'

describe('UpdateTask (content patch, decision D-e)', () => {
  it('patches content fields and audits before/after', async () => {
    const { db, uow } = await buildUow()
    const created = await new CreateTask(uow, fixedClock(), seqIds()).run({
      ...human,
      title: 'old',
    })
    const uc = new UpdateTask(uow, fixedClock())
    const updated = await uc.run({
      ...human,
      taskId: created.id,
      patch: { title: 'new', blocked_flag: true, acceptance_criteria: 'AC-1' },
    })
    expect(updated.title).toBe('new')
    expect(updated.blocked_flag).toBe(true)
    expect((await new SqliteTaskRepo(db).findById(created.id))?.acceptance_criteria).toBe('AC-1')

    const auditRows = await new SqliteAuditRepo(db).search({
      entity_type: 'task',
      entity_id: created.id,
      limit: 5,
    })
    expect(auditRows[0]?.action).toBe('task_updated')
    expect(auditRows[0]?.before).toMatchObject({ title: 'old', blocked_flag: false })
    expect(auditRows[0]?.after).toMatchObject({ title: 'new', blocked_flag: true })
    await db.destroy()
  })

  it('assigns an existing actor as assignee', async () => {
    const { db, uow } = await buildUow()
    await seedActor(db, 'a_agent', 'agent', 'hermes-1')
    const created = await new CreateTask(uow, fixedClock(), seqIds()).run({ ...human, title: 'x' })
    const uc = new UpdateTask(uow, fixedClock())
    const updated = await uc.run({
      ...human,
      taskId: created.id,
      patch: { assignee_id: 'a_agent' },
    })
    expect(updated.assignee_id).toBe('a_agent')
    await db.destroy()
  })

  it('rejects unknown assignee actor', async () => {
    const { db, uow } = await buildUow()
    const created = await new CreateTask(uow, fixedClock(), seqIds()).run({ ...human, title: 'x' })
    const uc = new UpdateTask(uow, fixedClock())
    await expect(
      uc.run({ ...human, taskId: created.id, patch: { assignee_id: 'a_ghost' } })
    ).rejects.toBeInstanceOf(DomainError)
    await expect(
      uc.run({ ...human, taskId: created.id, patch: { assignee_id: 'a_ghost' } })
    ).rejects.toMatchObject({ code: 'not_found' })
    await db.destroy()
  })

  it('rejects empty-string assignee with not_found (M-3: SET always existence-checks)', async () => {
    const { db, uow } = await buildUow()
    const created = await new CreateTask(uow, fixedClock(), seqIds()).run({ ...human, title: 'x' })
    const uc = new UpdateTask(uow, fixedClock())
    await expect(
      uc.run({ ...human, taskId: created.id, patch: { assignee_id: '' } })
    ).rejects.toMatchObject({ code: 'not_found' })
    await db.destroy()
  })

  it('assignee_id null clears assignee without existence check (documented)', async () => {
    const { db, uow } = await buildUow()
    await seedActor(db, 'a_agent', 'agent', 'hermes-1')
    const created = await new CreateTask(uow, fixedClock(), seqIds()).run({ ...human, title: 'x' })
    const uc = new UpdateTask(uow, fixedClock())
    await uc.run({ ...human, taskId: created.id, patch: { assignee_id: 'a_agent' } })
    const cleared = await uc.run({ ...human, taskId: created.id, patch: { assignee_id: null } })
    expect(cleared.assignee_id).toBeNull()
    await db.destroy()
  })

  it('audit snapshot includes description before/after (I-1)', async () => {
    const { db, uow } = await buildUow()
    const created = await new CreateTask(uow, fixedClock(), seqIds()).run({
      ...human,
      title: 'x',
      description: 'old desc',
    })
    await new UpdateTask(uow, fixedClock()).run({
      ...human,
      taskId: created.id,
      patch: { description: 'new desc' },
    })
    const auditRows = await new SqliteAuditRepo(db).search({
      entity_type: 'task',
      entity_id: created.id,
      limit: 5,
    })
    const row = auditRows.find((r) => r.action === 'task_updated')
    expect(row).toBeDefined()
    const before = row?.before as { description?: string }
    const after = row?.after as { description?: string }
    expect(before?.description).not.toBe(after?.description)
    expect(before?.description).toBe('old desc')
    expect(after?.description).toBe('new desc')
    await db.destroy()
  })

  it('rejects unknown task with not_found', async () => {
    const { db, uow } = await buildUow()
    const uc = new UpdateTask(uow, fixedClock())
    await expect(
      uc.run({ ...human, taskId: 't_ghost', patch: { title: 'x' } })
    ).rejects.toMatchObject({ code: 'not_found' })
    await db.destroy()
  })

  it('empty patch is a no-op (no audit noise)', async () => {
    const { db, uow } = await buildUow()
    const created = await new CreateTask(uow, fixedClock(), seqIds()).run({ ...human, title: 'x' })
    const updated = await new UpdateTask(uow, fixedClock()).run({
      ...human,
      taskId: created.id,
      patch: {},
    })
    expect(updated.title).toBe('x')

    const auditRows = await new SqliteAuditRepo(db).search({
      entity_type: 'task',
      entity_id: created.id,
      limit: 5,
    })
    expect(auditRows.map((r) => r.action)).toEqual(['task_created'])
    await db.destroy()
  })
})
