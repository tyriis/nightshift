import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { CreateTask } from '#root/application/usecases/create-task'
import { ClaimTask } from '#root/application/usecases/claim-task'
import { ReleaseClaim } from '#root/application/usecases/release-claim'
import { Heartbeat } from '#root/application/usecases/heartbeat'
import { UpdateStatus } from '#root/application/usecases/update-status'
import { SplitTask } from '#root/application/usecases/split-task'
import { buildUow, fixedClock, human, seqIds } from '#root/application/usecases/create-task.test'
import { seedActor, seedToken } from '#root/testing/fixtures'
import { SqliteTaskRepo } from '#root/infra/sqlite/task-repo'
import { formatLeaseToken } from '#root/domain/claim'
import type { ActorContext, IdGen, Repos, UnitOfWork } from '#root/application/ports'
import type { TaskRecord } from '#root/domain/task'

const agentA: ActorContext = {
  actor: { id: 'a_agent_a', kind: 'agent', handle: 'hermes-a', display_name: 'Hermes A' },
  tokenId: 'tok_a',
}
const agentB: ActorContext = {
  actor: { id: 'a_agent_b', kind: 'agent', handle: 'hermes-b', display_name: 'Hermes B' },
  tokenId: 'tok_b',
}

// M-1 pin: ONE seqIds instance per db. setup() takes the test's shared instance so
// post-setup constructions (SplitTask/CreateTask in the gates test) cannot mint colliding ids.
const setup = async (ids: IdGen = seqIds()) => {
  const { db, uow } = await buildUow()
  await seedActor(db, 'a_agent_a', 'agent', 'hermes-a')
  await seedActor(db, 'a_agent_b', 'agent', 'hermes-b')
  await seedToken(db, 'tok_a', 'a_agent_a')
  await seedToken(db, 'tok_b', 'a_agent_b')
  const task = await new CreateTask(uow, fixedClock(), ids).run({
    ...human,
    title: 'work',
    status: 'todo',
  })
  return { db, uow, task }
}

