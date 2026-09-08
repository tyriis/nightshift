import { makeDb } from '#root/infra/sqlite/db'
import { migrateToLatest } from '#root/infra/sqlite/migrations'
import type { Kysely } from 'kysely'
import type { DB, ThreadsTable } from '#root/infra/sqlite/schema'
import type { ActorKind, TaskDraft, TaskStatus } from '#root/domain/task'

export const freshDb = async (): Promise<Kysely<DB>> => {
  const db = makeDb(':memory:')
  await migrateToLatest(db)
  return db
}

export const seedActor = async (
  db: Kysely<DB>,
  id: string,
  kind: ActorKind = 'agent',
  handle?: string
): Promise<void> => {
  await db
    .insertInto('actors')
    .values({
      id,
      kind,
      handle: handle ?? `${kind}_${id}`,
      display_name: `Seed ${id}`,
      description: '',
      created_at: '2026-01-01T00:00:00.000Z',
    })
    .execute()
}

export const seedToken = async (
  db: Kysely<DB>,
  id: string,
  actorId: string,
  hash = `hash_${id}`
): Promise<void> => {
  await db
    .insertInto('tokens')
    .values({
      id,
      actor_id: actorId,
      token_hash: hash,
      label: 'test',
      created_at: '2026-01-01T00:00:00.000Z',
      last_used_at: null,
      revoked_at: null,
    })
    .execute()
}

export const seedTask = async (
  db: Kysely<DB>,
  id: string,
  patch: Partial<TaskDraft> & { title?: string } = {}
): Promise<string> => {
  await db
    .insertInto('tasks')
    .values({
      id,
      parent_id: patch.parent_id ?? null,
      title: patch.title ?? `Task ${id}`,
      description: patch.description ?? '',
      acceptance_criteria: patch.acceptance_criteria ?? '',
      status: patch.status ?? 'todo',
      blocked_flag: 0,
      assignee_id: null,
      position: patch.position ?? 1,
      created_by: patch.created_by ?? 'a_creator',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      claim_token_id: null,
      claim_generation: 0,
      last_heartbeat_at: null,
    })
    .execute()
  return id
}

export const setStatus = async (db: Kysely<DB>, id: string, status: TaskStatus): Promise<void> => {
  await db.updateTable('tasks').set({ status }).where('id', '=', id).execute()
}

export const seedThread = async (
  db: Kysely<DB>,
  id: string,
  taskId: string,
  kind: 'note' | 'question' = 'note',
  patch: Partial<Pick<ThreadsTable, 'state' | 'assignee_id' | 'created_by'>> = {}
): Promise<string> => {
  const assigneeId = kind === 'question' ? (patch.assignee_id ?? 'a_ag') : null
  if (assigneeId === 'a_ag' && patch.assignee_id === undefined) {
    // the default assignee must exist or the FK kills a plain seedThread(…, 'question')
    // call; idempotent on id so a test that already seeded a_ag is untouched
    await db
      .insertInto('actors')
      .values({
        id: 'a_ag',
        kind: 'agent',
        handle: 'seed_agent',
        display_name: 'Seed agent',
        description: '',
        created_at: '2026-01-01T00:00:00.000Z',
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute()
  }
  await db
    .insertInto('threads')
    .values({
      id,
      task_id: taskId,
      kind,
      state: kind === 'question' ? (patch.state ?? 'open') : null,
      assignee_id: assigneeId,
      answer_message_id: null,
      created_by: patch.created_by ?? 'a_creator',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    })
    .execute()
  return id
}

export const seedMessage = async (
  db: Kysely<DB>,
  id: string,
  threadId: string,
  seq: number,
  body: string
): Promise<string> => {
  await db
    .insertInto('messages')
    .values({
      id,
      thread_id: threadId,
      seq,
      author_id: 'a_creator',
      body,
      created_at: '2026-01-01T00:00:00.000Z',
    })
    .execute()
  return id
}
