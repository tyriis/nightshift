import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { SqliteTaskRepo } from '#root/infra/sqlite/task-repo'
import { freshDb, seedActor, seedToken } from '#root/testing/fixtures'

const setup = async () => {
  const db = await freshDb()
  await seedActor(db, 'a_creator', 'human')
  await seedActor(db, 'a_agent', 'agent')
  return db
}

const draft = (id: string, parentId: string | null = null) => ({
  id,
  parent_id: parentId,
  title: `Task ${id}`,
  description: 'd',
  acceptance_criteria: 'ac',
  status: 'todo' as const,
  position: 1,
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
    await repo.create(draft('t_ready'))
    await repo.create(draft('t_parent'))
    await repo.create(draft('t_child', 't_parent'))
    await repo.create({ ...draft('t_blocked'), status: 'backlog' })
    await sql`insert into labels (id, name, color, created_at)
              values ('l_infra', 'infra', '#f00', '2026-01-01')`.execute(db)
    await sql`insert into task_labels (task_id, label_id) values ('t_ready', 'l_infra')`.execute(db)

    const all = await repo.listReady({ limit: 10 })
    expect(all.map((r) => r.task.id)).toEqual(['t_ready'])
    const labeled = await repo.listReady({ label: 'infra', limit: 10 })
    expect(labeled.map((r) => r.task.id)).toEqual(['t_ready'])
    const other = await repo.listReady({ label: 'ui', limit: 10 })
    expect(other).toHaveLength(0)
    await db.destroy()
  })

  it('a child enters the ready queue only after its parent settles', async () => {
    const db = await setup()
    const repo = new SqliteTaskRepo(db)
    await repo.create(draft('t_parent'))
    await repo.create(draft('t_child', 't_parent'))
    expect((await repo.listReady({ limit: 10 })).map((r) => r.task.id)).toEqual([])
    await repo.setStatus('t_parent', 'done', '2026-01-02T00:00:00.000Z')
    expect((await repo.listReady({ limit: 10 })).map((r) => r.task.id)).toEqual(['t_child'])
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
})
