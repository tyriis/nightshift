import { describe, expect, it } from 'vitest'
import { CreateTask } from '#root/application/usecases/create-task'
import { ClaimTask } from '#root/application/usecases/claim-task'
import { GetNext } from '#root/application/usecases/get-next'
import { GetContext } from '#root/application/usecases/get-context'
import { buildUow, fixedClock, human, seqIds } from '#root/application/usecases/create-task.test'
import { SqliteTaskRepo } from '#root/infra/sqlite/task-repo'
import { SqliteDependencyRepo } from '#root/infra/sqlite/dependency-repo'
import { SqliteLabelRepo } from '#root/infra/sqlite/label-repo'
import { SqliteThreadRepo } from '#root/infra/sqlite/thread-repo'
import { SqliteLinkRepo } from '#root/infra/sqlite/link-repo'
import { SqliteAttachmentRepo } from '#root/infra/sqlite/attachment-repo'
import { seedActor, seedTask, seedThread, seedMessage, seedToken } from '#root/testing/fixtures'
import { AddBlock } from '#root/application/usecases/add-block'
import type { ActorContext } from '#root/application/ports'

const agent: ActorContext = {
  actor: { id: 'a_agent', kind: 'agent', handle: 'hermes-1', display_name: 'Hermes' },
  tokenId: 'tok_agent',
}

const setup = async () => {
  const { db, uow } = await buildUow()
  await seedActor(db, 'a_agent', 'agent', 'hermes-1')
  await seedToken(db, 'tok_agent', 'a_agent')
  const repos = {
    tasks: new SqliteTaskRepo(db),
    deps: new SqliteDependencyRepo(db),
    labels: new SqliteLabelRepo(db),
  }
  return { db, uow, repos }
}

describe('GetNext (spec §7.2 ready-work query)', () => {
  it('returns only ready leaves, ordered by position, label-filterable, limit respected', async () => {
    const { db, uow, repos } = await setup()
    const create = new CreateTask(uow, fixedClock(), seqIds())
    // oracle ruling A: spec §6.3 has NO parent gate — a todo leaf under a live todo
    // parent IS ready. Parent created first so positions are deterministic:
    // roots p=1, a=2, b=3, c=4(backlog); p1 = position 1 under p. Ready order: [p1, a, b].
    const parent = await create.run({ ...human, title: 'p', status: 'todo' })
    const a = await create.run({ ...human, title: 'a', status: 'todo', labels: ['infra'] })
    const b = await create.run({ ...human, title: 'b', status: 'todo', labels: ['ui'] })
    const backlog = await create.run({ ...human, title: 'c' })
    const p1 = await create.run({ ...human, title: 'p1', parent_id: parent.id, status: 'todo' })

    const next = new GetNext(repos.tasks)
    expect((await next.run({})).map((t) => t.task.id)).toEqual([p1.id, a.id, b.id])
    expect((await next.run({ label: 'ui' })).map((t) => t.task.id)).toEqual([b.id])
    expect((await next.run({ limit: 1 })).map((t) => t.task.id)).toEqual([p1.id])

    // claiming removes it from ready
    await new ClaimTask(uow, fixedClock(), seqIds()).run({ ...agent, taskId: a.id })
    expect((await next.run({})).map((t) => t.task.id)).toEqual([p1.id, b.id])
    void backlog
    void parent
    await db.destroy()
  })
})

describe('GetContext (spec §7.2 one-call bundle)', () => {
  it('bundles task + ancestors + unmet blockers + labels, with Plan B/C seams empty', async () => {
    const { db, uow, repos } = await setup()
    const create = new CreateTask(uow, fixedClock(), seqIds())
    const root = await create.run({ ...human, title: 'root', acceptance_criteria: 'ROOT-AC' })
    const mid = await create.run({ ...human, title: 'mid', parent_id: root.id, status: 'todo' })
    const leaf = await create.run({
      ...human,
      title: 'leaf',
      parent_id: mid.id,
      status: 'todo',
      labels: ['infra'],
      acceptance_criteria: 'LEAF-AC',
    })
    const blocker = await create.run({ ...human, title: 'blocker', status: 'in_progress' })
    await new AddBlock(uow, fixedClock()).run({ ...human, taskId: leaf.id, blocker_id: blocker.id })

    const bundle = await new GetContext(
      repos.tasks,
      repos.deps,
      repos.labels,
      new SqliteThreadRepo(db),
      new SqliteLinkRepo(db),
      new SqliteAttachmentRepo(db)
    ).run({
      taskId: leaf.id,
    })
    expect(bundle.task.acceptance_criteria).toBe('LEAF-AC')
    expect(bundle.ancestors.map((a) => a.title)).toEqual(['root', 'mid'])
    expect(bundle.ancestors[0]?.acceptance_criteria).toBe('ROOT-AC')
    expect(bundle.blockers.map((b) => b.id)).toEqual([blocker.id])
    expect(bundle.labels.map((l) => l.name)).toEqual(['infra'])
    expect(bundle.unmet_blockers).toBe(1)
    // seams: empty here — this task has no threads/links/files (the populated case is the next test)
    expect(bundle.open_questions).toEqual([])
    expect(bundle.links).toEqual([])
    expect(bundle.attachments).toEqual([])
    await db.destroy()
  })

  it('fills the Plan B seams: open questions, links, attachments (spec §7.2)', async () => {
    const { db } = await setup()
    // seedTask/seedThread/seedMessage fixtures default created_by/author to a_creator (FK target)
    await seedActor(db, 'a_creator', 'human')
    await seedTask(db, 't_b')
    await seedThread(db, 'th_q', 't_b', 'question', { assignee_id: 'a_agent' })
    await seedMessage(db, 'ms_q', 'th_q', 1, 'which db?')
    await new SqliteLinkRepo(db).add({
      id: 'lk_1',
      task_id: 't_b',
      kind: 'pr',
      url: 'https://example/pr/1',
      created_by: 'a_agent',
      created_at: '2026-01-01T00:00:00.000Z',
    })
    await new SqliteAttachmentRepo(db).add({
      id: 'at_1',
      task_id: 't_b',
      filename: 'spec.md',
      content_type: 'text/markdown',
      sha256: 'aa'.repeat(32),
      bytes: 12,
      created_by: 'a_agent',
      created_at: '2026-01-01T00:00:00.000Z',
    })
    const bundle = await new GetContext(
      new SqliteTaskRepo(db),
      new SqliteDependencyRepo(db),
      new SqliteLabelRepo(db),
      new SqliteThreadRepo(db),
      new SqliteLinkRepo(db),
      new SqliteAttachmentRepo(db)
    ).run({ taskId: 't_b' })
    expect(bundle.open_questions).toEqual([
      { id: 'th_q', state: 'open', assignee_handle: 'hermes-1', question: 'which db?' },
    ])
    expect(bundle.links).toHaveLength(1)
    expect(bundle.links[0]).toMatchObject({ kind: 'pr', url: 'https://example/pr/1' })
    expect(bundle.attachments[0]).toMatchObject({ filename: 'spec.md', bytes: 12 })
    await db.destroy()
  })

  it('unknown task → not_found', async () => {
    const { db, repos } = await setup()
    await expect(
      new GetContext(
        repos.tasks,
        repos.deps,
        repos.labels,
        new SqliteThreadRepo(db),
        new SqliteLinkRepo(db),
        new SqliteAttachmentRepo(db)
      ).run({ taskId: 't_ghost' })
    ).rejects.toMatchObject({ code: 'not_found' })
    await db.destroy()
  })
})
