import { describe, expect, it } from 'vitest'
import { SqliteAuditRepo } from '#root/infra/sqlite/audit-repo'
import { freshDb } from '#root/testing/fixtures'

const entry = (entityId: string, action = 'task_created') => ({
  actor_id: 'a_1',
  token_id: null,
  action,
  entity_type: 'task',
  entity_id: entityId,
  after: { title: 'x' },
  reason: 'because',
  created_at: '2026-01-01T00:00:00.000Z',
})

describe('SqliteAuditRepo', () => {
  it('appends and searches newest-first with parsed payloads', async () => {
    const db = await freshDb()
    const repo = new SqliteAuditRepo(db)
    await repo.append(entry('t_1'))
    await repo.append(entry('t_2', 'status_changed'))

    const all = await repo.search({ limit: 10 })
    expect(all.map((r) => r.entity_id)).toEqual(['t_2', 't_1'])
    expect(all[0]?.after).toEqual({ title: 'x' })
    expect(all[0]?.reason).toBe('because')

    const filtered = await repo.search({ entity_type: 'task', entity_id: 't_1', limit: 10 })
    expect(filtered).toHaveLength(1)
    await db.destroy()
  })

  it('round-trips before-payloads and defaults missing payloads/reason to null', async () => {
    const db = await freshDb()
    const repo = new SqliteAuditRepo(db)
    await repo.append({
      actor_id: null,
      token_id: 'tok_1',
      action: 'status_changed',
      entity_type: 'task',
      entity_id: 't_1',
      before: { status: 'todo' },
      created_at: '2026-01-01T00:00:00.000Z',
    })

    const [row] = await repo.search({ limit: 10 })
    expect(row?.before).toEqual({ status: 'todo' })
    expect(row?.after).toBeNull()
    expect(row?.reason).toBeNull()
    expect(row?.actor_id).toBeNull()
    expect(row?.token_id).toBe('tok_1')
    await db.destroy()
  })

  it('caps by limit', async () => {
    const db = await freshDb()
    const repo = new SqliteAuditRepo(db)
    for (let i = 0; i < 5; i++) await repo.append(entry(`t_${i}`))
    expect(await repo.search({ limit: 2 })).toHaveLength(2)
    await db.destroy()
  })
})
