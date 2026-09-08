import { describe, expect, it } from 'vitest'
import type { Clock } from '#root/application/ports'
import { makeDb } from '#root/infra/sqlite/db'
import { migrateToLatest } from '#root/infra/sqlite/migrations'
import { SqliteUnitOfWork } from '#root/infra/sqlite/uow'
import { RandomIdGen } from '#root/infra/ids'
import { CreateWebhook } from '#root/application/usecases/manage-webhooks'

const fixedClock = (): Clock => ({ now: () => new Date('2026-05-05T05:05:05.000Z') })

const setup = async () => {
  const db = makeDb(':memory:')
  await migrateToLatest(db)
  // a_h human actor, audit watermark baseline: one audited action (done via direct
  // audit append — the use-case under test reads repos.audit.watermark inside its tx)
  await db
    .insertInto('actors')
    .values([
      {
        id: 'a_h',
        kind: 'human',
        handle: 'h',
        display_name: 'H',
        description: '',
        created_at: '2026-01-01',
      },
      {
        id: 'a_g',
        kind: 'agent',
        handle: 'g',
        display_name: 'G',
        description: '',
        created_at: '2026-01-01',
      },
      {
        id: 'a_h2',
        kind: 'human',
        handle: 'h2',
        display_name: 'H2',
        description: '',
        created_at: '2026-01-01',
      },
    ])
    .execute()
  const uow = new SqliteUnitOfWork(db)
  await uow.withTransaction(async (repos) =>
    repos.audit.append({
      actor_id: 'a_h',
      token_id: null,
      action: 'warmup',
      entity_type: 'task',
      entity_id: 't_w',
      created_at: '2026-01-01',
    })
  )
  return { db, uow }
}
const actor = { id: 'a_h', kind: 'human' as const, handle: 'h', display_name: 'H' }

describe('CreateWebhook (D-bb/D-ff)', () => {
  it('registers an agent callback: secret minted once, checkpoint at the watermark, audit pinned', async () => {
    const { db, uow } = await setup()
    const uc = new CreateWebhook(uow, fixedClock(), new RandomIdGen())
    const { webhook, secret } = await uc.run({
      actor,
      tokenId: null,
      agent_id: 'a_g',
      url: 'http://runner.example/cb',
    })
    expect(webhook.id).toMatch(/^wh_[a-z0-9]{16}$/) // D-z family
    expect(webhook.delivered_cursor).toBe(2) // warmup(1) + own webhook_created(2): the anchor is self-inclusive — a runner is never woken for its own registration (D-bb)
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/) // 32 bytes base64url
    const rows = await db.selectFrom('webhooks').selectAll().execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.secret).toBe(secret) // plaintext at rest, by D-ff — pin the choice
    const audit = await db
      .selectFrom('audit_log')
      .select(['action', 'reason', 'after_json'])
      .execute()
    // the warmup row is part of the spine (it is what the checkpoint counts) — pin the
    // whole spine: exactly one row added by the use-case, with its grep-pinned reason
    expect(audit.map((a) => [a.action, a.reason])).toEqual([
      ['warmup', null],
      ['webhook_created', 'webhook created'],
    ])
    expect(audit[1]?.after_json).not.toContain(secret) // never audited (D-ff)
    await db.destroy()
  })

  it('rejects: unknown actor 404-ish, human target, bad/short/non-http url, duplicate url', async () => {
    const { db, uow } = await setup()
    const uc = new CreateWebhook(uow, fixedClock(), new RandomIdGen())
    const mk = (o: { agent_id: string; url: string }) =>
      uc.run({ actor, tokenId: null, ...o }).catch((e) => e)
    expect((await mk({ agent_id: 'a_no', url: 'http://x/cb' })).code).toBe('not_found')
    expect((await mk({ agent_id: 'a_h2', url: 'http://x/cb2' })).code).toBe('invalid_request')
    expect((await mk({ agent_id: 'a_g', url: 'not a url' })).code).toBe('invalid_request')
    expect((await mk({ agent_id: 'a_g', url: 'ftp://x/cb' })).code).toBe('invalid_request')
    await uc.run({ actor, tokenId: null, agent_id: 'a_g', url: 'http://x/cb3' })
    expect((await mk({ agent_id: 'a_g', url: 'http://x/cb3' })).code).toBe('invalid_request')
    await db.destroy()
  })
})
