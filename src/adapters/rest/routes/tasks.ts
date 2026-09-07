import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import type { TaskPatch } from '#root/application/ports'
import type { SplitChildDraft } from '#root/application/usecases/split-task'
import type { TaskStatus } from '#root/domain/task'
import { actorCtx } from '#root/adapters/rest/auth'
import { toTaskDto } from '#root/adapters/rest/dto'
import { DomainError } from '#root/domain/errors'
import { TASK_STATUSES } from '#root/domain/task'

const statusEnum = { type: 'string', enum: TASK_STATUSES } as const

// M-2 (Task 7 review): the route schema, NOT the use-case, owns title length
// validation — minLength/maxLength on every title entry point below.
interface CreateTaskBody {
  title: string
  description?: string
  acceptance_criteria?: string
  parent_id?: string
  status?: TaskStatus
  labels?: string[]
}

export const registerTaskRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  app.post(
    '/tasks',
    {
      schema: {
        body: {
          type: 'object',
          required: ['title'],
          additionalProperties: false,
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 300 },
            description: { type: 'string' },
            acceptance_criteria: { type: 'string' },
            parent_id: { type: 'string' },
            status: statusEnum,
            labels: { type: 'array', items: { type: 'string', minLength: 1 } },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as CreateTaskBody
      const task = await deps.useCases.createTask.run({ ...actorCtx(request), ...body })
      const withCounts = (await deps.tasksRoot.findWithCounts(task.id))!
      return reply.code(201).send(toTaskDto(withCounts))
    }
  )

  app.get('/tasks', async () => (await deps.tasksRoot.listAllWithCounts()).map(toTaskDto))

  app.get(
    '/tasks/next',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (request) => {
      const q = request.query as { label?: string; limit?: number }
      return (await deps.useCases.getNext.run({ label: q.label, limit: q.limit })).map(toTaskDto)
    }
  )

  app.get('/tasks/:id', async (request) => {
    const { id } = request.params as { id: string }
    const row = await deps.tasksRoot.findWithCounts(id)
    if (!row) throw new DomainError('not_found', `task ${id} not found`)
    return toTaskDto(row)
  })

  // The context bundle's shape is fixed by spec §7.2 (get-context.ts), so it passes
  // through as the use-case composed it; flat task JSON everywhere else goes toTaskDto.
  app.get('/tasks/:id/context', async (request) => {
    const { id } = request.params as { id: string }
    return deps.useCases.getContext.run({ taskId: id })
  })

  app.patch(
    '/tasks/:id',
    {
      schema: {
        body: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 300 },
            description: { type: 'string' },
            acceptance_criteria: { type: 'string' },
            blocked_flag: { type: 'boolean' },
            assignee_id: { type: ['string', 'null'] },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string }
      const { actor, tokenId } = actorCtx(request)
      await deps.useCases.updateTask.run({
        actor,
        tokenId,
        taskId: id,
        patch: request.body as TaskPatch,
      })
      return toTaskDto((await deps.tasksRoot.findWithCounts(id))!)
    }
  )

  app.patch(
    '/tasks/:id/status',
    {
      schema: {
        body: {
          type: 'object',
          required: ['status', 'reason'],
          additionalProperties: false,
          properties: {
            status: statusEnum,
            reason: { type: 'string', minLength: 1 },
            lease_token: { type: 'string' },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string }
      const body = request.body as { status: TaskStatus; reason: string; lease_token?: string }
      const task = await deps.useCases.updateStatus.run({
        ...actorCtx(request),
        taskId: id,
        to: body.status,
        reason: body.reason,
        lease_token: body.lease_token,
      })
      return toTaskDto((await deps.tasksRoot.findWithCounts(task.id))!)
    }
  )

  // SplitTaskResult's shape ({parent, created}) is pinned by spec §7.4 step 4 and the
  // integration test below; like the context bundle it passes through un-DTO'd.
  app.post(
    '/tasks/:id/split',
    {
      schema: {
        body: {
          type: 'object',
          required: ['children'],
          additionalProperties: false,
          properties: {
            children: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                required: ['title'],
                additionalProperties: false,
                properties: {
                  title: { type: 'string', minLength: 1, maxLength: 300 },
                  description: { type: 'string' },
                  acceptance_criteria: { type: 'string' },
                  status: statusEnum,
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const { children } = request.body as { children: SplitChildDraft[] }
      const result = await deps.useCases.splitTask.run({
        ...actorCtx(request),
        taskId: id,
        children,
      })
      return reply.code(201).send(result)
    }
  )

  app.post('/tasks/:id/claim', async (request) => {
    const { id } = request.params as { id: string }
    return deps.useCases.claimTask.run({ ...actorCtx(request), taskId: id })
  })

  app.post('/tasks/:id/release', async (request) => {
    const { id } = request.params as { id: string }
    const task = await deps.useCases.releaseClaim.run({ ...actorCtx(request), taskId: id })
    return toTaskDto((await deps.tasksRoot.findWithCounts(task.id))!)
  })

  app.post(
    '/tasks/:id/heartbeat',
    {
      schema: {
        body: {
          type: 'object',
          required: ['lease_token'],
          additionalProperties: false,
          properties: { lease_token: { type: 'string' } },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string }
      const { lease_token } = request.body as { lease_token: string }
      const task = await deps.useCases.heartbeat.run({
        ...actorCtx(request),
        taskId: id,
        lease_token,
      })
      return toTaskDto((await deps.tasksRoot.findWithCounts(task.id))!)
    }
  )
}
