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
      webhookIntervalMs: 1000,
      webhookTimeoutMs: 5000,
      webhookMaxBackoffMs: 300_000,
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

  it('defaults the webhook delivery knobs (D-bb)', () => {
    const c = loadConfig({})
    expect(c.webhookIntervalMs).toBe(1000)
    expect(c.webhookTimeoutMs).toBe(5000)
    expect(c.webhookMaxBackoffMs).toBe(300_000)
  })

  it('interval 0 disables the loop (the D-v honesty lever); bounds are enforced', () => {
    expect(loadConfig({ NS_WEBHOOK_INTERVAL_MS: '0' }).webhookIntervalMs).toBe(0)
    expect(() => loadConfig({ NS_WEBHOOK_TIMEOUT_MS: '1' })).toThrow(/invalid env/)
    expect(() => loadConfig({ NS_WEBHOOK_MAX_BACKOFF_MS: '5' })).toThrow(/invalid env/)
  })
})
