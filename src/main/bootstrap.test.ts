import { describe, expect, it } from 'vitest'
import { loadConfig } from '#root/main/config'
import { makeDepsFromDb, type AppDeps } from '#root/main/deps'
import { ensureBootstrapAdmin } from '#root/main/bootstrap'
import { hashToken } from '#root/infra/token-hash'
import { freshDb } from '#root/testing/fixtures'

const LONG = 'x'.repeat(48)
const ROTATED = 'y'.repeat(48)

describe('bootstrap admin', () => {
  it('does nothing without a token', async () => {
    const db = await freshDb()
    const deps: AppDeps = makeDepsFromDb(db, loadConfig({}))
    await ensureBootstrapAdmin(deps)
    expect(await deps.actorsRoot.findByHandle('bootstrap')).toBeNull()
    await db.destroy()
  })

  it('re-activates the bootstrap token after revoke + next boot (env-as-truth upsert)', async () => {
    const db = await freshDb()
    const deps = makeDepsFromDb(db, loadConfig({ NS_BOOTSTRAP_TOKEN: LONG }))
    await ensureBootstrapAdmin(deps)
    await deps.actorsRoot.revokeToken('tok_bootstrap', deps.clock.now().toISOString())
    expect(await deps.actorsRoot.findActiveTokenByHash(hashToken(LONG))).toBeNull()
    await ensureBootstrapAdmin(deps) // next boot: env is truth
    const hit = await deps.actorsRoot.findActiveTokenByHash(hashToken(LONG))
    expect(hit?.actor.id).toBe('a_bootstrap')
    expect(hit?.token.revoked_at).toBeNull()
    await db.destroy()
  })

  it('rotates the token when NS_BOOTSTRAP_TOKEN changes (old hash stops resolving)', async () => {
    const db = await freshDb()
    await ensureBootstrapAdmin(makeDepsFromDb(db, loadConfig({ NS_BOOTSTRAP_TOKEN: LONG })))
    const deps = makeDepsFromDb(db, loadConfig({ NS_BOOTSTRAP_TOKEN: ROTATED }))
    await ensureBootstrapAdmin(deps) // no PK/UNIQUE crash
    const hit = await deps.actorsRoot.findActiveTokenByHash(hashToken(ROTATED))
    expect(hit?.actor.id).toBe('a_bootstrap')
    expect(await deps.actorsRoot.findActiveTokenByHash(hashToken(LONG))).toBeNull()
    await db.destroy()
  })

  it('reuses an existing a_bootstrap actor when no active token exists', async () => {
    const db = await freshDb()
    await db
      .insertInto('actors')
      .values({
        id: 'a_bootstrap',
        kind: 'human',
        handle: 'bootstrap',
        display_name: 'Bootstrap Admin',
        description: '',
        created_at: new Date().toISOString(),
      })
      .execute()
    const deps = makeDepsFromDb(db, loadConfig({ NS_BOOTSTRAP_TOKEN: LONG }))
    await ensureBootstrapAdmin(deps)
    const hit = await deps.actorsRoot.findActiveTokenByHash(hashToken(LONG))
    expect(hit?.actor.id).toBe('a_bootstrap')
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
