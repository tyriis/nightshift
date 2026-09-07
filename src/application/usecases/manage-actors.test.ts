import { describe, expect, it } from 'vitest'
import { CreateActor, CreateToken, RevokeToken } from '#root/application/usecases/manage-actors'
import { GetPolicy, SetPolicy } from '#root/application/usecases/manage-policy'
import { buildUow, fixedClock, human, seqIds } from '#root/application/usecases/create-task.test'
import { SqliteActorRepo } from '#root/infra/sqlite/actor-repo'
import { hashToken } from '#root/infra/token-hash'

describe('actor & token management', () => {
  it('creates agent, issues token shown once, auth lookup finds it, revoke kills it', async () => {
    const { db, uow } = await buildUow()
    const ids = seqIds() // one IdGen per test, shared across use-case constructions (M-1)
    const create = new CreateActor(uow, fixedClock(), ids)
    const agent = await create.run({
      ...human,
      kind: 'agent',
      handle: 'hermes-1',
      display_name: 'Hermes',
      description: 'coding agent',
    })
    expect(agent.kind).toBe('agent')
    await expect(
      create.run({ ...human, kind: 'agent', handle: 'hermes-1', display_name: 'dup' })
    ).rejects.toMatchObject({ code: 'handle_taken' })

    const issued = await new CreateToken(uow, fixedClock(), ids).run({
      ...human,
      actor_id: agent.id,
      label: 'ci',
    })
    expect(issued.raw_token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(issued.token.id).toMatch(/^tok_seq/)

    const actors = new SqliteActorRepo(db)
    const hit = await actors.findActiveTokenByHash(hashToken(issued.raw_token))
    expect(hit?.actor.handle).toBe('hermes-1')

    await new RevokeToken(uow, fixedClock()).run({ ...human, token_id: issued.token.id })
    expect(await actors.findActiveTokenByHash('whatever')).toBeNull()
    await expect(
      new RevokeToken(uow, fixedClock()).run({ ...human, token_id: 'tok_ghost' })
    ).rejects.toMatchObject({ code: 'not_found' })
    await db.destroy()
  })

  it('token issue against an unknown actor is not_found', async () => {
    const { db, uow } = await buildUow()
    await expect(
      new CreateToken(uow, fixedClock(), seqIds()).run({
        ...human,
        actor_id: 'a_ghost',
        label: 'ci',
      })
    ).rejects.toMatchObject({ code: 'not_found' })
    await db.destroy()
  })

  it('policy allowlist: only review_gate on|off', async () => {
    const { db, uow } = await buildUow()
    const get = new GetPolicy(uow)
    expect(await get.run({ key: 'review_gate' })).toBe('on')
    await new SetPolicy(uow, fixedClock()).run({ ...human, key: 'review_gate', value: 'off' })
    expect(await get.run({ key: 'review_gate' })).toBe('off')
    await expect(
      new SetPolicy(uow, fixedClock()).run({ ...human, key: 'evil', value: 'x' })
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(
      new SetPolicy(uow, fixedClock()).run({ ...human, key: 'review_gate', value: 'maybe' })
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(get.run({ key: 'evil' })).rejects.toMatchObject({ code: 'not_found' })
    await db.destroy()
  })
})
