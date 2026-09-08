import { describe, expect, it } from 'vitest'
import { loadConfig } from '#root/main/config'

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig({})).toEqual({
      port: 3123,
      dbPath: './nightshift.db',
      bootstrapToken: undefined,
      dataDir: './data',
      maxUploadBytes: 20_971_520,
      rateLimitPerMin: 120,
    })
  })

  it('coerces numeric port', () => {
    expect(loadConfig({ NS_PORT: '8080' }).port).toBe(8080)
  })

  it('rejects non-numeric port', () => {
    expect(() => loadConfig({ NS_PORT: 'abc' })).toThrow(/invalid env/)
  })

  it('rejects empty-string port (zod coerce gotcha)', () => {
    expect(() => loadConfig({ NS_PORT: '' })).toThrow(/invalid env/)
  })

  it('rejects short bootstrap token', () => {
    expect(() => loadConfig({ NS_BOOTSTRAP_TOKEN: 'short' })).toThrow(/invalid env/)
  })

  it('coerces the Plan B knobs; 0 rate limit is legal (off switch, D-v)', () => {
    const c = loadConfig({ NS_MAX_UPLOAD_BYTES: '4096', NS_RATE_LIMIT_PER_MIN: '0' })
    expect(c.maxUploadBytes).toBe(4096)
    expect(c.rateLimitPerMin).toBe(0)
  })

  it('rejects non-numeric upload cap and negative rate limit', () => {
    expect(() => loadConfig({ NS_MAX_UPLOAD_BYTES: 'abc' })).toThrow(/invalid env/)
    expect(() => loadConfig({ NS_RATE_LIMIT_PER_MIN: '-1' })).toThrow(/invalid env/)
  })
})