describe('ClaimTask exclusivity (spec §6.4.1/4)', () => {
  it('first claim wins, second gets already_claimed with holder identity, release frees it', async () => {
    const { db, uow, task } = await setup()
    const claimUc = new ClaimTask(uow, fixedClock(), seqIds())
    const won = await claimUc.run({ ...agentA, taskId: task.id })
    expect(won).toEqual({ lease_token: formatLeaseToken(task.id, 1), generation: 1 })

    await expect(claimUc.run({ ...agentB, taskId: task.id })).rejects.toMatchObject({
      code: 'already_claimed',
      details: { holder_handle: 'hermes-a' },
    })

    await new ReleaseClaim(uow, fixedClock()).run({ ...agentA, taskId: task.id })
    const second = await claimUc.run({ ...agentB, taskId: task.id })
    expect(second.generation).toBe(3) // 1: claim, 2: release-bump, 3: re-claim

    const after = await new SqliteTaskRepo(db).findById(task.id)
    expect(after?.claim_token_id).toBe('tok_b')
    expect(after?.assignee_id).toBe('a_agent_b')
    await db.destroy()
  })

  it('gates: not_a_leaf on parent, invalid_request on backlog, canceled_terminal, token required', async () => {
    const ids = seqIds() // M-1 pin: shared with setup()
    const { db, uow, task } = await setup(ids)
    const split = await new SplitTask(uow, fixedClock(), ids).run({
      ...human,
      taskId: task.id,
      children: [{ title: 'c' }],
    })
    await expect(
      new ClaimTask(uow, fixedClock(), seqIds()).run({ ...agentA, taskId: task.id })
    ).rejects.toMatchObject({ code: 'not_a_leaf' })

    const backlog = await new CreateTask(uow, fixedClock(), ids).run({ ...human, title: 'b' })
    await expect(
      new ClaimTask(uow, fixedClock(), seqIds()).run({ ...agentA, taskId: backlog.id })
    ).rejects.toMatchObject({ code: 'invalid_request' })

    const canceled = await new CreateTask(uow, fixedClock(), ids).run({ ...human, title: 'z' })
    await new UpdateStatus(uow, fixedClock()).run({
      ...human,
      taskId: canceled.id,
      to: 'canceled',
      reason: 'drop',
    })
    await expect(
      new ClaimTask(uow, fixedClock(), seqIds()).run({ ...agentA, taskId: canceled.id })
    ).rejects.toMatchObject({ code: 'canceled_terminal' })

    await expect(
      new ClaimTask(uow, fixedClock(), seqIds()).run({ ...human, taskId: split.created[0]!.id })
    ).rejects.toMatchObject({ code: 'invalid_request' }) // human bootstrap w/o tokenId cannot claim
    await db.destroy()
  })

  it('release/heartbeat require the current claim', async () => {
    const { db, uow, task } = await setup()
    await expect(
      new ReleaseClaim(uow, fixedClock()).run({ ...agentA, taskId: task.id })
    ).rejects.toMatchObject({
      code: 'stale_lease',
    })
    const claim = await new ClaimTask(uow, fixedClock(), seqIds()).run({
      ...agentA,
      taskId: task.id,
    })

    await expect(
      new Heartbeat(uow, fixedClock()).run({
        ...agentB,
        taskId: task.id,
        lease_token: claim.lease_token,
      })
    ).rejects.toMatchObject({ code: 'stale_lease' })
    await expect(
      new Heartbeat(uow, fixedClock()).run({
        ...agentA,
        taskId: task.id,
        lease_token: `${task.id}:99`,
      })
    ).rejects.toMatchObject({ code: 'stale_lease' })

    const alive = await new Heartbeat(uow, fixedClock()).run({
      ...agentA,
      taskId: task.id,
      lease_token: claim.lease_token,
    })
    expect(alive.last_heartbeat_at).toBe('2026-05-05T05:05:05.000Z')

    // B cannot release A's claim; A can
    await expect(
      new ReleaseClaim(uow, fixedClock()).run({ ...agentB, taskId: task.id })
    ).rejects.toMatchObject({
      code: 'stale_lease',
    })
    const released = await new ReleaseClaim(uow, fixedClock()).run({ ...agentA, taskId: task.id })
    expect(released.claim_token_id).toBeNull()
    await db.destroy()
  })

  // ---- additional coverage (orchestrator coverage rule):

  it('claim/release/heartbeat on unknown task → not_found', async () => {
    const { db, uow } = await setup()
    await expect(
      new ClaimTask(uow, fixedClock(), seqIds()).run({ ...agentA, taskId: 't_ghost' })
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      new ReleaseClaim(uow, fixedClock()).run({ ...agentA, taskId: 't_ghost' })
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      new Heartbeat(uow, fixedClock()).run({
        ...agentA,
        taskId: 't_ghost',
        lease_token: 't_ghost:1',
      })
    ).rejects.toMatchObject({ code: 'not_found' })
    await db.destroy()
  })

  it('heartbeat rejects malformed or foreign-task leases; tokenless actor cannot release', async () => {
    const ids = seqIds() // M-1 pin: shared with setup()
    const { db, uow, task } = await setup(ids)
    const claim = await new ClaimTask(uow, fixedClock(), seqIds()).run({
      ...agentA,
      taskId: task.id,
    })
    // valid generation, wrong task id in the lease:
    await expect(
      new Heartbeat(uow, fixedClock()).run({
        ...agentA,
        taskId: task.id,
        lease_token: `t_other:${claim.generation}`,
      })
    ).rejects.toMatchObject({ code: 'stale_lease' })
    // unparseable lease:
    await expect(
      new Heartbeat(uow, fixedClock()).run({
        ...agentA,
        taskId: task.id,
        lease_token: 'nonsense',
      })
    ).rejects.toMatchObject({ code: 'stale_lease' })
    // human (tokenId null) releasing an unclaimed task hits the missing-token branch:
    const free = await new CreateTask(uow, fixedClock(), ids).run({
      ...human,
      title: 'free',
      status: 'todo',
    })
    await expect(
      new ReleaseClaim(uow, fixedClock()).run({ ...human, taskId: free.id })
    ).rejects.toMatchObject({ code: 'stale_lease', details: { claimed: false } })
    await db.destroy()
  })

  it('defensive: lost CAS + missing holder row still yields already_claimed with fallback identity', async () => {
    // Unreachable on real single-connection SQLite (transactions serialize and FKs
    // guarantee the holder row), so this races/absent-holder defensive path is exercised
    // through the UnitOfWork port itself.
    const unclaimed: TaskRecord = {
      id: 't_race',
      parent_id: null,
      title: 'race',
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
    // D-cc: the fake captures the loser's inbox copy too — the second withTransaction
    // call (after the first rolled back) must land a claim_conflict row for the loser.
    const inboxAdds: Array<{
      id: string
      actor_id: string
      kind: string
      task_id: string
      thread_id: string | null
      created_at: string
    }> = []
    const raceUow: UnitOfWork = {
      async withTransaction<T>(fn: (repos: Repos) => Promise<T>): Promise<T> {
        const repos = {
          tasks: {
            findById: async () => unclaimed,
            hasChildren: async () => false,
            tryClaim: async () => null, // lost the race between check and CAS
          },
          actors: { findActorByTokenId: async () => null },
          audit: { append: async () => undefined },
          inbox: {
            add: async (d: (typeof inboxAdds)[number]) => {
              inboxAdds.push(d)
            },
          },
        }
        return fn(repos as unknown as Repos)
      },
    }
    await expect(
      new ClaimTask(raceUow, fixedClock(), seqIds()).run({ ...agentA, taskId: 't_race' })
    ).rejects.toMatchObject({
      code: 'already_claimed',
      message: 'task is claimed by another actor',
      details: { holder_handle: null, holder_display_name: null },
    })
    expect(inboxAdds).toEqual([
      {
        id: 'ib_seq1',
        actor_id: 'a_agent_a',
        kind: 'claim_conflict',
        task_id: 't_race',
        thread_id: null,
        created_at: '2026-05-05T05:05:05.000Z',
      },
    ])
  })
})

// D-cc: the race loser's async copy — second transaction, rethrow byte-exact, no audit.
describe('ClaimTask claim_conflict loser copy (D-cc)', () => {
  it('race loser gets a claim_conflict inbox copy AND still gets the unchanged 409 (D-cc)', async () => {
    const { db, uow, task } = await setup()
    const uc = new ClaimTask(uow, fixedClock(), seqIds())
    await uc.run({ ...agentA, taskId: task.id })
    await expect(uc.run({ ...agentB, taskId: task.id })).rejects.toMatchObject({
      code: 'already_claimed',
      details: { holder_handle: 'hermes-a', holder_display_name: 'Seed a_agent_a' }, // contract byte-exact (ora-14 M-1)
    })
    const rows = await db.selectFrom('inbox_items').selectAll().execute()
    expect(rows.map((r) => [r.actor_id, r.kind, r.task_id])).toEqual([
      ['a_agent_b', 'claim_conflict', task.id],
    ])
    // NOT audited (D-cc): a rejection is not a workspace mutation (D-r doctrine)
    expect(
      (await db.selectFrom('audit_log').select('action').execute()).map((a) => a.action)
    ).not.toContain('claim_conflict')
    await db.destroy()
  })

  it('holder re-claiming its OWN task does NOT spam its inbox (D-cc guard)', async () => {
    const { db, uow, task } = await setup()
    const uc = new ClaimTask(uow, fixedClock(), seqIds())
    await uc.run({ ...agentA, taskId: task.id })
    await expect(uc.run({ ...agentA, taskId: task.id })).rejects.toMatchObject({
      code: 'already_claimed',
    })
    expect(await db.selectFrom('inbox_items').selectAll().execute()).toEqual([])
    await db.destroy()
  })

  it('other rejection paths leave no inbox trace (not_found path untouched)', async () => {
    const { db, uow } = await setup()
    await expect(
      new ClaimTask(uow, fixedClock(), seqIds()).run({ ...agentB, taskId: 't_ghost' })
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(await db.selectFrom('inbox_items').selectAll().execute()).toEqual([])
    await db.destroy()
  })
})

// Spec §11.1: model-based claim/release interleavings.
describe('claim/release/status interleavings (model-based, spec §6.4.3/4)', () => {
  it('no stale lease ever accepted; generation and holder always match the model', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.constantFrom(
            'claimA',
            'claimB',
            'releaseHolder',
            'statusWithOldToken',
            'statusWithLiveToken'
          ),
          { maxLength: 15 }
        ),
        async (ops) => {
          const { db, uow, task } = await setup()
          // ora-14 M-7b: destroy even on assertion failure — a leaking in-memory db per
          // shrunk run starves the property of runs.
          try {
            const claimants: Record<'A' | 'B', ActorContext> = { A: agentA, B: agentB }
            const claimUc = new ClaimTask(uow, fixedClock(), seqIds())
            const releaseUc = new ReleaseClaim(uow, fixedClock())
            const statusUc = new UpdateStatus(uow, fixedClock())

            let holder: 'A' | 'B' | null = null
            let generation = 0
            let liveToken = ''
            let oldToken = ''

            for (const op of ops) {
              if (op === 'claimA' || op === 'claimB') {
                const who = op === 'claimA' ? ('A' as const) : ('B' as const)
                if (holder === null) {
                  const res = await claimUc.run({ ...claimants[who], taskId: task.id })
                  generation += 1
                  expect(res.generation).toBe(generation)
                  expect(res.lease_token).toBe(formatLeaseToken(task.id, generation))
                  if (liveToken) oldToken = liveToken
                  holder = who
                  liveToken = res.lease_token
                } else {
                  const loser = who === 'A' ? 'B' : 'A'
                  await expect(
                    claimUc.run({ ...claimants[loser], taskId: task.id })
                  ).rejects.toMatchObject({ code: 'already_claimed' })
                }
              } else if (op === 'releaseHolder') {
                if (holder === null) {
                  await expect(releaseUc.run({ ...agentA, taskId: task.id })).rejects.toMatchObject(
                    {
                      code: 'stale_lease',
                    }
                  )
                } else {
                  await releaseUc.run({ ...claimants[holder], taskId: task.id })
                  oldToken = liveToken
                  liveToken = ''
                  holder = null
                  generation += 1
                }
              } else if (op === 'statusWithOldToken') {
                if (holder !== null && oldToken) {
                  await expect(
                    statusUc.run({
                      ...claimants[holder],
                      taskId: task.id,
                      to: 'in_progress',
                      reason: 'zombie',
                      lease_token: oldToken,
                    })
                  ).rejects.toMatchObject({ code: 'stale_lease' })
                } else if (holder === null) {
                  if (oldToken) {
                    // ora-14 M-4 (Dev-1 pin): on an UNCLAIMED task a PRESENTED old token is
                    // rejected as a zombie (claimed:false) — it must never morph into the
                    // tokenless human op that an ABSENT lease permits (D-c).
                    await expect(
                      statusUc.run({
                        ...human,
                        taskId: task.id,
                        to: 'in_progress',
                        reason: 'zombie',
                        lease_token: oldToken,
                      })
                    ).rejects.toMatchObject({ code: 'stale_lease', details: { claimed: false } })
                  } else {
                    await statusUc.run({
                      ...human,
                      taskId: task.id,
                      to: 'in_progress',
                      reason: 'by hand',
                    })
                  }
                }
              } else {
                // statusWithLiveToken
                if (holder !== null) {
                  await statusUc.run({
                    ...claimants[holder],
                    taskId: task.id,
                    to: 'in_progress',
                    reason: 'progress',
                    lease_token: liveToken,
                  })
                } else {
                  await statusUc.run({
                    ...human,
                    taskId: task.id,
                    to: 'in_progress',
                    reason: 'by hand',
                  })
                }
              }
            }

            const final = await new SqliteTaskRepo(db).findById(task.id)
            expect(final?.claim_generation).toBe(generation)
            expect(final?.claim_token_id !== null).toBe(holder !== null)
          } finally {
            await db.destroy()
          }
        }
      ),
      { numRuns: 40 }
    )
  })
})
