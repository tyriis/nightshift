import { sql, type Kysely } from 'kysely'
import type {
  MessageRecord,
  OpenQuestionRow,
  ThreadDraft,
  ThreadRecord,
  ThreadRepo,
  ThreadWithMessages,
} from '#root/application/ports'
import type { QuestionState } from '#root/domain/discussion'
import type { DB, MessagesTable, ThreadsTable } from '#root/infra/sqlite/schema'

const toThread = (r: ThreadsTable): ThreadRecord => ({
  id: r.id,
  task_id: r.task_id,
  kind: r.kind,
  state: r.state,
  assignee_id: r.assignee_id,
  answer_message_id: r.answer_message_id,
  created_by: r.created_by,
  created_at: r.created_at,
  updated_at: r.updated_at,
})

const toMessage = (r: MessagesTable): MessageRecord => ({
  id: r.id,
  thread_id: r.thread_id,
  seq: r.seq,
  author_id: r.author_id,
  body: r.body,
  created_at: r.created_at,
})

export class SqliteThreadRepo implements ThreadRepo {
  constructor(private readonly db: Kysely<DB>) {}

  async create(draft: ThreadDraft): Promise<ThreadRecord> {
    const row = await this.db
      .insertInto('threads')
      .values(draft)
      .returningAll()
      .executeTakeFirstOrThrow()
    return toThread(row)
  }

  async find(id: string): Promise<ThreadRecord | null> {
    const r = await this.db
      .selectFrom('threads')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    return r ? toThread(r) : null
  }

  async listForTask(taskId: string): Promise<ThreadWithMessages[]> {
    const threads = await this.db
      .selectFrom('threads')
      .selectAll()
      .where('task_id', '=', taskId)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute()
    if (threads.length === 0) return []
    const messages = await this.db
      .selectFrom('messages')
      .selectAll()
      .where(
        'thread_id',
        'in',
        threads.map((t) => t.id)
      )
      .orderBy('seq', 'asc')
      .execute()
    const grouped = new Map<string, MessageRecord[]>()
    for (const m of messages) {
      const list = grouped.get(m.thread_id) ?? []
      list.push(toMessage(m))
      grouped.set(m.thread_id, list)
    }
    return threads.map((t) => ({ thread: toThread(t), messages: grouped.get(t.id) ?? [] }))
  }

  async appendMessage(input: {
    id: string
    threadId: string
    authorId: string
    body: string
    created_at: string
  }): Promise<MessageRecord> {
    // D-y: seq computed here (max+1 under the caller's transaction) — clock-free ordering
    const r = await sql<{ next: number }>`
      select coalesce(max(seq), 0) + 1 as next from messages where thread_id = ${input.threadId}
    `.execute(this.db)
    const seq = Number(r.rows[0]?.next ?? 1)
    const row = await this.db
      .insertInto('messages')
      .values({
        id: input.id,
        thread_id: input.threadId,
        seq,
        author_id: input.authorId,
        body: input.body,
        created_at: input.created_at,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return toMessage(row)
  }

  async setQuestionFields(
    threadId: string,
    patch: { state?: QuestionState; assignee_id?: string; answer_message_id?: string },
    updated_at: string
  ): Promise<void> {
    const values: Partial<ThreadsTable> = { updated_at }
    if (patch.state !== undefined) values.state = patch.state
    if (patch.assignee_id !== undefined) values.assignee_id = patch.assignee_id
    if (patch.answer_message_id !== undefined) values.answer_message_id = patch.answer_message_id
    await this.db.updateTable('threads').set(values).where('id', '=', threadId).execute()
  }

  async openHumanAssigned(taskId: string): Promise<number> {
    // Invariant 6 (spec §6.4.6, D-o): open question whose assignee is a human actor.
    const r = await sql<{ n: number }>`
      select count(*) as n from threads t
        join actors a on a.id = t.assignee_id
       where t.task_id = ${taskId} and t.kind = 'question'
         and t.state = 'open' and a.kind = 'human'
    `.execute(this.db)
    return Number(r.rows[0]?.n ?? 0)
  }

  async openQuestionsForTask(taskId: string): Promise<OpenQuestionRow[]> {
    const r = await sql<Omit<OpenQuestionRow, 'state'> & { state: string }>`
      select t.id, t.state, a.handle as assignee_handle,
        coalesce((select m.body from messages m
                   where m.thread_id = t.id order by m.seq limit 1), '') as question
        from threads t
        join actors a on a.id = t.assignee_id
       where t.task_id = ${taskId} and t.kind = 'question' and t.state = 'open'
       order by t.created_at, t.id
    `.execute(this.db)
    return r.rows.map((row) => ({ ...row, state: row.state as QuestionState }))
  }
}
