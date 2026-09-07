import type { FastifyError, FastifyInstance } from 'fastify'
import { isDomainError } from '#root/domain/errors'

export interface ProblemBody {
  type: string
  title: string
  status: number
  code: string
  detail: string
}

// RFC 9457 with stable machine code (spec §11)
const problem = (status: number, code: string, detail: string): ProblemBody => ({
  type: `https://nightshift.local/errors/${code}`,
  title: code.replaceAll('_', ' '),
  status,
  code,
  detail,
})

export const sendProblem = (
  reply: { code(n: number): { type(t: string): { send(b: unknown): unknown } } },
  status: number,
  code: string,
  detail: string
): unknown =>
  reply
    .code(status)
    .type('application/problem+json')
    .send(problem(status, code, detail))

export const registerProblemHandlers = (app: FastifyInstance): void => {
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (isDomainError(error)) {
      // details carry machine-readable flags (e.g. stale_lease claimed:true/false);
      // spread FIRST so fixed RFC fields can never be overridden by them
      return reply
        .code(error.status)
        .type('application/problem+json')
        .send({ ...(error.details ?? {}), ...problem(error.status, error.code, error.message) })
    }
    if ((error as FastifyError & { validation?: unknown }).validation) {
      return sendProblem(reply, 400, 'invalid_request', error.message)
    }
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500
    if (status === 400) return sendProblem(reply, 400, 'invalid_request', error.message)
    app.log.error(error)
    return sendProblem(
      reply,
      status === 401 ? 401 : 500,
      status === 401 ? 'unauthenticated' : 'internal_error',
      status === 401 ? error.message : 'internal error'
    )
  })

  app.setNotFoundHandler((_request, reply) => {
    // owns 404 AND method-mismatch (fastify 5 answers 405 with 404 by design,
    // fastify#862) — both become problem+json instead of the fastify default
    sendProblem(reply, 404, 'not_found', 'route not found')
  })
}
