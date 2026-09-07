import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import { actorCtx } from '#root/adapters/rest/auth'

export const registerLabelRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  app.get('/labels', async () => deps.labelsRoot.list())

  // plan block wrote this as a 2-arg call with the async handler embedded in the
  // options object (non-compiling); shipped as the 3-arg schema'd registration,
  // matching tasks.ts (Task 14 sync).
  app.post(
    '/labels',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 60 },
            color: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { name: string; color?: string }
      // Task 14 review defense: trusted auth context spread LAST, after the
      // schema-validated body (additionalProperties:false already fences it).
      const label = await deps.useCases.createLabel.run({ ...body, ...actorCtx(request) })
      return reply.code(201).send(label)
    }
  )

  app.put('/tasks/:id/labels/:labelId', async (request, reply) => {
    const { id, labelId } = request.params as { id: string; labelId: string }
    await deps.useCases.attachLabel.run({ ...actorCtx(request), taskId: id, labelId })
    return reply.code(204).send()
  })

  app.delete('/tasks/:id/labels/:labelId', async (request, reply) => {
    const { id, labelId } = request.params as { id: string; labelId: string }
    await deps.useCases.detachLabel.run({ ...actorCtx(request), taskId: id, labelId })
    return reply.code(204).send()
  })
}
