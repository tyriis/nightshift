import { describe, expect, it } from 'vitest'
import { CreateTask } from '#root/application/usecases/create-task'
import { AddBlock } from '#root/application/usecases/add-block'
import { RemoveBlock } from '#root/application/usecases/remove-block'
import { buildUow, fixedClock, human, seqIds } from '#root/application/usecases/create-task.test'
import { SqliteAuditRepo } from '#root/infra/sqlite/audit-repo'

describe('AddBlock / RemoveBlock (spec §6.3)', () => {
  it('adds an edge and audits it', async () => {
    const { db, uow } = await buildUow()
    const create = new CreateTask(uow, fixedClock(), seqIds())
    const blocker = await create.run({ ...human, title: 'blocker', status: 'todo' })
    const blocked = await create.run({ ...human, title: 'blocked', status: 'todo' })

    await new AddBlock(uow, fixedClock()).run({
      ...human,
      taskId: blocked.id,
      blocker_id: blocker.id,
    })

    const audit = await new SqliteAuditRepo(db).search({
      entity_type: 'task',
      entity_id: blocked.id,
      limit: 10,
    })
    expect(audit.some((a) => a.action === 'block_added')).toBe(true)
    await db.destroy()
  })

  it('rejects self-block and cycles with dependency_cycle', async () => {
    const { db, uow } = await buildUow()
    const create = new CreateTask(uow, fixedClock(), seqIds())
    const a = await create.run({ ...human, title: 'a' })
    const b = await create.run({ ...human, title: 'b' })
    const add = new AddBlock(uow, fixedClock())

    await expect(add.run({ ...human, taskId: a.id, blocker_id: a.id })).rejects.toMatchObject({
      code: 'invalid_request',
    })
    await add.run({ ...human, taskId: b.id, blocker_id: a.id }) // a blocks b
    await expect(add.run({ ...human, taskId: a.id, blocker_id: b.id })).rejects.toMatchObject({
      code: 'dependency_cycle',
    })
    await db.destroy()
  })

  it('add is idempotent (re-adding the same edge is a no-op)', async () => {
    const { db, uow } = await buildUow()
    const create = new CreateTask(uow, fixedClock(), seqIds())
    const a = await create.run({ ...human, title: 'a' })
    const b = await create.run({ ...human, title: 'b' })
    const add = new AddBlock(uow, fixedClock())
    await add.run({ ...human, taskId: b.id, blocker_id: a.id })
    await add.run({ ...human, taskId: b.id, blocker_id: a.id }) // repo onConflict doNothing
    // re-add after a cycle check must still not throw
    await expect(add.run({ ...human, taskId: b.id, blocker_id: a.id })).resolves.toBeUndefined()
    await db.destroy()
  })

  it('remove is idempotent; unknown tasks are not_found', async () => {
    const { db, uow } = await buildUow()
    const create = new CreateTask(uow, fixedClock(), seqIds())
    const a = await create.run({ ...human, title: 'a' })
    const b = await create.run({ ...human, title: 'b' })
    await new AddBlock(uow, fixedClock()).run({ ...human, taskId: b.id, blocker_id: a.id })
    const rm = new RemoveBlock(uow, fixedClock())
    await rm.run({ ...human, taskId: b.id, blocker_id: a.id })
    await rm.run({ ...human, taskId: b.id, blocker_id: a.id }) // idempotent
    await expect(
      new AddBlock(uow, fixedClock()).run({ ...human, taskId: 't_ghost', blocker_id: a.id })
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      new AddBlock(uow, fixedClock()).run({ ...human, taskId: b.id, blocker_id: 't_ghost' })
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      new RemoveBlock(uow, fixedClock()).run({ ...human, taskId: 't_ghost', blocker_id: a.id })
    ).rejects.toMatchObject({ code: 'not_found' })
    await db.destroy()
  })

  it('remove audits the removal', async () => {
    const { db, uow } = await buildUow()
    const create = new CreateTask(uow, fixedClock(), seqIds())
    const a = await create.run({ ...human, title: 'a' })
    const b = await create.run({ ...human, title: 'b' })
    await new AddBlock(uow, fixedClock()).run({ ...human, taskId: b.id, blocker_id: a.id })
    await new RemoveBlock(uow, fixedClock()).run({ ...human, taskId: b.id, blocker_id: a.id })
    const audit = await new SqliteAuditRepo(db).search({
      entity_type: 'task',
      entity_id: b.id,
      limit: 10,
    })
    expect(audit.some((a) => a.action === 'block_removed')).toBe(true)
    await db.destroy()
  })
})
