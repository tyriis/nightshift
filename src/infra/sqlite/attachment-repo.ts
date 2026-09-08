import type { Kysely } from 'kysely'
import type { AttachmentRecord, AttachmentRepo } from '#root/application/ports'
import type { AttachmentsTable, DB } from '#root/infra/sqlite/schema'

const toRecord = (r: AttachmentsTable): AttachmentRecord => ({
  id: r.id,
  task_id: r.task_id,
  filename: r.filename,
  content_type: r.content_type,
  sha256: r.sha256,
  bytes: r.bytes,
  created_by: r.created_by,
  created_at: r.created_at,
})

export class SqliteAttachmentRepo implements AttachmentRepo {
  constructor(private readonly db: Kysely<DB>) {}

  async add(draft: AttachmentRecord): Promise<AttachmentRecord> {
    const row = await this.db
      .insertInto('attachments')
      .values(draft)
      .returningAll()
      .executeTakeFirstOrThrow()
    return toRecord(row)
  }

  async find(id: string): Promise<AttachmentRecord | null> {
    const r = await this.db
      .selectFrom('attachments')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    return r ? toRecord(r) : null
  }

  async listForTask(taskId: string): Promise<AttachmentRecord[]> {
    const rows = await this.db
      .selectFrom('attachments')
      .selectAll()
      .where('task_id', '=', taskId)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute()
    return rows.map(toRecord)
  }

  // D-s dedupe anchor: the unique (task_id, sha256, filename) triple is the re-upload
  // probe — a hit means "same content under the same name on the same task", no new row.
  async findByTaskShaFilename(
    taskId: string,
    sha256: string,
    filename: string
  ): Promise<AttachmentRecord | null> {
    const r = await this.db
      .selectFrom('attachments')
      .selectAll()
      .where('task_id', '=', taskId)
      .where('sha256', '=', sha256)
      .where('filename', '=', filename)
      .executeTakeFirst()
    return r ? toRecord(r) : null
  }
}
