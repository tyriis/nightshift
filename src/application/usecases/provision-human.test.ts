// D-tt first-login provisioning: the handle-derivation algorithm is PINNED here
// (review note (b): D-q grammar [A-Za-z0-9][A-Za-z0-9_-]* with lowercase
// normalization — Task 7's sanitize governs). Source preference:
// preferred_username → email local-part → subject.
import { describe, expect, it } from 'vitest'
import { ProvisionHumanFromOidc } from '#root/application/usecases/provision-human'
import { buildUow, fixedClock, seqIds } from '#root/application/usecases/create-task.test'
import type { ActorRow, AuditRow, UnitOfWork } from '#root/application/ports'

const NOW = '2026-05-05T05:05:05.000Z' // fixedClock()

const auditTail = (uow: UnitOfWork): Promise<AuditRow[]> =>
  uow.withTransaction((repos) => repos.audit.tail(0, 500))

const provisionedRow = async (
  db: Awaited<ReturnType<typeof buildUow>>['db'],
  sub: string
): Promise<ActorRow | undefined> =>
  (await db.selectFrom('actors').selectAll().where('oidc_subject', '=', sub).execute())[0]

describe('ProvisionHumanFromOidc (D-tt): the pinned handle algorithm', () => {
  it("'Alice.Smith' => 'alicesmith'; 'ünïcode ✓ user' => byte-exact stripped result", async () => {
    const { db, uow } = await buildUow()
    const uc = new ProvisionHumanFromOidc(uow, fixedClock(), seqIds())
    const dotted = await uc.run({ sub: 'sub-dotted', preferred_username: 'Alice.Smith' })
    expect(dotted.handle).toBe('alicesmith')
    // byte-exact: ü and ï (and the spaces + ✓) are outside [a-z0-9_-] and strip —
    // the plan's 'nicode user'-class prose example, pinned as the algorithm's real output
    const uni = await uc.run({ sub: 'sub-uni', preferred_username: 'ünïcode ✓ user' })
    expect(uni.handle).toBe('ncodeuser')
    await db.destroy()
  })

  it('source preference: username → email local-part → subject; leading non-alnum stripped; empty => user; 60-cap', async () => {
    const { db, uow } = await buildUow()
    const uc = new ProvisionHumanFromOidc(uow, fixedClock(), seqIds())
    // email local-part (username absent)
    expect((await uc.run({ sub: 'sub-e', email: 'Bob.Jones@example.test' })).handle).toBe(
      'bobjones'
    )
    // subject (username AND email absent)
    expect((await uc.run({ sub: 'Sub.MIXED_9' })).handle).toBe('submixed_9')
    // leading chars stripped until alphanumeric (D-q grammar head class)
    expect((await uc.run({ sub: 'sub-d', preferred_username: '__-Dash' })).handle).toBe('dash')
    // everything stripped => 'user'
    expect((await uc.run({ sub: 'sub-x', preferred_username: '✓ ✓' })).handle).toBe('user')
    // slice(0, 60)
    expect((await uc.run({ sub: 'sub-long', preferred_username: 'a'.repeat(70) })).handle).toBe(
      'a'.repeat(60)
    )
    await db.destroy()
  })

  it('collisions append -2, -3 (base taken first; a second collision takes -3)', async () => {
    const { db, uow } = await buildUow()
    const uc = new ProvisionHumanFromOidc(uow, fixedClock(), seqIds())
    await uc.run({ sub: 's1', preferred_username: 'alice' }) // 'alice'
    expect((await uc.run({ sub: 's2', preferred_username: 'Alice' })).handle).toBe('alice-2')
    expect((await uc.run({ sub: 's3', preferred_username: '@alice@' })).handle).toBe('alice-3')
    await db.destroy()
  })

  it('exhaustion (base + -2..-20 seeded) => invalid_request, pinned detail', async () => {
    const { db, uow } = await buildUow()
    const uc = new ProvisionHumanFromOidc(uow, fixedClock(), seqIds())
    const taken = ['alice', ...Array.from({ length: 19 }, (_, i) => `alice-${i + 2}`)]
    for (const handle of taken) {
      await db
        .insertInto('actors')
        .values({
          id: `a_space_${handle}`,
          kind: 'human',
          handle,
          display_name: handle,
          description: '',
          created_at: NOW,
          role: 'member',
        })
        .execute()
    }
    await expect(uc.run({ sub: 'sub-full', preferred_username: 'alice' })).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'handle space exhausted (D-tt)',
    })
    await db.destroy()
  })

  it('race guard: subject already bound inside the tx => the row is returned, ZERO create/audit', async () => {
    const { db, uow } = await buildUow()
    const uc = new ProvisionHumanFromOidc(uow, fixedClock(), seqIds())
    const first = await uc.run({ sub: 'sub-race', preferred_username: 'alice' })
    const before = await auditTail(uow)
    // the double-callback world: same sub arrives again (route pre-check lost a race)
    const again = await uc.run({ sub: 'sub-race', preferred_username: 'alice' })
    expect(again).toEqual(first)
    const actors = await db
      .selectFrom('actors')
      .selectAll()
      .where('oidc_subject', '=', 'sub-race')
      .execute()
    expect(actors).toHaveLength(1)
    const after = await auditTail(uow)
    expect(after.length).toBe(before.length) // the audit append count is the proof
    await db.destroy()
  })

  it('audits human_provisioned + the row: kind human, role member, oidc_subject bound, description empty', async () => {
    const { db, uow } = await buildUow()
    const uc = new ProvisionHumanFromOidc(uow, fixedClock(), seqIds())
    const actor = await uc.run({
      sub: 'stub-alice',
      email: 'alice@example.test',
      preferred_username: 'alice',
    })
    const row = await provisionedRow(db, 'stub-alice')
    expect(row).toMatchObject({
      id: actor.id,
      kind: 'human',
      role: 'member',
      handle: 'alice',
      display_name: 'alice', // display_name rides the handle (pinned — nothing hidden)
      description: '',
      oidc_subject: 'stub-alice',
      created_at: NOW,
    })
    const [audit] = (await auditTail(uow)).filter((r) => r.action === 'human_provisioned')
    expect(audit).toMatchObject({
      actor_id: actor.id, // the spine attributes the event to the provisioned actor
      token_id: null,
      action: 'human_provisioned',
      entity_type: 'actor',
      entity_id: actor.id,
      after: { handle: 'alice', subject: 'stub-alice', role: 'member' }, // #23: role rides `after`
      reason: 'oidc first-login allow-list',
      created_at: NOW,
    })
    await db.destroy()
  })
})

