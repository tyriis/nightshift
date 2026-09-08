import { describe, expect, it } from 'vitest'
import { makeDb } from '#root/infra/sqlite/db'
import { migrateToLatest } from '#root/infra/sqlite/migrations'
import { SqliteAuditRepo } from '#root/infra/sqlite/audit-repo'
import { freshDb } from '#root/testing/fixtures'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

  it('empty-string filters are applied, not silently ignored', async () => {
    const db = await freshDb()
    const repo = new SqliteAuditRepo(db)
    // row matches the entity_id but has a non-empty entity_type
    await repo.append({ ...entry('some-id'), entity_type: 'x' })

    // entity_type: '' is a real filter value — it must MATCH NOTHING, not be dropped
    // the way a truthy check (`if (q.entity_type)`) would drop it.
    const rows = await repo.search({ entity_type: '', entity_id: 'some-id', limit: 10 })
    expect(rows).toEqual([])
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

const spineEntry = (n: number) => ({
  actor_id: 'a_x',
  token_id: null,
  action: `action_${n}`,
  entity_type: 'task',
  entity_id: 't_1',
  after: { n },
  reason: `reason ${n}`,
  created_at: '2026-01-01T00:00:00.000Z',
})

describe('audit spine reads (D-aa)', () => {
  it('tail returns rows after the cursor, ASCENDING; watermark is max(id)', async () => {
    const db = makeDb(':memory:')
    await migrateToLatest(db)
    const audit = new SqliteAuditRepo(db)
    expect(await audit.tail(0, 10)).toEqual([])
    expect(await audit.watermark()).toBe(0)
    for (const n of [1, 2, 3]) await audit.append(spineEntry(n))
    const rows = await audit.tail(1, 10)
    expect(rows.map((r) => r.id)).toEqual([2, 3]) // ASCENDING — the cursor advances forward
    expect(await audit.tail(3, 10)).toEqual([]) // caught up ⇒ empty
    expect(await audit.tail(1, 1)).toHaveLength(1) // limit respected, oldest-first slice
    expect(await audit.watermark()).toBe(3)
    await db.destroy()
  })

  it('tail excludes payloads by design of the ROUTE, not the repo: repo carries before/after', async () => {
    const db = makeDb(':memory:')
    await migrateToLatest(db)
    const audit = new SqliteAuditRepo(db)
    await audit.append(spineEntry(1))
    const [row] = await audit.tail(0, 10)
    expect(row?.after).toEqual({ n: 1 }) // strip lives in routes/events.ts (D-aa)
    await db.destroy()
  })

  it('cursor survives reopen on a file db (restart-monotonicity, spec §6.8)', async () => {
    // the claim of §6.8 is restart survival — an :memory: db cannot show it.
    // File db in a temp dir (os.tmpdir per binding), reopen, tail past the old cursor.
    const dir = mkdtempSync(join(tmpdir(), 'ns-audit-reopen-'))
    const path = join(dir, 'restart.db')
    const db1 = makeDb(path)
    await migrateToLatest(db1)
    const audit1 = new SqliteAuditRepo(db1)
    for (const n of [1, 2]) await audit1.append(spineEntry(n))
    const last = await audit1.watermark()
    await db1.destroy()
    const db2 = makeDb(path)
    const audit2 = new SqliteAuditRepo(db2)
    await expect(audit2.tail(last, 10)).resolves.toEqual([]) // nothing lost
    await audit2.append(spineEntry(3))
    expect((await audit2.tail(last, 10)).map((r) => r.action)).toEqual(['action_3']) // continues forward
    await db2.destroy()
  })
})
