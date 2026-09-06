import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { isTaskReady, type ReadyCandidate } from '#root/domain/ready'

const base: ReadyCandidate = {
  status: 'todo',
  blocked_flag: false,
  child_count: 0,
  claim_holder: false,
  unmet_blockers: 0,
}

describe('ready predicate (spec 6.3)', () => {
  it('base candidate is ready', () => {
    expect(isTaskReady(base)).toBe(true)
  })

  it.each([
    ['wrong status', { status: 'backlog' } as const],
    ['blocked flag', { blocked_flag: true } as const],
    ['has children', { child_count: 1 } as const],
    ['claimed', { claim_holder: true } as const],
    ['unmet blockers', { unmet_blockers: 2 } as const],
  ])('not ready when %s', (_name, patch) => {
    expect(isTaskReady({ ...base, ...patch })).toBe(false)
  })

  it('property: ready implies every gate is clear', () => {
    fc.assert(
      fc.property(
        fc.record({
          status: fc.constantFrom(
            'backlog',
            'todo',
            'in_progress',
            'in_review',
            'done',
            'canceled'
          ),
          blocked_flag: fc.boolean(),
          child_count: fc.nat(4),
          claim_holder: fc.boolean(),
          unmet_blockers: fc.nat(4),
        }),
        (c) =>
          isTaskReady(c) ===
          (c.status === 'todo' &&
            !c.blocked_flag &&
            c.child_count === 0 &&
            !c.claim_holder &&
            c.unmet_blockers === 0)
      )
    )
  })
})
