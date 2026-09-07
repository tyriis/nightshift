import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { makeDb } from '#root/infra/sqlite/db'

describe('makeDb pragmas', () => {
  it('enables WAL for file-backed databases', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ns-db-'))
    const db = makeDb(join(dir, 'test.db'))
    const r = await sql<{ journal_mode: string }>`pragma journal_mode`.execute(db)
    expect(r.rows[0]?.journal_mode).toBe('wal')
    await db.destroy()
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps in-memory databases out of WAL (journal_mode=memory)', async () => {
    const db = makeDb(':memory:')
    const r = await sql<{ journal_mode: string }>`pragma journal_mode`.execute(db)
    expect(r.rows[0]?.journal_mode).toBe('memory')
    await db.destroy()
  })
})
