import { sql, type Kysely, type RawBuilder, type SqlBool } from 'kysely'
import type { TaskDraft, TaskRecord, TaskStatus } from '#root/domain/task'
import type { TaskPatch, TaskRepo, TaskWithCounts } from '#root/application/ports'
import type { DB, TasksTable } from '#root/infra/sqlite/schema'

type TaskRow = TasksTable

const toRecord = (r: TaskRow): TaskRecord => ({
  id: r.id,
  parent_id: r.parent_id,
  title: r.title,
  description: r.description,
  acceptance_criteria: r.acceptance_criteria,
  status: r.status,
  blocked_flag: r.blocked_flag === 1,
  assignee_id: r.assignee_id,
  position: r.position,
  created_by: r.created_by,
  created_at: r.created_at,
  updated_at: r.updated_at,
  claim_token_id: r.claim_token_id,
  claim_generation: r.claim_generation,
  last_heartbeat_at: r.last_heartbeat_at,
})

const childCount = sql<number>`
  (select count(*) from tasks c where c.parent_id = tasks.id)`

const unmetBlockers = sql<number>`
  (select count(*) from dependencies d
     join tasks b on b.id = d.blocker_id
    where d.blocked_id = tasks.id and b.status != 'done')`

const isLeaf = sql<SqlBool>`
  not exists (select 1 from tasks c where c.parent_id = tasks.id)`

const noUnmetBlockers = sql<SqlBool>`
  not exists (select 1 from dependencies d
                join tasks b on b.id = d.blocker_id
               where d.blocked_id = tasks.id and b.status != 'done')`

const hasLabel = (label: string): RawBuilder<SqlBool> => sql<SqlBool>`
  exists (select 1 from task_labels tl
            join labels l on l.id = tl.label_id
           where tl.task_id = tasks.id and l.name = ${label})`

export class SqliteTaskRepo implements TaskRepo {
  constructor(private readonly db: Kysely<DB>) {}

  // Task 9 Step 0 (review R3/B12): label NAMES ride TaskWithCounts so the board
  // DTO carries them with NO per-card GET. ONE batched query per response —
  // the empty-id guard is load-bearing: `in ()` is invalid SQL.
  private async labelsFor(taskIds: string[]): Promise<Map<string, string[]>> {
    if (taskIds.length === 0) return new Map()
    const rows = await this.db
      .selectFrom('task_labels')
      .innerJoin('labels', 'labels.id', 'task_labels.label_id')
      .select(['task_labels.task_id as task_id', 'labels.name as name'])
      .where('task_labels.task_id', 'in', taskIds)
      .orderBy('labels.name', 'asc')
      .execute()
    const out = new Map<string, string[]>()
    for (const r of rows) {
      const list = out.get(r.task_id) ?? []
      list.push(r.name)
      out.set(r.task_id, list)
    }
    return out
  }

