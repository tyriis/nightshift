import { describe, expect, it } from 'vitest'
import { SqliteActorRepo } from '#root/infra/sqlite/actor-repo'
import { freshDb } from '#root/testing/fixtures'

describe('SqliteActorRepo', () => {
  const seed = async () => {
    const db = await freshDb()
    const repo = new SqliteActorRepo(db)
    const actor = await repo.create({
      id: 'a_1',
      kind: 'agent',
      handle: 'hermes-1',
      display_name: 'Hermes',
      description: '',
      created_at: '2026-01-01T00:00:00.000Z',
      role: null,
    })
    return { db, repo, actor }
  }

  it('create/find/list by handle and id', async () => {
    const { db, repo } = await seed()
    expect((await repo.findByHandle('hermes-1'))?.id).toBe('a_1')
    expect(await repo.findByHandle('nope')).toBeNull()
    expect((await repo.findById('a_1'))?.kind).toBe('agent')
    expect(await repo.findById('nope')).toBeNull()
    expect(await repo.list()).toHaveLength(1)
    await db.destroy()
  })

  it('token lookup only returns active tokens; revoke hides them', async () => {
    const { db, repo } = await seed()
    await repo.insertToken({
      id: 'tok_1',
      actor_id: 'a_1',
      token_hash: 'deadbeef',
      label: 'ci',
      created_at: '2026-01-01T00:00:00.000Z',
    })
    const hit = await repo.findActiveTokenByHash('deadbeef')
    expect(hit?.actor.handle).toBe('hermes-1')
    await repo.touchToken('tok_1', '2026-01-02T00:00:00.000Z')
    expect((await repo.listTokensForActor('a_1'))[0]?.last_used_at).toBe('2026-01-02T00:00:00.000Z')

    await repo.revokeToken('tok_1', '2026-01-03T00:00:00.000Z')
    expect(await repo.findActiveTokenByHash('deadbeef')).toBeNull()
    expect((await repo.listTokensForActor('a_1'))[0]?.revoked_at).toBe('2026-01-03T00:00:00.000Z')
    await db.destroy()
  })

  it('findActorByTokenId resolves the owning actor; strips join bleed-through', async () => {
    const { db, repo } = await seed()
    await repo.insertToken({
      id: 'tok_1',
      actor_id: 'a_1',
      token_hash: 'deadbeef',
      label: 'ci',
      created_at: '2026-01-01T00:00:00.000Z',
    })
    const holder = await repo.findActorByTokenId('tok_1')
    // id must be the ACTOR's id even though tokens.id collides in the join
    expect(holder).toMatchObject({ id: 'a_1', kind: 'agent', handle: 'hermes-1' })
    expect(await repo.findActorByTokenId('tok_ghost')).toBeNull()
    await db.destroy()
  })

  it('findByOidcSubject: full row for a bound subject; null for unknown (Task 7, D-tt)', async () => {
    const { db, repo } = await seed() // the agent: oidc_subject NULL
    await db
      .insertInto('actors')
      .values({
        id: 'a_prov',
        kind: 'human',
        handle: 'prov',
        display_name: 'Provisioned',
        description: 'bound',
        created_at: '2026-01-02T00:00:00.000Z',
        role: 'member',
        oidc_subject: 'sub-bound',
      })
      .execute()
    // FULL row, no trim (the login path is not the token-lookup hot path)
    expect(await repo.findByOidcSubject('sub-bound')).toEqual({
      id: 'a_prov',
      kind: 'human',
      handle: 'prov',
      display_name: 'Provisioned',
      description: 'bound',
      created_at: '2026-01-02T00:00:00.000Z',
      role: 'member',
      oidc_subject: 'sub-bound',
    })
    expect(await repo.findByOidcSubject('sub-unknown')).toBeNull()
    // NULL subjects (agents, pre-E humans) never match — not even the empty string
    expect(await repo.findByOidcSubject('')).toBeNull()
    await db.destroy()
  })

  it('policy get/set with upsert', async () => {
    const { db, repo } = await seed()
    expect(await repo.getPolicy('review_gate')).toBe('on')
    await repo.setPolicy('review_gate', 'off')
    expect(await repo.getPolicy('review_gate')).toBe('off')
    expect(await repo.getPolicy('unknown_key')).toBeNull()
    await db.destroy()
  })
})
