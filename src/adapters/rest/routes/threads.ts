import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import type { QuestionState } from '#root/domain/discussion'
import type { ThreadKind } from '#root/domain/discussion'
import { actorCtx } from '#root/adapters/rest/auth'
import { DomainError } from '#root/domain/errors'

const kindEnum = { type: 'string', enum: ['note', 'question'] } as const
const stateEnum = { type: 'string', enum: ['open', 'answered', 'resolved', 'wont_fix'] } as const

// REST speaks handles (public actor vocabulary); use-cases speak ids (ports.ts).
// The route resolves handle → id; unknown handle → 404 not_found from the use-case.
async function handleToId(deps: AppDeps, handle: string): Promise<string> {
  const rows = await deps.actorsRoot.list()
  const hit = rows.find((a) => a.handle === handle)
  if (!hit) throw new DomainError('not_found', `actor '@${handle}' not found`)
  return hit.id
}

export const registerThreadRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  app.get('/tasks/:id/threads', async (request) => {
    const { id } = request.params as { id: string }
    return deps.threadsRoot.listForTask(id)
  })

  app.post(
    '/tasks/:id/threads',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { meta_note: { type: 'boolean' } },
        },
        body: {
          type: 'object',
          required: ['kind', 'body'],
          additionalProperties: false,
          properties: {
            kind: kindEnum,
            body: { type: 'string', minLength: 1, maxLength: 20000 },
            assignee_handle: { type: 'string', minLength: 1, maxLength: 60 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const q = request.query as { meta_note?: boolean }
      const body = request.body as { kind: ThreadKind; body: string; assignee_handle?: string }
      const assigneeId = body.assignee_handle
        ? await handleToId(deps, body.assignee_handle)
        : undefined
      const result = await deps.useCases.createThread.run({
        taskId: id,
        kind: body.kind,
        body: body.body,
        assignee_id: assigneeId,
        metaNote: q.meta_note,
        ...actorCtx(request), // actorCtx LAST (binding)
      })
      return reply.code(201).send(result)
    }
  )

  app.post(
    '/tasks/:id/threads/:tid/messages',
    {
      schema: {
        body: {
          type: 'object',
          required: ['body'],
          additionalProperties: false,
          properties: { body: { type: 'string', minLength: 1, maxLength: 20000 } },
        },
      },
    },
    async (request, reply) => {
      const { tid } = request.params as { id: string; tid: string }
      const { body } = request.body as { body: string }
      const message = await deps.useCases.addMessage.run({
        threadId: tid,
        body,
        ...actorCtx(request),
      })
      return reply.code(201).send(message)
    }
  )

  app.post(
    '/tasks/:id/threads/:tid/answer',
    {
      schema: {
        body: {
          type: 'object',
          required: ['body'],
          additionalProperties: false,
          properties: { body: { type: 'string', minLength: 1, maxLength: 20000 } },
        },
      },
    },
    async (request) => {
      const { tid } = request.params as { id: string; tid: string }
      const { body } = request.body as { body: string }
      return deps.useCases.answerQuestion.run({ threadId: tid, body, ...actorCtx(request) })
    }
  )

  app.patch(
    '/tasks/:id/threads/:tid',
    {
      schema: {
        body: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: {
            state: stateEnum,
            assignee_handle: { type: 'string', minLength: 1, maxLength: 60 },
          },
        },
      },
    },
    async (request) => {
      const { tid } = request.params as { id: string; tid: string }
      const body = request.body as { state?: QuestionState; assignee_handle?: string }
      const assigneeId = body.assignee_handle
        ? await handleToId(deps, body.assignee_handle)
        : undefined
      return deps.useCases.updateQuestion.run({
        threadId: tid,
        state: body.state,
        assignee_id: assigneeId,
        ...actorCtx(request), // actorCtx LAST (binding)
      })
    }
  )
}
