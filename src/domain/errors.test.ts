import { describe, expect, it } from 'vitest'
import { DomainError, isDomainError, type DomainErrorCode } from '#root/domain/errors'

describe('DomainError', () => {
  it.each<[DomainErrorCode, number]>([
    ['not_found', 404],
    ['forbidden', 403],
    ['invalid_request', 400],
    ['handle_taken', 409],
    ['already_claimed', 409],
    ['not_a_leaf', 409],
    ['open_descendants', 409],
    ['stale_lease', 412],
    ['dependency_cycle', 409],
    ['agent_close_forbidden', 403],
    ['open_questions', 409],
    ['threads_on_parent', 409],
    ['question_transition', 409],
    ['rate_limited', 429],
    ['idempotency_in_flight', 409],
    ['unauthenticated', 401],
  ])('maps %s to HTTP %i', (code, status) => {
    const err = new DomainError(code, `boom: ${code}`)
    expect(err.code).toBe(code)
    expect(err.status).toBe(status)
    expect(err.message).toBe(`boom: ${code}`)
    expect(err.name).toBe('DomainError')
    expect(err).toBeInstanceOf(Error)
  })

  it('carries optional details', () => {
    const err = new DomainError('invalid_request', 'bad', { field: 'title' })
    expect(err.details).toEqual({ field: 'title' })
  })
})

describe('isDomainError', () => {
  it('narrows DomainError instances', () => {
    expect(isDomainError(new DomainError('forbidden', 'no'))).toBe(true)
  })

  it('rejects other values', () => {
    expect(isDomainError(new Error('plain'))).toBe(false)
    expect(isDomainError('nope')).toBe(false)
    expect(isDomainError(null)).toBe(false)
  })
})
