import { describe, expect, it } from 'vitest'
import { SqliteUnitOfWork } from '#root/infra/sqlite/uow'
import { SqliteAuditRepo } from '#root/infra/sqlite/audit-repo'
import { SqliteLabelRepo } from '#root/infra/sqlite/label-repo'
import { freshDb, seedActor } from '#root/testing/fixtures'
import { CreateTask } from '#root/application/usecases/create-task'
import { DomainError } from '#root/domain/errors'
import type { ActorContext, Clock, IdGen } from '#root/application/ports'

// ---- shared use-case test harness (reused by later use-case test files)

export const fixedClock = (): Clock => ({ now: () => new Date('2026-05-05T05:05:05.000Z') })

export const seqIds = (): IdGen => {
  let n = 0
  return {
    newId: (prefix: string) => {
      n += 1
      return `${prefix}_seq${n}`
    },
  }
}

export const buildUow = async () => {
  const db = await freshDb()
  await seedActor(db, 'a_human', 'human', 'nils')
  const uow = new SqliteUnitOfWork(db)
  return { db, uow }
}

export const human: ActorContext = {
  actor: { id: 'a_human', kind: 'human', handle: 'nils', display_name: 'Nils' },
  tokenId: null,
}

describe('CreateTask', () => {
  it('creates a root task with defaults and audits it', async () => {
    const { db, uow } = await buildUow()
    const uc = new CreateTask(uow, fixedClock(), seqIds())
    const task = await uc.run({ ...human, title: 'Ship v1' })
    expect(task.id).toBe('t_seq1')
    expect(task.status).toBe('backlog')
    expect(task.position).toBe(1)
    expect(task.created_at).toBe('2026-05-05T05:05:05.000Z')

    const auditRows = await new SqliteAuditRepo(db).search({
      entity_type: 'task',
      entity_id: task.id,
      limit: 5,
    })
    expect(auditRows[0]?.action).toBe('task_created')
    expect(auditRows[0]?.actor_id).toBe('a_human')
    await db.destroy()
  })

  it('stores description and acceptance criteria when provided', async () => {
    const { db, uow } = await buildUow()
    const uc = new CreateTask(uow, fixedClock(), seqIds())
    const task = await uc.run({
      ...human,
      title: 'with detail',
      description: 'the body',
      acceptance_criteria: 'AC-1',
    })
    expect(task.description).toBe('the body')
    expect(task.acceptance_criteria).toBe('AC-1')
    await db.destroy()
  })

  it('creates children under a parent with ordered positions and ensured labels', async () => {
    const { db, uow } = await buildUow()
    const uc = new CreateTask(uow, fixedClock(), seqIds())
    const parent = await uc.run({ ...human, title: 'parent' })
    const child = await uc.run({
      ...human,
      title: 'child',
      parent_id: parent.id,
      status: 'todo',
      labels: ['infra'],
    })
    expect(child.parent_id).toBe(parent.id)
    expect(child.position).toBe(1) // first child
    const sibling = await uc.run({ ...human, title: 'sibling', parent_id: parent.id })
    expect(sibling.position).toBe(2)

    const labels = await new SqliteLabelRepo(db).labelsFor(child.id)
    expect(labels.map((l) => l.name)).toEqual(['infra'])
    await db.destroy()
  })

  it('reuses an existing label when the name already exists', async () => {
    const { db, uow } = await buildUow()
    const uc = new CreateTask(uow, fixedClock(), seqIds())
    const first = await uc.run({ ...human, title: 'first', labels: ['infra'] })
    const second = await uc.run({ ...human, title: 'second', labels: ['infra'] })
    const labelsFirst = await new SqliteLabelRepo(db).labelsFor(first.id)
    const labelsSecond = await new SqliteLabelRepo(db).labelsFor(second.id)
    expect(labelsSecond[0]?.id).toBe(labelsFirst[0]?.id)
    await db.destroy()
  })

  it('rejects unknown parent with not_found', async () => {
    const { db, uow } = await buildUow()
    const uc = new CreateTask(uow, fixedClock(), seqIds())
    await expect(uc.run({ ...human, title: 'x', parent_id: 't_missing' })).rejects.toMatchObject({
      code: 'not_found',
    })
    await db.destroy()
  })

  it('rejects invalid status with invalid_request', async () => {
    const { db, uow } = await buildUow()
    const uc = new CreateTask(uow, fixedClock(), seqIds())
    await expect(
      uc.run({ ...human, title: 'x', status: 'shipped' as never })
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(
      uc.run({ ...human, title: 'x', status: 'shipped' as never })
    ).rejects.toBeInstanceOf(DomainError)
    await db.destroy()
  })
})
