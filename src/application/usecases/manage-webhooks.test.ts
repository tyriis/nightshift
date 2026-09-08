import { describe, expect, it } from 'vitest'
import type { Clock } from '#root/application/ports'
import { makeDb } from '#root/infra/sqlite/db'
import { migrateToLatest } from '#root/infra/sqlite/migrations'
import { SqliteUnitOfWork } from '#root/infra/sqlite/uow'
import { RandomIdGen } from '#root/infra/ids'
import { SqliteWebhookRepo } from '#root/infra/sqlite/webhook-repo'
import {
  CreateWebhook,
  DeleteWebhook,
  RotateWebhookSecret,
} from '#root/application/usecases/manage-webhooks'

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

describe('DeleteWebhook / RotateWebhookSecret (D-bb)', () => {
  it('delete removes the row and audits; ghost 404s (never 403, D-r doctrine)', async () => {
    const { db, uow } = await setup()
    const create = new CreateWebhook(uow, fixedClock(), new RandomIdGen())
    const { webhook } = await create.run({
      actor,
      tokenId: null,
      agent_id: 'a_g',
      url: 'http://x/del',
    })
    const del = new DeleteWebhook(uow, fixedClock())
    await expect(del.run({ actor, tokenId: null, webhook_id: 'wh_missing' })).rejects.toMatchObject(
      { code: 'not_found' }
    )
    await del.run({ actor, tokenId: null, webhook_id: webhook.id })
    expect(await db.selectFrom('webhooks').selectAll().execute()).toHaveLength(0)
    const audit = await db
      .selectFrom('audit_log')
      .select(['action', 'reason', 'after_json'])
      .orderBy('id')
      .execute()
    // FULL-SPINE pin (Task 7 precedent): warmup(1)+created(2)+own deleted(3); the ghost
    // 404 above audited nothing — D-r doctrine, not_found never masquerades, never 403
    expect(audit.map((a) => [a.action, a.reason])).toEqual([
      ['warmup', null],
      ['webhook_created', 'webhook created'],
      ['webhook_deleted', 'webhook deleted'], // grep-pinned forward
    ])
    expect(audit[2]?.after_json).toBe('{"url":"http://x/del"}') // url only, never the secret (D-ff)
    await db.destroy()
  })

  it('rotate mints a new secret, RE-ANCHORS the checkpoint and clears backoff, audits', async () => {
    const { db, uow } = await setup()
    const create = new CreateWebhook(uow, fixedClock(), new RandomIdGen())
    const first = await create.run({ actor, tokenId: null, agent_id: 'a_g', url: 'http://x/rot' })
    await uow.withTransaction(async (repos) =>
      repos.audit.append({
        actor_id: 'a_h',
        token_id: null,
        action: 'more',
        entity_type: 'task',
        entity_id: 't_w',
        created_at: '2026-01-02',
      })
    )
    await uow.withTransaction(async (repos) =>
      repos.webhooks.scheduleRetry(first.webhook.id, 4, 9_999_999)
    )
    const rotate = new RotateWebhookSecret(uow, fixedClock())
    const { webhook, secret } = await rotate.run({
      actor,
      tokenId: null,
      webhook_id: first.webhook.id,
    })
    expect(secret).not.toBe(first.secret)
    expect(webhook.delivered_cursor).toBe(4) // re-anchor is SELF-INCLUSIVE (D-bb, same rule as create): warmup(1)+created(2)+more(3)+own rotated(4)
    const repo = new SqliteWebhookRepo(db)
    const due = await repo.listDue(0) // parked until 9_999_999 before; re-anchor must clear it
    expect(due.map((w) => w.id)).toContain(webhook.id) // attempts/next_attempt reset by re-anchor
    const stored = await db.selectFrom('webhooks').select('secret').executeTakeFirst()
    expect(stored?.secret).toBe(secret)
    const audit = await db
      .selectFrom('audit_log')
      .select(['action', 'reason', 'after_json'])
      .orderBy('id')
      .execute()
    // FULL-SPINE pin (Task 7 precedent): warmup(1)+created(2)+more(3)+own rotated(4) —
    // exactly the spine the self-inclusive re-anchor above counted to 4
    expect(audit.map((a) => [a.action, a.reason])).toEqual([
      ['warmup', null],
      ['webhook_created', 'webhook created'],
      ['more', null],
      ['webhook_secret_rotated', 'webhook secret rotated'], // grep-pinned forward
    ])
    expect(audit[3]?.after_json).toBe('{"url":"http://x/rot"}') // url only, never the secret (D-ff)
    await expect(
      rotate.run({ actor, tokenId: null, webhook_id: 'wh_missing' })
    ).rejects.toMatchObject({ code: 'not_found' })
    await db.destroy()
  })

  it('rejected create (duplicate url) leaves NO audit row: the in-tx append rolls back (D-aa outbox invariant)', async () => {
    const { db, uow } = await setup()
    const create = new CreateWebhook(uow, fixedClock(), new RandomIdGen())
    await create.run({ actor, tokenId: null, agent_id: 'a_g', url: 'http://x/dup' })
    await expect(
      create.run({ actor, tokenId: null, agent_id: 'a_g', url: 'http://x/dup' })
    ).rejects.toMatchObject({ code: 'invalid_request' })
    const audit = await db
      .selectFrom('audit_log')
      .select(['action', 'reason'])
      .orderBy('id')
      .execute()
    // the loser's webhook_created rode in the rolled-back tx — spine unchanged
    expect(audit.map((a) => [a.action, a.reason])).toEqual([
      ['warmup', null],
      ['webhook_created', 'webhook created'],
    ])
    await db.destroy()
  })
})
