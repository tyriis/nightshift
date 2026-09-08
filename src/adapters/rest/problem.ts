import type { FastifyError, FastifyInstance } from 'fastify'
import { isDomainError, type DomainErrorCode } from '#root/domain/errors'

export interface ProblemBody {
  type: string
  title: string
  status: number
  code: string
  detail: string
}

// Decision D-u: adapter-level codes are NOT DomainErrors — they are transport facts
// (media type, body limit). The OpenAPI drift test pins this map against the yaml
// Problem.code enum exactly like DOMAIN_ERROR_STATUS (domain ∪ adapter = the enum).
// rate_limited is deliberately absent — it IS a domain code (D-v).
export const ADAPTER_ERROR_CODES = {
  internal_error: 500,
  payload_too_large: 413,
  unsupported_media_type: 415,
} as const

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
  code: DomainErrorCode | keyof typeof ADAPTER_ERROR_CODES,
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
    if (status === 413) return sendProblem(reply, 413, 'payload_too_large', error.message)
    if (status === 415) return sendProblem(reply, 415, 'unsupported_media_type', error.message)
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
