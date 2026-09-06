export type DomainErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'invalid_request'
  | 'handle_taken'
  | 'already_claimed'
  | 'not_a_leaf'
  | 'open_descendants'
  | 'stale_lease'
  | 'dependency_cycle'
  | 'agent_close_forbidden'
  | 'open_questions'
  | 'threads_on_parent'
  | 'idempotency_in_flight'

const DOMAIN_ERROR_STATUS: Record<DomainErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  invalid_request: 400,
  handle_taken: 409,
  already_claimed: 409,
  not_a_leaf: 409,
  open_descendants: 409,
  stale_lease: 412,
  dependency_cycle: 409,
  agent_close_forbidden: 403,
  open_questions: 409,
  threads_on_parent: 409,
  idempotency_in_flight: 409,
}

export class DomainError extends Error {
  readonly status: number
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'DomainError'
    this.status = DOMAIN_ERROR_STATUS[code]
  }
}

export const isDomainError = (e: unknown): e is DomainError => e instanceof DomainError
