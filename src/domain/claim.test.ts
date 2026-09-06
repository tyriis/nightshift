import { describe, expect, it } from 'vitest'
import { formatLeaseToken, parseLeaseToken } from '#root/domain/claim'

describe('lease tokens', () => {
  it('round-trips', () => {
    const ref = parseLeaseToken(formatLeaseToken('t_abc', 7))
    expect(ref).toEqual({ taskId: 't_abc', generation: 7 })
  })

  it('rejects missing separator', () => {
    expect(parseLeaseToken('t_abc')).toBeNull()
  })

  it('rejects non-numeric generation', () => {
    expect(parseLeaseToken('t_abc:x')).toBeNull()
  })

  it('rejects negative generation', () => {
    expect(parseLeaseToken('t_abc:-1')).toBeNull()
  })

  it('rejects float generation', () => {
    expect(parseLeaseToken('t_abc:1.5')).toBeNull()
  })

  it('rejects non-string input', () => {
    expect(parseLeaseToken(42)).toBeNull()
    expect(parseLeaseToken(null)).toBeNull()
  })
})
