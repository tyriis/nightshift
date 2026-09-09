import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { loadConfig } from '#root/main/config'
import { makeDepsFromDb, type AppDeps } from '#root/main/deps'
import { makeDb } from '#root/infra/sqlite/db'
import { migrateToLatest } from '#root/infra/sqlite/migrations'
import { hashToken } from '#root/infra/token-hash'
import { buildApp } from '#root/adapters/rest/app'

export interface TestApp {
  app: FastifyInstance
  deps: AppDeps
  adminToken: string
  close(): Promise<void>
}

export const makeTestApp = async (overrides: NodeJS.ProcessEnv = {}): Promise<TestApp> => {
  // rate limit OFF by default (D-v: the suite must never trip it; Task 14 overrides to '2');
  // webhook loop OFF by default (the suite must never POST); file store lands in a temp dir, never the repo
  const db = makeDb(':memory:')
  await migrateToLatest(db)
  const deps = makeDepsFromDb(
    db,
    loadConfig({
      NS_DB_PATH: ':memory:',
      NS_RATE_LIMIT_PER_MIN: '0',
      NS_WEBHOOK_INTERVAL_MS: '0',
      NS_DATA_DIR: join(mkdtempSync(join(tmpdir(), 'ns-test-')), 'data'),
      ...overrides,
    })
  )
  const adminToken = randomBytes(32).toString('base64url')
  const now = new Date().toISOString()
  await db
    .insertInto('actors')
    .values({
      id: 'a_nils',
      kind: 'human',
      handle: 'nils',
      display_name: 'Nils',
      description: '',
      created_at: now,
      role: 'admin', // D-ss: the test admin is admin — the board owner seed
    })
    .execute()
  await db
    .insertInto('tokens')
    .values({
      id: 'tok_nils',
      actor_id: 'a_nils',
      token_hash: hashToken(adminToken),
      label: 'test',
      created_at: now,
      last_used_at: null,
      revoked_at: null,
    })
    .execute()
  const app = buildApp(deps)
  // Deliberately NOT app.ready()-ed here: tests attach probe routes (e.g. /idem-echo)
  // before their first inject, and fastify refuses route registration after boot
  // ("Root plugin has already booted"). inject() boots on demand — the ephemeral
  // :memory: db never needs the D-j startup purge (nothing can be in flight).
  return {
    app,
    deps,
    adminToken,
    close: async () => {
      await app.close()
      await db.destroy()
    },
  }
}
