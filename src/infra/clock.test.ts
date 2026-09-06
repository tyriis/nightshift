import { describe, expect, it } from 'vitest'
import { SystemClock, isoNow } from '#root/infra/clock'

describe('clock', () => {
  it('SystemClock.now returns current wall time', () => {
    const before = Date.now()
    const now = new SystemClock().now().getTime()
    expect(now).toBeGreaterThanOrEqual(before)
    expect(now).toBeLessThanOrEqual(Date.now())
  })

  it('isoNow formats an injected clock as ISO-8601 UTC', () => {
    const fixed = { now: () => new Date('2026-09-06T12:00:00.000Z') }
    expect(isoNow(fixed)).toBe('2026-09-06T12:00:00.000Z')
  })

  it('isoNow defaults to SystemClock', () => {
    expect(isoNow()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })
})