  async create(draft: TaskDraft): Promise<TaskRecord> {
    const row = await this.db
      .insertInto('tasks')
      .values({
        id: draft.id,
        parent_id: draft.parent_id,
        title: draft.title,
        description: draft.description,
        acceptance_criteria: draft.acceptance_criteria,
        status: draft.status,
        blocked_flag: 0,
        assignee_id: null,
        position: draft.position,
        created_by: draft.created_by,
        created_at: draft.created_at,
        updated_at: draft.updated_at,
        claim_token_id: null,
        claim_generation: 0,
        last_heartbeat_at: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return toRecord(row)
  }

  async findById(id: string): Promise<TaskRecord | null> {
    const r = await this.db.selectFrom('tasks').selectAll().where('id', '=', id).executeTakeFirst()
    return r ? toRecord(r) : null
  }

  async findWithCounts(id: string): Promise<TaskWithCounts | null> {
    const r = await this.db
      .selectFrom('tasks')
      .selectAll('tasks')
      .select(childCount.as('child_count'))
      .select(unmetBlockers.as('unmet_blockers'))
      .where('id', '=', id)
      .executeTakeFirst()
    if (!r) return null
    const labels = await this.labelsFor([r.id])
    return {
      task: toRecord(r),
      child_count: Number(r.child_count),
      unmet_blockers: Number(r.unmet_blockers),
      labels: labels.get(r.id) ?? [],
    }
  }

  async listAllWithCounts(): Promise<TaskWithCounts[]> {
    const rows = await this.db
      .selectFrom('tasks')
      .selectAll('tasks')
      .select(childCount.as('child_count'))
      .select(unmetBlockers.as('unmet_blockers'))
      .orderBy('position', 'asc')
      .execute()
    const labels = await this.labelsFor(rows.map((r) => r.id))
    return rows.map((r) => ({
      task: toRecord(r),
      child_count: Number(r.child_count),
      unmet_blockers: Number(r.unmet_blockers),
      labels: labels.get(r.id) ?? [],
    }))
  }

  async listReady(filter: { label?: string; limit: number }): Promise<TaskWithCounts[]> {
    const base = this.db
      .selectFrom('tasks')
      .selectAll('tasks')
      .select(childCount.as('child_count'))
      .select(unmetBlockers.as('unmet_blockers'))
      .where('tasks.status', '=', 'todo')
      .where('tasks.blocked_flag', '=', 0)
      .where('tasks.claim_token_id', 'is', null)
      .where(isLeaf)
      .where(noUnmetBlockers)
      .orderBy('tasks.position', 'asc')
    const query = filter.label ? base.where(hasLabel(filter.label)) : base
    const rows = await query.limit(filter.limit).execute()
    const labels = await this.labelsFor(rows.map((r) => r.id))
    return rows.map((r) => ({
      task: toRecord(r),
      child_count: Number(r.child_count),
      unmet_blockers: Number(r.unmet_blockers),
      labels: labels.get(r.id) ?? [],
    }))
  }

  async patch(id: string, patch: TaskPatch, updated_at: string): Promise<void> {
    const values: Partial<TasksTable> = { updated_at }
    if (patch.title !== undefined) values.title = patch.title
    if (patch.description !== undefined) values.description = patch.description
    if (patch.acceptance_criteria !== undefined)
      values.acceptance_criteria = patch.acceptance_criteria
    if (patch.blocked_flag !== undefined) values.blocked_flag = patch.blocked_flag ? 1 : 0
    if (patch.assignee_id !== undefined) values.assignee_id = patch.assignee_id
    await this.db.updateTable('tasks').set(values).where('id', '=', id).execute()
  }

  async setStatus(id: string, status: TaskStatus, updated_at: string): Promise<void> {
    await this.db.updateTable('tasks').set({ status, updated_at }).where('id', '=', id).execute()
  }

  async hasChildren(id: string): Promise<boolean> {
    const r = await sql<{ n: number }>`
      select count(*) as n from tasks where parent_id = ${id}
    `.execute(this.db)
    return Number(r.rows[0]?.n ?? 0) > 0
  }

  async countOpenDescendants(id: string): Promise<number> {
    const r = await sql<{ n: number }>`
      with recursive d(id) as (
        select id from tasks where parent_id = ${id}
        union all
        select t.id from tasks t join d on t.parent_id = d.id
      )
      select count(*) as n from d join tasks on tasks.id = d.id
       where tasks.status not in ('done','canceled')
    `.execute(this.db)
    return Number(r.rows[0]?.n ?? 0)
  }

  async nextPosition(parentId: string | null): Promise<number> {
    const r = await sql<{ m: number | null }>`
      select max(position) as m from tasks where parent_id ${
        parentId === null ? sql`is null` : sql`= ${parentId}`
      }
    `.execute(this.db)
    return Number(r.rows[0]?.m ?? 0) + 1
  }

  async tryClaim(
    taskId: string,
    tokenId: string,
    claimantActorId: string,
    status: TaskStatus,
    updated_at: string
  ): Promise<{ generation: number } | null> {
    // Single statement: UPDATE … RETURNING. The generation read must be ATOMIC with the
    // CAS — a separate findById between the two awaits could surface a generation this
    // claim never wrote when a split/release races the read. (Quality-review fix; Kysely
    // 0.29.5 supports update…returning on current SQLite.)
    const row = await this.db
      .updateTable('tasks')
      .set((eb) => ({
        claim_token_id: tokenId,
        assignee_id: claimantActorId,
        claim_generation: eb('claim_generation', '+', 1),
        status,
        updated_at,
      }))
      .where('id', '=', taskId)
      .where('claim_token_id', 'is', null)
      .returning('claim_generation')
      .executeTakeFirst()
    return row ? { generation: row.claim_generation } : null
  }

  async clearClaim(taskId: string, updated_at: string): Promise<void> {
    await this.db
      .updateTable('tasks')
      .set((eb) => ({
        claim_token_id: null,
        claim_generation: eb('claim_generation', '+', 1),
        updated_at,
      }))
      .where('id', '=', taskId)
      .execute()
  }

  async setHeartbeat(taskId: string, at: string): Promise<void> {
    await this.db
      .updateTable('tasks')
      .set({ last_heartbeat_at: at })
      .where('id', '=', taskId)
      .execute()
  }

  async ancestors(id: string): Promise<TaskRecord[]> {
    const r = await sql<TaskRow>`
      with recursive anc(id, depth) as (
        select parent_id, 1 from tasks where id = ${id} and parent_id is not null
        union all
        select t.parent_id, anc.depth + 1
          from tasks t join anc on t.id = anc.id
         where t.parent_id is not null
      )
      select tasks.* from tasks join anc on tasks.id = anc.id
       order by anc.depth desc
    `.execute(this.db)
    return r.rows.map(toRecord)
  }
}
