// links/labels/attachments/events/audit — the REST twins transcribed (D-mm)
// — sync = shipped form (see Task 7 Amendment: LINK_KINDS const, byte-exact route
// bounds incl. ceilings, upload 413 self-check; `task_created` pin verified verbatim)
import { z } from 'zod'
import { McpEnvelopeError, defineTool } from '#root/adapters/mcp/bridge'
import { toEvent } from '#root/adapters/rest/routes/events'
import { UNSAFE_INLINE, safeFilename } from '#root/adapters/shared/attachment-safety'
import { LINK_KINDS } from '#root/domain/discussion'
import { DomainError } from '#root/domain/errors'

export const listLinks = defineTool({
  name: 'list_links',
  description: 'Task links, oldest first (mirrors GET /tasks/{id}/links).',
  input: z.object({ task_id: z.string() }),
  run: async (deps, _ctx, { task_id }) => {
    const task = await deps.tasksRoot.findById(task_id)
    if (!task) throw new DomainError('not_found', `task ${task_id} not found`) // existence first — ghost-404 verbatim (routes/links.ts:14)
    return deps.linksRoot.listForTask(task_id)
  },
})

// Transcription duty (D-mm): input bounds mirror routes/links.ts + labels.ts +
// attachments.ts fastify schemas byte-exact — url min8/max2000 (URL validity is the
// SHARED use-case's assertHttpUrl, exactly like REST — a zod .url() here would move
// that rejection to the SDK layer and fork the error path), label name min1/max60,
// filename min1/max240, content_type min1/max120; zod STRIPS unknown keys (status quo).

export const addLink = defineTool({
  name: 'add_link',
  description: 'Attach a URL (insert-or-get, always success, D-t; mirrors POST /tasks/{id}/links).',
  input: z.object({
    task_id: z.string(),
    kind: z.enum(LINK_KINDS), // the route's own enum source — one domain set, no literal fork
    url: z.string().min(8).max(2000),
  }),
  run: async (deps, ctx, { task_id, kind, url }) =>
    deps.useCases.addLink.run({ taskId: task_id, kind, url, ...ctx }),
})

export const removeLink = defineTool({
  name: 'remove_link',
  description: 'Remove a link (mirrors DELETE /tasks/{id}/links/{linkId}).',
  input: z.object({ task_id: z.string(), link_id: z.string() }),
  run: async (deps, ctx, { task_id, link_id }) => {
    await deps.useCases.removeLink.run({ taskId: task_id, linkId: link_id, ...ctx })
  },
})

export const listLabels = defineTool({
  name: 'list_labels',
  description: 'All labels by name (mirrors GET /labels).',
  input: z.object({}),
  run: async (deps) => deps.labelsRoot.list(),
})

export const createLabel = defineTool({
  name: 'create_label',
  description: 'Create a label (mirrors POST /labels).',
  input: z.object({ name: z.string().min(1).max(60), color: z.string().optional() }),
  run: async (deps, ctx, body) => deps.useCases.createLabel.run({ ...body, ...ctx }),
})

export const attachLabel = defineTool({
  name: 'attach_label',
  description: 'Attach a label to a task (mirrors PUT /tasks/{id}/labels/{labelId}).',
  input: z.object({ task_id: z.string(), label_id: z.string() }),
  run: async (deps, ctx, { task_id, label_id }) => {
    await deps.useCases.attachLabel.run({ taskId: task_id, labelId: label_id, ...ctx })
  },
})

export const detachLabel = defineTool({
  name: 'detach_label',
  description: 'Detach a label (mirrors DELETE /tasks/{id}/labels/{labelId}).',
  input: z.object({ task_id: z.string(), label_id: z.string() }),
  run: async (deps, ctx, { task_id, label_id }) => {
    await deps.useCases.detachLabel.run({ taskId: task_id, labelId: label_id, ...ctx })
  },
})

