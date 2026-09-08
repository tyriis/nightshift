import { describe, expect, it } from 'vitest'
import { CreateTask } from '#root/application/usecases/create-task'
import { SplitTask } from '#root/application/usecases/split-task'
import { ClaimTask } from '#root/application/usecases/claim-task'
import { buildUow, fixedClock, human, seqIds } from '#root/application/usecases/create-task.test'
import { SqliteAuditRepo } from '#root/infra/sqlite/audit-repo'
import { SqliteTaskRepo } from '#root/infra/sqlite/task-repo'
import { seedActor, seedToken } from '#root/testing/fixtures'

describe('SplitTask (spec §6.2)', () => {
  // M-1 pin: ONE seqIds instance per test, shared across all use-case constructions —
  // two fresh counters on one db both mint t_seq1 and collide on the tasks PK.
  it('creates N children under the parent in order', async () => {
    const { db, uow } = await buildUow()
    const ids = seqIds()
    const parent = await new CreateTask(uow, fixedClock(), ids).run({ ...human, title: 'big' })
    const split = await new SplitTask(uow, fixedClock(), ids).run({
      ...human,
      taskId: parent.id,
      children: [
        { title: 'c1', acceptance_criteria: 'AC1', status: 'todo' },
        { title: 'c2' }, // defaults: status backlog
      ],
    })
    expect(split.created.map((c) => c.title)).toEqual(['c1', 'c2'])
    expect(split.created[0]?.parent_id).toBe(parent.id)
    expect(split.created[0]?.acceptance_criteria).toBe('AC1')
    expect(split.created[0]?.status).toBe('todo')
    expect(split.created[1]?.status).toBe('backlog')
    expect(split.parent.child_count).toBe(2)

    const audit = await new SqliteAuditRepo(db).search({
      entity_type: 'task',
      entity_id: parent.id,
      limit: 5,
    })
    expect(audit.some((a) => a.action === 'task_split')).toBe(true)
    await db.destroy()
  })

  it('auto-releases an active claim and bumps the fencing generation (decision D-d)', async () => {
    const { db, uow } = await buildUow()
    await seedActor(db, 'a_agent', 'agent', 'hermes-1')
    await seedToken(db, 'tok_agent', 'a_agent')
    const ids = seqIds()
    const parent = await new CreateTask(uow, fixedClock(), ids).run({
      ...human,
      title: 'big',
      status: 'todo',
    })
    const claim = await new ClaimTask(uow, fixedClock(), seqIds()).run({
      actor: { id: 'a_agent', kind: 'agent', handle: 'hermes-1', display_name: 'Hermes' },
      tokenId: 'tok_agent',
      taskId: parent.id,
    })
    expect(claim.generation).toBe(1)

    const split = await new SplitTask(uow, fixedClock(), ids).run({
      ...human,
      taskId: parent.id,
      children: [{ title: 'c1' }],
    })
    expect(split.parent.task.claim_token_id).toBeNull()
    expect(split.parent.task.claim_generation).toBe(2)

    const audit = await new SqliteAuditRepo(db).search({
      entity_type: 'task',
      entity_id: parent.id,
      limit: 10,
    })
    expect(audit.some((a) => a.reason === 'claim released by split')).toBe(true)

    // the old lease token can never be used again:
    const { UpdateStatus } = await import('#root/application/usecases/update-status')
    await expect(
      new UpdateStatus(uow, fixedClock()).run({
        actor: { id: 'a_agent', kind: 'agent', handle: 'hermes-1', display_name: 'Hermes' },
        tokenId: 'tok_agent',
        taskId: parent.id,
        to: 'in_review',
        reason: 'donezo',
        lease_token: claim.lease_token,
      })
    ).rejects.toMatchObject({ code: 'stale_lease' })

    // parent is no longer a leaf → cannot be claimed
    await expect(
      new ClaimTask(uow, fixedClock(), seqIds()).run({
        actor: { id: 'a_agent', kind: 'agent', handle: 'hermes-1', display_name: 'Hermes' },
        tokenId: 'tok_agent',
        taskId: parent.id,
      })
    ).rejects.toMatchObject({ code: 'not_a_leaf' })

    // children are claimable leaves
    const child = split.created[0] as { id: string }
    const childClaim = await new ClaimTask(uow, fixedClock(), seqIds()).run({
      actor: { id: 'a_agent', kind: 'agent', handle: 'hermes-1', display_name: 'Hermes' },
      tokenId: 'tok_agent',
      taskId: child.id,
    })
    expect(childClaim.generation).toBe(1)
    expect((await new SqliteTaskRepo(db).findById(child.id))?.status).toBe('in_progress')
    await db.destroy()
  })

  it('rejects zero children and unknown parent', async () => {
    const { db, uow } = await buildUow()
    const ids = seqIds()
    const parent = await new CreateTask(uow, fixedClock(), ids).run({ ...human, title: 'big' })
    const uc = new SplitTask(uow, fixedClock(), ids)
    await expect(uc.run({ ...human, taskId: parent.id, children: [] })).rejects.toMatchObject({
      code: 'invalid_request',
    })
    await expect(
      uc.run({ ...human, taskId: 't_ghost', children: [{ title: 'x' }] })
    ).rejects.toMatchObject({ code: 'not_found' })
    await db.destroy()
  })

  // ---- additional coverage (orchestrator coverage rule):

  it('rejects unknown child status with invalid_request (pre-transaction)', async () => {
    const { db, uow } = await buildUow()
    const ids = seqIds()
    const parent = await new CreateTask(uow, fixedClock(), ids).run({ ...human, title: 'big' })
    await expect(
      new SplitTask(uow, fixedClock(), ids).run({
        ...human,
        taskId: parent.id,
        children: [{ title: 'x', status: 'shipped' as never }],
      })
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await db.destroy()
  })

  it('stores explicit description/acceptance_criteria/status on children', async () => {
    const { db, uow } = await buildUow()
    const ids = seqIds()
    const parent = await new CreateTask(uow, fixedClock(), ids).run({ ...human, title: 'big' })
    const split = await new SplitTask(uow, fixedClock(), ids).run({
      ...human,
      taskId: parent.id,
      children: [
        {
          title: 'rich',
          description: 'the body',
          acceptance_criteria: 'AC-9',
          status: 'todo',
        },
      ],
    })
    const child = split.created[0]!
    expect(child.description).toBe('the body')
    expect(child.acceptance_criteria).toBe('AC-9')
    expect(child.status).toBe('todo')
    expect(child.position).toBe(1) // nextPosition: first child under parent
    await db.destroy()
  })
})
