import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import { actorCtx } from '#root/adapters/rest/auth'
import { DomainError } from '#root/domain/errors'

// spec §10: never render HTML/SVG from attachment origin
const UNSAFE_INLINE = /^text\/html|^application\/xhtml|^image\/svg/i

export const registerAttachmentRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  app.post(
    '/tasks/:id/attachments',
    {
      // route-level bodyLimit is a DIRECT route option (fastify lib/route.js) —
      // a config.bodyLimit is inert; oversize rides the T2 413 payload_too_large map
      bodyLimit: deps.config.maxUploadBytes,
      schema: {
        querystring: {
          type: 'object',
          required: ['filename'],
          properties: {
            filename: { type: 'string', minLength: 1, maxLength: 240 },
            content_type: {
              type: 'string',
              minLength: 1,
              maxLength: 120,
              default: 'application/octet-stream',
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      // content_type is REQUIRED post-validation: the schema `default` fills it (ajv
      // coerce/default runs before the handler), so the runtime type is total
      const q = request.query as { filename: string; content_type: string }
      const content = request.body as Buffer
      // the upload contract is RAW bytes; the shipped default json/text parsers parse
      // other types into objects/strings BEFORE any 415 could fire (415 is parser-level
      // only, an adapter code) — refuse with invalid_request instead of corrupting
      if (!Buffer.isBuffer(content)) {
        throw new DomainError(
          'invalid_request',
          'attachment upload requires application/octet-stream bytes'
        )
      }
      const row = await deps.useCases.uploadAttachment.run({
        taskId: id,
        filename: q.filename,
        contentType: q.content_type, // schema `default` is the single fallback — no ?? twin
        content,
        ...actorCtx(request), // actorCtx LAST (binding)
      })
      return reply.code(201).send(row)
    }
  )

  app.get('/tasks/:id/attachments', async (request) => {
    const { id } = request.params as { id: string }
    return deps.attachmentsRoot.listForTask(id)
  })

  app.get('/attachments/:id/content', async (request, reply) => {
    const { id } = request.params as { id: string }
    const row = await deps.attachmentsRoot.find(id)
    if (!row) throw new DomainError('not_found', `attachment ${id} not found`)
    const bytes = await deps.files.get(row.sha256)
    if (!bytes) throw new DomainError('not_found', 'stored blob is missing')
    const safe = UNSAFE_INLINE.test(row.content_type)
    // filename sanitized: strip quotes/control for the disposition header
    const filename = row.filename.replace(/["\\\r\n]/g, '_')
    return reply
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', `${safe ? 'attachment' : 'inline'}; filename="${filename}"`)
      .type(safe ? 'application/octet-stream' : row.content_type)
      .send(bytes)
  })
}