// issue #23: NS_ADMIN_EMAILS decides the provisioned role (the list is echoed into the
// use-case by the composition root — the ClaimTask D-nnn config-echo precedent, so the
// 4th ctor arg is the array and its absence is the [] dormant posture).
describe('ProvisionHumanFromOidc (issue #23): the NS_ADMIN_EMAILS role matrix', () => {
  it('listed email => admin (row, returned actor and the audit `after`)', async () => {
    const { db, uow } = await buildUow()
    const uc = new ProvisionHumanFromOidc(uow, fixedClock(), seqIds(), [
      'alice@example.test',
      'other@example.test',
    ])
    const actor = await uc.run({ sub: 's-admin', email: 'alice@example.test' })
    expect(actor.role).toBe('admin')
    expect((await provisionedRow(db, 's-admin'))?.role).toBe('admin')
    const [audit] = (await auditTail(uow)).filter((r) => r.action === 'human_provisioned')
    expect(audit).toMatchObject({
      action: 'human_provisioned',
      entity_id: actor.id,
      after: { handle: 'alice', subject: 's-admin', role: 'admin' },
      reason: 'oidc first-login allow-list',
    })
    await db.destroy()
  })

  it('unlisted email => member; matching is trim + lowercase on both sides', async () => {
    const { db, uow } = await buildUow()
    const uc = new ProvisionHumanFromOidc(uow, fixedClock(), seqIds(), ['Alice@Example.test'])
    expect((await uc.run({ sub: 's-miss', email: 'bob@example.test' })).role).toBe('member')
    // the case/space-insensitive meet (the allow-list doctrine): claim ' ALICE@example.test '
    expect((await uc.run({ sub: 's-hit', email: ' ALICE@example.test ' })).role).toBe('admin')
    // no email claim at all => member, never a crash
    expect((await uc.run({ sub: 's-noemail', preferred_username: 'x' })).role).toBe('member')
    await db.destroy()
  })

  it('NS_ADMIN_EMAILS unset (3-arg construction, [] default) => every human is member', async () => {
    const { db, uow } = await buildUow()
    const uc = new ProvisionHumanFromOidc(uow, fixedClock(), seqIds())
    expect((await uc.run({ sub: 's-dormant', email: 'alice@example.test' })).role).toBe('member')
    await db.destroy()
  })

  it('the race guard stays role-blind: the bound row wins, no second audit', async () => {
    const { db, uow } = await buildUow()
    const uc = new ProvisionHumanFromOidc(uow, fixedClock(), seqIds(), ['alice@example.test'])
    const first = await uc.run({ sub: 's-r2', email: 'alice@example.test' })
    const before = await auditTail(uow)
    const again = await uc.run({ sub: 's-r2', email: 'alice@example.test' })
    expect(again).toEqual(first)
    expect((await auditTail(uow)).length).toBe(before.length)
    await db.destroy()
  })
})
