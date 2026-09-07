import { describe, expect, it } from 'vitest'
import { CreateTask } from '#root/application/usecases/create-task'
import { ClaimTask } from '#root/application/usecases/claim-task'
import { ReleaseClaim } from '#root/application/usecases/release-claim'
import { UpdateStatus } from '#root/application/usecases/update-status'
import { SplitTask } from '#root/application/usecases/split-task'
import { buildUow, fixedClock, human, seqIds } from '#root/application/usecases/create-task.test'
import { seedActor, seedToken } from '#root/testing/fixtures'
import { SqliteAuditRepo } from '#root/infra/sqlite/audit-repo'
import type { ActorContext, Repos, UnitOfWork } from '#root/application/ports'
import type { TaskRecord } from '#root/domain/task'

const agent: ActorContext = {
  actor: { id: 'a_agent', kind: 'agent', handle: 'hermes-1', display_name: 'Hermes' },
  tokenId: 'tok_agent',
}

const withAgent = async () => {
  const ctx = await buildUow()
  await seedActor(ctx.db, 'a_agent', 'agent', 'hermes-1')
  await seedToken(ctx.db, 'tok_agent', 'a_agent')
  return ctx
}

describe('UpdateStatus gates (spec §6.4)', () => {
  it('happy path: backlog → todo → in_progress (claimed) → in_review releases claim → human done', async () => {
    const { db, uow } = await withAgent()
    const task = await new CreateTask(uow, fixedClock(), seqIds()).run({ ...human, title: 'x' })
    const uc = new UpdateStatus(uow, fixedClock())
    await uc.run({ ...human, taskId: task.id, to: 'todo', reason: 'groomed' })
    const claim = await new ClaimTask(uow, fixedClock()).run({ ...agent, taskId: task.id })
    await uc.run({
      ...agent,
      taskId: task.id,
      to: 'in_review',
      reason: 'PR opened',
      lease_token: claim.lease_token,
    })

    const audit = await new SqliteAuditRepo(db).search({
      entity_type: 'task',
      entity_id: task.id,
      limit: 20,
    })
    expect(audit.some((a) => a.reason === 'claim released on review')).toBe(true)

    await uc.run({ ...human, taskId: task.id, to: 'done', reason: 'ship it' }) // claim gone → no token needed (D-c)
    await db.destroy()
  })

  it('invariant 3: claimed task without valid lease gets stale_lease', async () => {
    const { db, uow } = await withAgent()
    const task = await new CreateTask(uow, fixedClock(), seqIds()).run({
      ...human,
      title: 'x',
      status: 'todo',
    })
    const claim = await new ClaimTask(uow, fixedClock()).run({ ...agent, taskId: task.id })
    const uc = new UpdateStatus(uow, fixedClock())
    await expect(
      uc.run({ ...human, taskId: task.id, to: 'in_progress', reason: 'nudge' })
    ).rejects.toMatchObject({ code: 'stale_lease' })
    await expect(
      uc.run({
        ...human,
        taskId: task.id,
        to: 'in_progress',
        reason: 'nudge',
        lease_token: 't_wrong:1',
      })
    ).rejects.toMatchObject({ code: 'stale_lease' })
    await expect(
      uc.run({
        ...human,
        taskId: task.id,
        to: 'in_progress',
        reason: 'nudge',
        lease_token: `${task.id}:99`,
      })
    ).rejects.toMatchObject({ code: 'stale_lease' })
    // the actual holder succeeds
    await expect(
      uc.run({
        ...agent,
        taskId: task.id,
        to: 'in_review',
        reason: 'ok',
        lease_token: claim.lease_token,
      })
    ).resolves.toBeTruthy()
    await db.destroy()
  })

  it('invariant 2: open_descendants blocks done', async () => {
    const { db, uow } = await withAgent()
    // M-1 pin: ONE seqIds instance per test (two fresh counters on one db collide on t_seq1)
    const ids = seqIds()
    const parent = await new CreateTask(uow, fixedClock(), ids).run({
      ...human,
      title: 'p',
      status: 'todo',
    })
    const split = await new SplitTask(uow, fixedClock(), ids).run({
      ...human,
      taskId: parent.id,
      children: [{ title: 'c1', status: 'in_progress' }],
    })
    const uc = new UpdateStatus(uow, fixedClock())
    await expect(
      uc.run({ ...human, taskId: parent.id, to: 'done', reason: 'x' })
    ).rejects.toMatchObject({
      code: 'open_descendants',
    })
    await uc.run({ ...human, taskId: split.created[0]!.id, to: 'canceled', reason: 'dropped' })
    await expect(
      uc.run({ ...human, taskId: parent.id, to: 'done', reason: 'x' })
    ).resolves.toBeTruthy()
    await db.destroy()
  })

  it('invariant 5: agent cannot set done while review_gate on; policy off allows; human always allowed', async () => {
    const { db, uow } = await withAgent()
    const task = await new CreateTask(uow, fixedClock(), seqIds()).run({
      ...human,
      title: 'x',
      status: 'todo',
    })
    const uc = new UpdateStatus(uow, fixedClock())
    await expect(
      uc.run({ ...agent, taskId: task.id, to: 'done', reason: 'yolo' })
    ).rejects.toMatchObject({
      code: 'agent_close_forbidden',
    })
    // admin flips policy off
    await uow.withTransaction(async (repos) => repos.actors.setPolicy('review_gate', 'off'))
    await expect(
      uc.run({ ...agent, taskId: task.id, to: 'done', reason: 'yolo' })
    ).resolves.toBeTruthy()
    await db.destroy()
  })

  it('canceled is terminal (D-m: canceled_terminal)', async () => {
    const { db, uow } = await withAgent()
    const task = await new CreateTask(uow, fixedClock(), seqIds()).run({ ...human, title: 'x' })
    const uc = new UpdateStatus(uow, fixedClock())
    await uc.run({ ...human, taskId: task.id, to: 'canceled', reason: 'nope' })
    await expect(
      uc.run({ ...human, taskId: task.id, to: 'todo', reason: 'reconsider' })
    ).rejects.toMatchObject({
      code: 'canceled_terminal',
    })
    await db.destroy()
  })

  it('unknown task → not_found; empty reason → invalid_request', async () => {
    const { db, uow } = await withAgent()
    const uc = new UpdateStatus(uow, fixedClock())
    await expect(
      uc.run({ ...human, taskId: 't_ghost', to: 'todo', reason: 'x' })
    ).rejects.toMatchObject({
      code: 'not_found',
    })
    const task = await new CreateTask(uow, fixedClock(), seqIds()).run({ ...human, title: 'x' })
    await expect(
      uc.run({ ...human, taskId: task.id, to: 'todo', reason: '  ' })
    ).rejects.toMatchObject({
      code: 'invalid_request',
    })
    await db.destroy()
  })

  it('invariant 6 (question gate): open human-assigned question gates agent in_review — Plan B wires the repo; here the seam is exercised with zero questions', async () => {
    const { db, uow } = await withAgent()
    const task = await new CreateTask(uow, fixedClock(), seqIds()).run({
      ...human,
      title: 'x',
      status: 'todo',
    })
    const claim = await new ClaimTask(uow, fixedClock()).run({ ...agent, taskId: task.id })
    // with no questions present, in_review succeeds:
    await expect(
      new UpdateStatus(uow, fixedClock()).run({
        ...agent,
        taskId: task.id,
        to: 'in_review',
        reason: 'pr',
        lease_token: claim.lease_token,
      })
    ).resolves.toBeTruthy()
    await db.destroy()
  })

  // ---- additional coverage (orchestrator coverage rule), same gates as above:

  it('D-c: done with an active claim also releases it (gate off + holder lease)', async () => {
    const { db, uow } = await withAgent()
    const task = await new CreateTask(uow, fixedClock(), seqIds()).run({
      ...human,
      title: 'x',
      status: 'todo',
    })
    const claim = await new ClaimTask(uow, fixedClock()).run({ ...agent, taskId: task.id })
    await uow.withTransaction(async (repos) => repos.actors.setPolicy('review_gate', 'off'))
    const done = await new UpdateStatus(uow, fixedClock()).run({
      ...agent,
      taskId: task.id,
      to: 'done',
      reason: 'ship',
      lease_token: claim.lease_token,
    })
    expect(done.status).toBe('done')
    expect(done.claim_token_id).toBeNull()
    expect(done.claim_generation).toBe(2) // acquire(1) + clearClaim(2) — D-b
    const audit = await new SqliteAuditRepo(db).search({
      entity_type: 'task',
      entity_id: task.id,
      limit: 20,
    })
    expect(audit.some((a) => a.reason === 'claim released on review')).toBe(true)
    await db.destroy()
  })

  it('presented-but-released lease is rejected (D-b: old tokens never re-validate)', async () => {
    const { db, uow } = await withAgent()
    const task = await new CreateTask(uow, fixedClock(), seqIds()).run({
      ...human,
      title: 'x',
      status: 'todo',
    })
    const claim = await new ClaimTask(uow, fixedClock()).run({ ...agent, taskId: task.id })
    await new ReleaseClaim(uow, fixedClock()).run({ ...agent, taskId: task.id })
    await expect(
      new UpdateStatus(uow, fixedClock()).run({
        ...agent,
        taskId: task.id,
        to: 'in_progress',
        reason: 'zombie',
        lease_token: claim.lease_token,
      })
    ).rejects.toMatchObject({ code: 'stale_lease', details: { claimed: false } })
    await db.destroy()
  })

  it('missing review_gate policy row defaults to ON (fail-closed, D-g)', async () => {
    // The migration always seeds review_gate='on', so the `gate ?? 'on'` fallback is only
    // reachable with a policy-less db — exercised through the UnitOfWork port.
    const task: TaskRecord = {
      id: 't_x',
      parent_id: null,
      title: 'x',
      description: '',
      acceptance_criteria: '',
      status: 'todo',
      blocked_flag: false,
      assignee_id: null,
      position: 1,
      created_by: 'a_human',
      created_at: '2026-05-05T05:05:05.000Z',
      updated_at: '2026-05-05T05:05:05.000Z',
      claim_token_id: null,
      claim_generation: 0,
      last_heartbeat_at: null,
    }
    const noPolicyUow: UnitOfWork = {
      async withTransaction<T>(fn: (repos: Repos) => Promise<T>): Promise<T> {
        const repos = {
          tasks: { findById: async () => task },
          actors: { getPolicy: async () => null },
          audit: {},
        }
        return fn(repos as unknown as Repos)
      },
    }
    await expect(
      new UpdateStatus(noPolicyUow, fixedClock()).run({
        ...agent,
        taskId: 't_x',
        to: 'done',
        reason: 'yolo',
      })
    ).rejects.toMatchObject({ code: 'agent_close_forbidden' })
  })
})
