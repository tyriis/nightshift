import { describe, expect, it } from 'vitest'
import { sql, type Kysely, type KyselyPlugin } from 'kysely'
import { SqliteTaskRepo } from '#root/infra/sqlite/task-repo'
import type { DB } from '#root/infra/sqlite/schema'
import { freshDb, seedActor, seedToken } from '#root/testing/fixtures'

const setup = async () => {
  const db = await freshDb()
  await seedActor(db, 'a_creator', 'human')
  await seedActor(db, 'a_agent', 'agent')
  return db
}

const draft = (id: string, parentId: string | null = null, position = 1) => ({
  id,
  parent_id: parentId,
  title: `Task ${id}`,
  description: 'd',
  acceptance_criteria: 'ac',
  status: 'todo' as const,
  position,
  created_by: 'a_creator',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
})

describe('SqliteTaskRepo', () => {
  it('creates and reads back a task with defaults', async () => {
    const db = await setup()
    const repo = new SqliteTaskRepo(db)
    const created = await repo.create(draft('t_1'))
    expect(created.blocked_flag).toBe(false)
    expect(created.claim_generation).toBe(0)
    const found = await repo.findById('t_1')
    expect(found).toEqual(created)
    await db.destroy()
  })

  it('reports child counts and unmet blockers', async () => {
    const db = await setup()
    const repo = new SqliteTaskRepo(db)
    await repo.create(draft('t_parent'))
    await repo.create(draft('t_child', 't_parent'))
    await repo.create(draft('t_blocker'))
    await sql`insert into dependencies (blocker_id, blocked_id) values ('t_blocker', 't_child')`.execute(
      db
    )

    const parent = await repo.findWithCounts('t_parent')
    expect(parent?.child_count).toBe(1)
    const child = await repo.findWithCounts('t_child')
    expect(child?.unmet_blockers).toBe(1)

    // done blocker is met
    await repo.setStatus('t_blocker', 'done', '2026-01-02T00:00:00.000Z')
    expect((await repo.findWithCounts('t_child'))?.unmet_blockers).toBe(0)
    await db.destroy()
  })

  it('listReady applies every gate and the label filter', async () => {
    const db = await setup()
    const repo = new SqliteTaskRepo(db)
    // spec §6.3: NO parent-status gate — a todo leaf under a live todo parent is ready
    // (oracle ruling A). Distinct positions make the ordered assertion deterministic,
    // since positions are only unique per-parent.
    await repo.create(draft('t_parent', null, 2))
    await repo.create(draft('t_child', 't_parent', 1)) // todo leaf under live parent → ready
    await repo.create({ ...draft('t_blocked', null, 1), status: 'backlog' }) // status gate
    await repo.create(draft('t_ready', null, 3))
    // the remaining §6.3 gates, seeded explicitly:
    await seedToken(db, 'tok_gate', 'a_agent')
    await repo.create(draft('t_claimed', null, 4)) // claimed gate
    await sql`update tasks set claim_token_id = 'tok_gate' where id = 't_claimed'`.execute(db)
    await repo.create({ ...draft('t_gate_blocker', null, 6), status: 'backlog' }) // stays backlog → unmet, itself not ready
    await repo.create(draft('t_depblocked', null, 5)) // dependency gate
    await sql`insert into dependencies (blocker_id, blocked_id)
              values ('t_gate_blocker', 't_depblocked')`.execute(db)
    await repo.create(draft('t_flagged', null, 7)) // blocked_flag gate
    await sql`update tasks set blocked_flag = 1 where id = 't_flagged'`.execute(db)
    await sql`insert into labels (id, name, color, created_at)
              values ('l_infra', 'infra', '#f00', '2026-01-01')`.execute(db)
    await sql`insert into task_labels (task_id, label_id) values ('t_ready', 'l_infra')`.execute(db)

    const all = await repo.listReady({ limit: 10 })
    expect(all.map((r) => r.task.id)).toEqual(['t_child', 't_ready'])
    // Task 9 Step 0 (R3/B12): the listReady path carries labels too — GET /tasks/next
    // serializes toTaskDto, so the yaml Task schema promises labels on this path.
    expect(all.map((r) => r.labels)).toEqual([[], ['infra']])
    const labeled = await repo.listReady({ label: 'infra', limit: 10 })
    expect(labeled.map((r) => r.task.id)).toEqual(['t_ready'])
    expect(labeled[0]?.labels).toEqual(['infra'])
    const other = await repo.listReady({ label: 'ui', limit: 10 })
    expect(other).toHaveLength(0)
    await db.destroy()
  })

  it('claim CAS: one winner, generation bumps, clear invalidates', async () => {
    const db = await setup()
    const repo = new SqliteTaskRepo(db)
    await repo.create({ ...draft('t_1'), status: 'todo' })
    // claim_token_id has an FK to tokens (Task-3 schema) — token rows must exist
    await seedToken(db, 'tok_1', 'a_agent')
    await seedToken(db, 'tok_2', 'a_agent')

    const first = await repo.tryClaim(
      't_1',
      'tok_1',
      'a_agent',
      'in_progress',
      '2026-01-02T00:00:00.000Z'
    )
    expect(first).toEqual({ generation: 1 })
    const second = await repo.tryClaim(
      't_1',
      'tok_2',
      'a_agent',
      'in_progress',
      '2026-01-02T00:00:00.000Z'
    )
    expect(second).toBeNull()

    const claimed = await repo.findById('t_1')
    expect(claimed?.status).toBe('in_progress')
    expect(claimed?.assignee_id).toBe('a_agent')
    expect(claimed?.claim_token_id).toBe('tok_1')

    await repo.clearClaim('t_1', '2026-01-02T00:00:01.000Z')
    expect((await repo.findById('t_1'))?.claim_generation).toBe(2)

    // re-claim yields generation 3 — old token (gen 1) can never validate again
    const third = await repo.tryClaim(
      't_1',
      'tok_2',
      'a_agent',
      'in_progress',
      '2026-01-02T00:00:02.000Z'
    )
    expect(third).toEqual({ generation: 3 })
    await db.destroy()
  })

  it('claiming an in_progress task keeps its status', async () => {
    const db = await setup()
    const repo = new SqliteTaskRepo(db)
    await repo.create({ ...draft('t_1'), status: 'in_progress' })
    await seedToken(db, 'tok_1', 'a_agent')
    await repo.tryClaim('t_1', 'tok_1', 'a_agent', 'in_progress', '2026-01-02T00:00:00.000Z')
    expect((await repo.findById('t_1'))?.status).toBe('in_progress')
    await db.destroy()
  })

  it('open-descendant count skips done/canceled, includes grandchildren', async () => {
    const db = await setup()
    const repo = new SqliteTaskRepo(db)
    await repo.create(draft('t_root'))
    await repo.create({ ...draft('t_mid', 't_root'), status: 'done' })
    await repo.create({ ...draft('t_leaf', 't_mid'), status: 'canceled' })
    await repo.create({ ...draft('t_leaf2', 't_mid'), status: 'in_progress' })
    expect(await repo.countOpenDescendants('t_root')).toBe(1)
    expect(await repo.hasChildren('t_root')).toBe(true)
    expect(await repo.hasChildren('t_leaf2')).toBe(false)
    await db.destroy()
  })

  it('ancestors returns the chain root-first', async () => {
    const db = await setup()
    const repo = new SqliteTaskRepo(db)
    await repo.create(draft('t_a'))
    await repo.create(draft('t_b', 't_a'))
    await repo.create(draft('t_c', 't_b'))
    const chain = await repo.ancestors('t_c')
    expect(chain.map((t) => t.id)).toEqual(['t_a', 't_b'])
    expect(await repo.ancestors('t_a')).toEqual([])
    await db.destroy()
  })

  it('patch maps booleans and whitelists columns; nextPosition orders siblings', async () => {
    const db = await setup()
    const repo = new SqliteTaskRepo(db)
    await repo.create(draft('t_1'))
    await repo.create(draft('t_2'))
    expect(await repo.nextPosition(null)).toBe(2)
    expect(await repo.nextPosition('t_1')).toBe(1)
    await repo.patch(
      't_1',
      { blocked_flag: true, title: 'renamed', assignee_id: 'a_agent' },
      '2026-01-03T00:00:00.000Z'
    )
    const t = await repo.findById('t_1')
    expect(t?.blocked_flag).toBe(true)
    expect(t?.title).toBe('renamed')
    expect(t?.assignee_id).toBe('a_agent')
    await db.destroy()
  })

  it('listAllWithCounts returns every task ordered by position with counts', async () => {
    const db = await setup()
    const repo = new SqliteTaskRepo(db)
    await repo.create({ ...draft('t_b'), position: 3 })
    await repo.create({ ...draft('t_a'), position: 1 })
    await repo.create({ ...draft('t_child', 't_a'), position: 2 })
    const rows = await repo.listAllWithCounts()
    expect(rows.map((r) => r.task.id)).toEqual(['t_a', 't_child', 't_b'])
    expect(rows[0]?.child_count).toBe(1)
    expect(rows[1]?.child_count).toBe(0)
    expect(await repo.findWithCounts('t_ghost')).toBeNull()
    expect(await repo.findById('t_ghost')).toBeNull()
    await db.destroy()
  })

  it('patch updates description and acceptance_criteria and can clear the assignee', async () => {
    const db = await setup()
    const repo = new SqliteTaskRepo(db)
    await repo.create(draft('t_1'))
    await repo.patch(
      't_1',
      { description: 'new-d', acceptance_criteria: 'new-ac', assignee_id: 'a_agent' },
      '2026-01-03T00:00:00.000Z'
    )
    expect((await repo.findById('t_1'))?.assignee_id).toBe('a_agent')
    await repo.patch('t_1', { assignee_id: null, blocked_flag: true }, '2026-01-04T00:00:00.000Z')
    expect((await repo.findById('t_1'))?.blocked_flag).toBe(true)
    await repo.patch('t_1', { blocked_flag: false }, '2026-01-05T00:00:00.000Z')
    const t = await repo.findById('t_1')
    expect(t?.description).toBe('new-d')
    expect(t?.acceptance_criteria).toBe('new-ac')
    expect(t?.assignee_id).toBeNull()
    expect(t?.blocked_flag).toBe(false)
    await db.destroy()
  })

  it('heartbeat records liveness timestamp', async () => {
    const db = await setup()
    const repo = new SqliteTaskRepo(db)
    await repo.create(draft('t_1'))
    await repo.setHeartbeat('t_1', '2026-01-04T00:00:00.000Z')
    expect((await repo.findById('t_1'))?.last_heartbeat_at).toBe('2026-01-04T00:00:00.000Z')
    await db.destroy()
  })

  // ---- Task 9 Step 0 (review R3/B12): labels ride the TaskDto ----
  // The batched resolution gets pinned coverage on EVERY path returning
  // TaskWithCounts: exactly ONE labels query per response (N+1 fails the
  // delta pins) and ZERO queries when the id set is empty (the guard —
  // `in ()` is invalid SQL, the guard arm is the whole story).
  const countedRepo = async (db: Kysely<DB>) => {
    const nodes: string[] = []
    const plugin: KyselyPlugin = {
      transformQuery: (args) => {
        nodes.push(JSON.stringify(args.node))
        return args.node
      },
      transformResult: async (args) => args.result,
    }
    return { repo: new SqliteTaskRepo(db.withPlugin(plugin)), nodes }
  }

  const seedLabel = async (db: Kysely<DB>, taskId: string, name: string): Promise<void> => {
    await sql`insert or ignore into labels (id, name, color, created_at)
              values (${'l_' + name}, ${name}, '#f00', '2026-01-01')`.execute(db)
    await sql`insert into task_labels (task_id, label_id)
              values (${taskId}, ${'l_' + name})`.execute(db)
  }

  it('findWithCounts resolves label names sorted; unlabeled tasks get []', async () => {
    const db = await setup()
    const repo = new SqliteTaskRepo(db)
    await repo.create(draft('t_1'))
    await repo.create(draft('t_2'))
    await seedLabel(db, 't_1', 'zeta')
    await seedLabel(db, 't_1', 'alpha')
    expect((await repo.findWithCounts('t_1'))?.labels).toEqual(['alpha', 'zeta'])
    expect((await repo.findWithCounts('t_2'))?.labels).toEqual([])
    await db.destroy()
  })

  it('labels ride ONE batched query per response; empty sets issue none', async () => {
    const db = await setup()
    const { repo, nodes } = await countedRepo(db)
    expect(await repo.listAllWithCounts()).toEqual([])
    expect(nodes).toHaveLength(1) // empty-set guard: no labels query exists to run

    await repo.create(draft('t_1', null, 1))
    await repo.create(draft('t_2', null, 2))
    await repo.create(draft('t_3', null, 3))
    await seedLabel(db, 't_1', 'alpha')
    await seedLabel(db, 't_1', 'zeta')
    await seedLabel(db, 't_2', 'beta')
    nodes.length = 0
    const rows = await repo.listAllWithCounts()
    expect(rows.map((r) => r.labels)).toEqual([['alpha', 'zeta'], ['beta'], []])
    expect(nodes).toHaveLength(2) // base + exactly ONE labels query for 3 tasks (N+1 = 5)
    expect(nodes[1]).toContain('task_labels')

    nodes.length = 0
    expect((await repo.findWithCounts('t_1'))?.labels).toEqual(['alpha', 'zeta'])
    expect(nodes).toHaveLength(2) // single-get path: one batch too, never per-label joins

    nodes.length = 0
    expect(await repo.findWithCounts('t_ghost')).toBeNull()
    expect(nodes).toHaveLength(1) // the miss returns BEFORE any labels query

    nodes.length = 0
    const ready = await repo.listReady({ limit: 10 })
    expect(ready.map((r) => r.labels)).toEqual([['alpha', 'zeta'], ['beta'], []])
    expect(nodes).toHaveLength(2)

    nodes.length = 0
    expect(await repo.listReady({ label: 'nope', limit: 10 })).toEqual([])
    expect(nodes).toHaveLength(1) // empty-set guard on the filtered path
    await db.destroy()
  })
})

