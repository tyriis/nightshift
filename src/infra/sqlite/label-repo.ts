import type { Kysely } from 'kysely'
import type { LabelRepo, LabelRow } from '#root/application/ports'
import type { DB } from '#root/infra/sqlite/schema'

export class SqliteLabelRepo implements LabelRepo {
  constructor(private readonly db: Kysely<DB>) {}

  async ensure(input: {
    id: string
    name: string
    color: string
    created_at: string
  }): Promise<LabelRow> {
    // insert-or-get by unique name: the doNothing conflict leaves the row untouched,
    // then the select reads whichever row owns the name (Task-4 idiom: no `as`-cast,
    // executeTakeFirstOrThrow proves the row exists).
    await this.db
      .insertInto('labels')
      .values(input)
      .onConflict((oc) => oc.column('name').doNothing())
      .execute()
    return this.db
      .selectFrom('labels')
      .selectAll()
      .where('name', '=', input.name)
      .executeTakeFirstOrThrow()
  }

  async list(): Promise<LabelRow[]> {
    return this.db.selectFrom('labels').selectAll().orderBy('name', 'asc').execute()
  }

  async attach(taskId: string, labelId: string): Promise<void> {
    await this.db
      .insertInto('task_labels')
      .values({ task_id: taskId, label_id: labelId })
      .onConflict((oc) => oc.columns(['task_id', 'label_id']).doNothing())
      .execute()
  }

  async detach(taskId: string, labelId: string): Promise<void> {
    await this.db
      .deleteFrom('task_labels')
      .where('task_id', '=', taskId)
      .where('label_id', '=', labelId)
      .execute()
  }

  async labelsFor(taskId: string): Promise<LabelRow[]> {
    return this.db
      .selectFrom('labels')
      .selectAll('labels')
      .innerJoin('task_labels', 'task_labels.label_id', 'labels.id')
      .where('task_labels.task_id', '=', taskId)
      .orderBy('labels.name', 'asc')
      .execute()
  }
}
