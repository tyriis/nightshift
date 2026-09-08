import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import type { LinkKind } from '#root/domain/discussion'
import { actorCtx } from '#root/adapters/rest/auth'
import { DomainError } from '#root/domain/errors'

const kindEnum = { type: 'string', enum: ['pr', 'commit', 'doc', 'other'] } as const

export const registerLinkRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  app.get('/tasks/:id/links', async (request) => {
    const { id } = request.params as { id: string }
    // existence first, mirroring GET /tasks/:id/threads — a typo'd id must not read as "no links"
    const task = await deps.tasksRoot.findById(id)
    if (!task) throw new DomainError('not_found', `task ${id} not found`)
    return deps.linksRoot.listForTask(id)
  })

  app.post(
    '/tasks/:id/links',
    {
      schema: {
        body: {
          type: 'object',
          required: ['kind', 'url'],
          additionalProperties: false,
          // 8 = 'http://a', shortest parseable http(s) URL — nothing valid is rejected
          properties: { kind: kindEnum, url: { type: 'string', minLength: 8, maxLength: 2000 } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const { kind, url } = request.body as { kind: LinkKind; url: string }
      const row = await deps.useCases.addLink.run({ taskId: id, kind, url, ...actorCtx(request) })
      return reply.code(201).send(row)
    }
  )

  app.delete('/tasks/:id/links/:linkId', async (request, reply) => {
    const { id, linkId } = request.params as { id: string; linkId: string }
    await deps.useCases.removeLink.run({ taskId: id, linkId, ...actorCtx(request) })
    return reply.code(204).send()
  })
}
