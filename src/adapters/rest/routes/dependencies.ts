import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import { actorCtx } from '#root/adapters/rest/auth'

export const registerDependencyRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  app.put('/tasks/:id/blocks/:blockerId', async (request, reply) => {
    const { id, blockerId } = request.params as { id: string; blockerId: string }
    await deps.useCases.addBlock.run({ ...actorCtx(request), taskId: id, blocker_id: blockerId })
    return reply.code(204).send()
  })

  app.delete('/tasks/:id/blocks/:blockerId', async (request, reply) => {
    const { id, blockerId } = request.params as { id: string; blockerId: string }
    await deps.useCases.removeBlock.run({ ...actorCtx(request), taskId: id, blocker_id: blockerId })
    return reply.code(204).send()
  })
}
