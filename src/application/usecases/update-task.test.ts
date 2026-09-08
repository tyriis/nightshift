import { describe, expect, it } from 'vitest'
import { CreateTask } from '#root/application/usecases/create-task'
import { UpdateTask } from '#root/application/usecases/update-task'
import { buildUow, fixedClock, human, seqIds } from '#root/application/usecases/create-task.test'
import { SqliteTaskRepo } from '#root/infra/sqlite/task-repo'
import { SqliteInboxRepo } from '#root/infra/sqlite/inbox-repo'
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
    const uc = new UpdateTask(uow, fixedClock(), seqIds())
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
    const uc = new UpdateTask(uow, fixedClock(), seqIds())
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
    const uc = new UpdateTask(uow, fixedClock(), seqIds())
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
    const uc = new UpdateTask(uow, fixedClock(), seqIds())
    await expect(
      uc.run({ ...human, taskId: created.id, patch: { assignee_id: '' } })
    ).rejects.toMatchObject({ code: 'not_found' })
    await db.destroy()
  })

  it('assignee_id null clears assignee without existence check (documented)', async () => {
    const { db, uow } = await buildUow()
    await seedActor(db, 'a_agent', 'agent', 'hermes-1')
    const created = await new CreateTask(uow, fixedClock(), seqIds()).run({ ...human, title: 'x' })
    const uc = new UpdateTask(uow, fixedClock(), seqIds())
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
    await new UpdateTask(uow, fixedClock(), seqIds()).run({
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
    const uc = new UpdateTask(uow, fixedClock(), seqIds())
    await expect(
      uc.run({ ...human, taskId: 't_ghost', patch: { title: 'x' } })
    ).rejects.toMatchObject({ code: 'not_found' })
    await db.destroy()
  })

  it('empty patch is a no-op (no audit noise)', async () => {
    const { db, uow } = await buildUow()
    const created = await new CreateTask(uow, fixedClock(), seqIds()).run({ ...human, title: 'x' })
    const updated = await new UpdateTask(uow, fixedClock(), seqIds()).run({
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

  it('assignee change notifies the new assignee (D-r: assigned inbox, never self, never on no-op patch)', async () => {
    const { db, uow } = await buildUow()
    const ids = seqIds()
    await seedActor(db, 'a_ana', 'human', 'ana')
    const task = await new CreateTask(uow, fixedClock(), ids).run({ ...human, title: 'x' })
    const uc = new UpdateTask(uow, fixedClock(), ids)
    const inbox = new SqliteInboxRepo(db)
    const anaKinds = async () =>
      (await inbox.listForActor('a_ana', { unreadOnly: false, limit: 5 })).map((i) => i.kind)

    await uc.run({ ...human, taskId: task.id, patch: { assignee_id: 'a_ana' } })
    expect(await anaKinds()).toEqual(['assigned'])
    // same-assignee no-op patch: real change required, not just the key's presence
    await uc.run({ ...human, taskId: task.id, patch: { assignee_id: 'a_ana' } })
    expect(await anaKinds()).toHaveLength(1)
    // re-assign away from ana: her count stands (only NEW assignees get notified)
    await uc.run({ ...human, taskId: task.id, patch: { assignee_id: 'a_human' } }) // self: no notify
    expect(await anaKinds()).toHaveLength(1)
    expect(await inbox.listForActor('a_human', { unreadOnly: false, limit: 5 })).toEqual([]) // actor never notified of their own assignment
    await uc.run({ ...human, taskId: task.id, patch: { title: 'y' } }) // no assignee key: no notify
    expect(await anaKinds()).toHaveLength(1)
    await uc.run({ ...human, taskId: task.id, patch: { assignee_id: null } }) // unassign: no notify (null guard)
    expect(await anaKinds()).toHaveLength(1)
    await db.destroy()
  })
})
