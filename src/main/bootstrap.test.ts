import { describe, expect, it } from 'vitest'
import { loadConfig } from '#root/main/config'
import { makeDepsFromDb, type AppDeps } from '#root/main/deps'
import { ensureBootstrapAdmin } from '#root/main/bootstrap'
import { hashToken } from '#root/infra/token-hash'
import { freshDb } from '#root/testing/fixtures'

const LONG = 'x'.repeat(48)

describe('bootstrap admin', () => {
  it('does nothing without a token', async () => {
    const db = await freshDb()
    const deps: AppDeps = makeDepsFromDb(db, loadConfig({}))
    await ensureBootstrapAdmin(deps)
    expect(await deps.actorsRoot.findByHandle('bootstrap')).toBeNull()
    await db.destroy()
  })

  it('ensures a human admin + token, idempotently', async () => {
    const db = await freshDb()
    const deps = makeDepsFromDb(db, loadConfig({ NS_BOOTSTRAP_TOKEN: LONG }))
    await ensureBootstrapAdmin(deps)
    await ensureBootstrapAdmin(deps) // no duplicate/throw
    const hit = await deps.actorsRoot.findActiveTokenByHash(hashToken(LONG))
    expect(hit?.actor.handle).toBe('bootstrap')
    expect(hit?.actor.kind).toBe('human')
    await db.destroy()
  })
})
