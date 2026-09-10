// D-tt policy-flag arms. The review_gate on|off arms landed in manage-actors.test.ts
// (Plan A) and stay byte-untouched; this file owns the oidc_provisioning vocabulary —
// the plan's Files line says "manage-policy.test.ts extends"; the file is created here.
import { describe, expect, it } from 'vitest'
import { GetPolicy, SetPolicy } from '#root/application/usecases/manage-policy'
import { buildUow, fixedClock, human } from '#root/application/usecases/create-task.test'

describe('D-tt oidc_provisioning policy flag (fail-closed)', () => {
  it('seeded off; allowlist is the only enabling value; on is NOT a value for this key', async () => {
    const { db, uow } = await buildUow()
    const get = new GetPolicy(uow)
    expect(await get.run({ key: 'oidc_provisioning' })).toBe('off') // migration seed
    await new SetPolicy(uow, fixedClock()).run({
      ...human,
      key: 'oidc_provisioning',
      value: 'allowlist',
    })
    expect(await get.run({ key: 'oidc_provisioning' })).toBe('allowlist')
    await expect(
      new SetPolicy(uow, fixedClock()).run({ ...human, key: 'oidc_provisioning', value: 'on' })
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await db.destroy()
  })

  it('no silent semantic widening: review_gate STILL rejects allowlist (per-key gate, not the enum)', async () => {
    const { db, uow } = await buildUow()
    await expect(
      new SetPolicy(uow, fixedClock()).run({ ...human, key: 'review_gate', value: 'allowlist' })
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await db.destroy()
  })
})
