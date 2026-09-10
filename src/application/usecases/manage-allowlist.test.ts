import { describe, expect, it } from 'vitest'
import {
  AddAllowlist,
  ListAllowlist,
  RemoveAllowlist,
} from '#root/application/usecases/manage-allowlist'
import { buildUow, fixedClock, human } from '#root/application/usecases/create-task.test'
import type { AuditRow, UnitOfWork } from '#root/application/ports'

const NOW = '2026-05-05T05:05:05.000Z' // fixedClock()

// audit is the one spine (D-aa): tail is ascending, freshDb audits nothing before this
const auditTail = (uow: UnitOfWork): Promise<AuditRow[]> =>
  uow.withTransaction((repos) => repos.audit.tail(0, 500))

describe('AddAllowlist (D-tt)', () => {
  it('email rule: invalid => invalid_request with the pinned detail; stored LOWERCASED (trim too)', async () => {
    const { db, uow } = await buildUow()
    const add = new AddAllowlist(uow, fixedClock())
    await expect(add.run({ ...human, email: 'not-an-email' })).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'invalid email (D-tt)',
    })
    // no dot in the domain — the use-case rule, same language as the route schema pattern
    await expect(add.run({ ...human, email: 'a@b' })).rejects.toMatchObject({
      code: 'invalid_request',
    })
    const res = await add.run({ ...human, email: '  Alice@Example.COM  ' })
    expect(res).toEqual({
      created: true,
      row: { email: 'alice@example.com', added_by: 'a_human', created_at: NOW },
    })
    await db.destroy()
  })

  it('duplicate add => {created:false} + the existing row; NO second audit (tail length proves it)', async () => {
    const { db, uow } = await buildUow()
    const add = new AddAllowlist(uow, fixedClock())
    const first = await add.run({ ...human, email: 'Alice@Example.COM' })
    const second = await add.run({ ...human, email: 'ALICE@EXAMPLE.com' }) // pin both sides
    expect(second.created).toBe(false)
    expect(second.row).toEqual(first.row)
    const rows = await new ListAllowlist(uow).run({ ...human })
    expect(rows).toEqual([first.row]) // exactly one row in the store
    const added = (await auditTail(uow)).filter((r) => r.action === 'allowlist_added')
    expect(added).toHaveLength(1) // the audit append count is the proof
    await db.destroy()
  })

  it('audits allowlist_added: actor = the admin ctx, entity the email, after {email}', async () => {
    const { db, uow } = await buildUow()
    await new AddAllowlist(uow, fixedClock()).run({ ...human, email: 'alice@example.com' })
    const [added] = (await auditTail(uow)).filter((r) => r.action === 'allowlist_added')
    expect(added).toMatchObject({
      actor_id: 'a_human',
      token_id: null,
      action: 'allowlist_added',
      entity_type: 'allowlist',
      entity_id: 'alice@example.com',
      after: { email: 'alice@example.com' },
      reason: 'allow-list entry added',
      created_at: NOW,
    })
    await db.destroy()
  })
})

describe('RemoveAllowlist (D-tt)', () => {
  it('remove-missing => not_found, detail VERBATIM (ghost-404 doctrine)', async () => {
    const { db, uow } = await buildUow()
    await expect(
      new RemoveAllowlist(uow, fixedClock()).run({ ...human, email: 'ghost@x.example' })
    ).rejects.toMatchObject({
      code: 'not_found',
      message: "allow-list entry 'ghost@x.example' not found",
    })
    expect((await auditTail(uow)).filter((r) => r.action === 'allowlist_removed')).toHaveLength(0)
    await db.destroy()
  })

  it('removes (lowercase applies before lookup) and audits allowlist_removed with after {email}', async () => {
    const { db, uow } = await buildUow()
    await new AddAllowlist(uow, fixedClock()).run({ ...human, email: 'alice@example.com' })
    await new RemoveAllowlist(uow, fixedClock()).run({ ...human, email: 'ALICE@Example.COM' })
    expect(await new ListAllowlist(uow).run({ ...human })).toEqual([])
    const [removed] = (await auditTail(uow)).filter((r) => r.action === 'allowlist_removed')
    expect(removed).toMatchObject({
      actor_id: 'a_human',
      token_id: null,
      action: 'allowlist_removed',
      entity_type: 'allowlist',
      entity_id: 'alice@example.com', // the normalized email is the spine's entity id
      after: { email: 'alice@example.com' },
      reason: 'allow-list entry removed',
      created_at: NOW,
    })
    await db.destroy()
  })
})