export const listAttachments = defineTool({
  name: 'list_attachments',
  description:
    'Task attachments incl. sha256 (D-s nothing hidden; mirrors GET /tasks/{id}/attachments).',
  input: z.object({ task_id: z.string() }),
  run: async (deps, _ctx, { task_id }) => {
    const task = await deps.tasksRoot.findById(task_id)
    if (!task) throw new DomainError('not_found', `task ${task_id} not found`) // ghost-404 verbatim (routes/attachments.ts:60)
    return deps.attachmentsRoot.listForTask(task_id)
  },
})

export const uploadAttachment = defineTool({
  name: 'upload_attachment',
  description:
    'Upload a file as base64 (mirrors POST /tasks/{id}/attachments; MCP has no octet-stream body, D-mm).',
  input: z.object({
    task_id: z.string(),
    filename: z.string().min(1).max(240),
    content_type: z.string().min(1).max(120),
    content_base64: z.base64(),
  }),
  run: async (deps, ctx, { task_id, filename, content_type, content_base64 }) => {
    const content = Buffer.from(content_base64, 'base64')
    // REST enforces the cap at the route; MCP self-checks with the SAME config value
    // and the SAME adapter code name (D-mm/D-jj) — 413 never comes from zod.
    // REST's bodyLimit compares the raw bytes; base64 inflates on the wire, so the
    // comparison is on the DECODED bytes — the same artifact REST caps.
    if (content.byteLength > deps.config.maxUploadBytes) {
      throw new McpEnvelopeError({ code: 'payload_too_large', status: 413 })
    }
    return deps.useCases.uploadAttachment.run({
      taskId: task_id,
      filename,
      contentType: content_type,
      content,
      ...ctx,
    })
  },
})

export const getAttachmentContent = defineTool({
  name: 'get_attachment_content',
  description:
    'Download an attachment as base64 with the computed safety headers (mirrors GET /attachments/{id}/content).',
  input: z.object({ attachment_id: z.string() }),
  run: async (deps, _ctx, { attachment_id }) => {
    const row = await deps.attachmentsRoot.find(attachment_id)
    if (!row) throw new DomainError('not_found', `attachment ${attachment_id} not found`)
    const bytes = await deps.files.get(row.sha256)
    if (!bytes) throw new DomainError('not_found', 'stored blob is missing') // second distinct 404, verbatim
    const safe = UNSAFE_INLINE.test(row.content_type)
    return {
      content_type: safe ? 'application/octet-stream' : row.content_type,
      content_disposition: `${safe ? 'attachment' : 'inline'}; filename="${safeFilename(row.filename)}"`,
      x_content_type_options: 'nosniff',
      bytes_base64: Buffer.from(bytes).toString('base64'),
    }
  },
})

export const getEvents = defineTool({
  name: 'get_events',
  description:
    'The audit-spine cursor feed, ascending (mirrors GET /events; cursor = audit_log.id, D-aa).',
  input: z.object({
    cursor: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  run: async (deps, _ctx, { cursor, limit }) =>
    (await deps.auditRoot.tail(cursor, limit)).map(toEvent), // the SHARED REST mapper — id→cursor + payload-strip, one source
})

export const searchAudit = defineTool({
  name: 'search_audit',
  description: 'Audit rows, newest first, payloads included (mirrors GET /audit).',
  input: z.object({
    entity_type: z.string().optional(),
    entity_id: z.string().optional(),
    limit: z.number().int().min(1).max(500).default(50),
  }),
  run: async (deps, _ctx, q) => deps.auditRoot.search(q), // payloads INCLUDED (D-aa); the auth gate is the hook chain's job
})

export const REFERENCE_TOOLS = [
  listLinks,
  addLink,
  removeLink,
  listLabels,
  createLabel,
  attachLabel,
  detachLabel,
  listAttachments,
  uploadAttachment,
  getAttachmentContent,
  getEvents,
  searchAudit,
]
