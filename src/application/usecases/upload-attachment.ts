import { DomainError } from '#root/domain/errors'
import type {
  ActorContext,
  AttachmentRecord,
  Clock,
  FileStore,
  IdGen,
  UnitOfWork,
} from '#root/application/ports'

export interface UploadAttachmentInput extends ActorContext {
  taskId: string
  filename: string
  contentType: string
  content: Uint8Array
}

/**
 * D-s: the blob goes to the FileStore BEFORE the transaction (content-addressed, so a
 * concurrent same-content put is harmless and a tx rollback leaves only an orphan blob —
 * the audit + row are the truth). Hashing lives in the FileStore infra (put returns
 * {sha256, bytes}); node:crypto stays out of the app layer — this file only speaks ports.
 */
export class UploadAttachment {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGen,
    private readonly files: FileStore
  ) {}

  async run(input: UploadAttachmentInput): Promise<AttachmentRecord> {
    if (input.content.byteLength === 0) {
      throw new DomainError('invalid_request', 'attachment upload requires non-empty content')
    }
    const ref = await this.files.put(input.content) // idempotent, hashes in infra (D-s)
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      const task = await repos.tasks.findById(input.taskId)
      if (!task) throw new DomainError('not_found', `task ${input.taskId} not found`)
      const existing = await repos.attachments.findByTaskShaFilename(
        input.taskId,
        ref.sha256,
        input.filename
      )
      if (existing) return existing // no second audit for byte-identical re-upload
      const row = await repos.attachments.add({
        id: this.ids.newId('at'),
        task_id: input.taskId,
        filename: input.filename,
        content_type: input.contentType,
        sha256: ref.sha256,
        bytes: ref.bytes,
        created_by: input.actor.id,
        created_at: now,
      })
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'attachment_uploaded',
        entity_type: 'attachment',
        entity_id: row.id,
        after: { task_id: input.taskId, sha256: ref.sha256, bytes: row.bytes },
        reason: 'attachment uploaded',
        created_at: now,
      })
      return row
    })
  }
}
