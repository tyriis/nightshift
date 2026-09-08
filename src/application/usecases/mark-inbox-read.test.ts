import { describe, expect, it } from 'vitest'
import { CreateTask } from '#root/application/usecases/create-task'
import { CreateThread } from '#root/application/usecases/create-thread'
import { MarkInboxRead } from '#root/application/usecases/mark-inbox-read'
import { SqliteInboxRepo } from '#root/infra/sqlite/inbox-repo'
import { buildUow, fixedClock, human, seqIds } from '#root/application/usecases/create-task.test'
import { seedActor } from '#root/testing/fixtures'
import type { ActorContext } from '#root/application/ports'

const ana: ActorContext = {
  actor: { id: 'a_ana', kind: 'human', handle: 'ana', display_name: 'Ana' },
  tokenId: null,
}

// nils mentions ana → ana owns one inbox item; returns the item id.
const setup = async () => {
  const { db, uow } = await buildUow() // seeds a_human (nils)
  await seedActor(db, 'a_ana', 'human', 'ana')
  const ids = seqIds()
  const task = await new CreateTask(uow, fixedClock(), ids).run({ ...human, title: 'x' })
  await new CreateThread(uow, fixedClock(), ids).run({
    ...human,
    taskId: task.id,
    kind: 'note',
    body: '@ana ping',
  })
  const inbox = new SqliteInboxRepo(db)
  const items = await inbox.listForActor('a_ana', { unreadOnly: false, limit: 5 })
  return { db, uow, inbox, itemId: items[0]!.id }
}

describe('MarkInboxRead (spec §6.8, D-r)', () => {
  it('owner marks the item read', async () => {
    const { db, uow, inbox, itemId } = await setup()
    await new MarkInboxRead(uow).run({ ...ana, itemId })
    const [item] = await inbox.listForActor('a_ana', { unreadOnly: false, limit: 5 })
    expect(item!.read).toBe(true)
    expect(await inbox.listForActor('a_ana', { unreadOnly: true, limit: 5 })).toEqual([])
    await db.destroy()
  })

  it('foreign actor and unknown id both fail not_found — never 403, no existence leak (D-r)', async () => {
    const { db, uow, itemId } = await setup()
    const uc = new MarkInboxRead(uow)
    await expect(uc.run({ ...human, itemId })).rejects.toMatchObject({ code: 'not_found' })
    await expect(uc.run({ ...ana, itemId: 'ib_ghost' })).rejects.toMatchObject({
      code: 'not_found',
    })
    await db.destroy()
  })

  it('marking twice is idempotent for the owner', async () => {
    const { db, uow, itemId } = await setup()
    const uc = new MarkInboxRead(uow)
    await uc.run({ ...ana, itemId })
    await expect(uc.run({ ...ana, itemId })).resolves.toBeUndefined()
    await db.destroy()
  })
})