// D-hhh — the keepalive sweep primitives, pinned on a SEEDED store (claim /
// heartbeat / canceled / legacy-null-anchor rows through the REAL repo paths —
// F's binding lesson: stateful seeding, never fresh fixtures).
describe('stale-claim sweep primitives (D-hhh)', () => {
  it('tryClaim stamps the liveness anchor — the claim IS the first heartbeat', async () => {
    const db = await setup()
    const repo = new SqliteTaskRepo(db)
    await seedToken(db, 'tok_s', 'a_agent')
    await repo.create(draft('t_1'))
    const r = await repo.tryClaim(
      't_1',
      'tok_s',
      'a_agent',
      'in_progress',
      '2026-01-02T00:00:00.000Z'
    )
    expect(r).not.toBeNull()
    expect((await repo.findById('t_1'))?.last_heartbeat_at).toBe('2026-01-02T00:00:00.000Z')
    await db.destroy()
  })

  it('listStaleClaims finds silent in_progress claims only; coalesce carries legacy rows', async () => {
    const db = await setup()
    const repo = new SqliteTaskRepo(db)
    for (const t of ['tok_s', 'tok_f', 'tok_l']) await seedToken(db, t, 'a_agent')
    await repo.create(draft('t_stale'))
    await repo.tryClaim('t_stale', 'tok_s', 'a_agent', 'in_progress', '2026-01-02T00:00:00.000Z')
    await repo.setHeartbeat('t_stale', '2026-01-03T00:00:00.000Z')
    await repo.create(draft('t_live'))
    await repo.tryClaim('t_live', 'tok_f', 'a_agent', 'in_progress', '2026-01-02T00:00:00.000Z')
    await repo.setHeartbeat('t_live', '2026-01-06T00:00:00.000Z')
    await repo.create(draft('t_legacy'))
    // the pre-G claim shape: token + status WITHOUT any heartbeat value — the
    // coalesce anchor is updated_at (draft literal: 2026-01-01) → stale vs cutoff
    await sql`update tasks set claim_token_id='tok_l', status='in_progress' where id='t_legacy'`.execute(
      db
    )
    const hit = await repo.listStaleClaims('2026-01-05T00:00:00.000Z', 50)
    expect(hit.map((h) => h.id)).toEqual(['t_legacy', 't_stale']) // ascending by id
    // canceled is terminal — a claimed canceled row is NEVER sweep material.
    // (P4 FORCED amendment: the cutoff stays 01-05 — at 01-07 t_live is
    // HONESTLY stale and the assertion would record the wrong truth; at 01-05
    // the CANCEL is what excludes t_stale, so the arm stays discriminating.)
    await repo.setStatus('t_stale', 'canceled', '2026-01-06T00:00:00.000Z')
    const after = await repo.listStaleClaims('2026-01-05T00:00:00.000Z', 50)
    expect(after.map((h) => h.id)).toEqual(['t_legacy'])
    await db.destroy()
  })

  it('expireStaleClaim is the FULL CAS: wrong token/generation, fresh heartbeat, all miss', async () => {
    const db = await setup()
    const repo = new SqliteTaskRepo(db)
    await seedToken(db, 'tok_s', 'a_agent')
    await seedToken(db, 'tok_x', 'a_agent')
    await repo.create(draft('t_1'))
    await repo.tryClaim('t_1', 'tok_s', 'a_agent', 'in_progress', '2026-01-02T00:00:00.000Z')
    const cutoff = '2026-01-05T00:00:00.000Z'
    const base = { taskId: 't_1', cutoff, at: '2026-01-06T00:00:00.000Z' } as const
    expect(await repo.expireStaleClaim({ ...base, tokenId: 'tok_x', generation: 1 })).toBeNull()
    expect(await repo.expireStaleClaim({ ...base, tokenId: 'tok_s', generation: 99 })).toBeNull()
    // the race-defeat arm: a heartbeat fresher than the cutoff defeats the sweep
    await repo.setHeartbeat('t_1', '2026-01-06T00:00:00.000Z')
    expect(await repo.expireStaleClaim({ ...base, tokenId: 'tok_s', generation: 1 })).toBeNull()
    // the exact captured stale claim expires: todo, unclaimed, fence bumped, anchor cleared
    await repo.setHeartbeat('t_1', '2026-01-03T00:00:00.000Z')
    expect(await repo.expireStaleClaim({ ...base, tokenId: 'tok_s', generation: 1 })).toEqual({
      generation: 2,
    })
    const t = (await repo.findById('t_1'))!
    expect([t.status, t.claim_token_id, t.claim_generation, t.last_heartbeat_at]).toEqual([
      'todo',
      null,
      2,
      null,
    ])
    await db.destroy()
  })
})
