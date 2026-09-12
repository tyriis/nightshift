import { describe, expect, it } from 'vitest'
import { loadConfig, oidcEnabled } from '#root/main/config'

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig({})).toEqual({
      port: 3123,
      dbPath: './nightshift.db',
      bootstrapToken: undefined,
      adminEmails: [],
      dataDir: './data',
      maxUploadBytes: 20_971_520,
      rateLimitPerMin: 120,
      webhookIntervalMs: 1000,
      webhookTimeoutMs: 5000,
      webhookMaxBackoffMs: 300_000,
      oidcIssuer: undefined,
      oidcClientId: undefined,
      oidcClientSecret: undefined,
      oidcScope: 'openid profile email',
      publicUrl: undefined,
      sessionKey: undefined,
      sessionTtlS: 28_800,
      keepaliveIntervalMs: 0,
      keepaliveTimeoutS: 0,
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

  it('NS_ADMIN_EMAILS: comma-split, trimmed, empties dropped; unset is []', () => {
    expect(loadConfig({}).adminEmails).toEqual([])
    expect(loadConfig({ NS_ADMIN_EMAILS: '' }).adminEmails).toEqual([])
    expect(loadConfig({ NS_ADMIN_EMAILS: ' nils@x.test , , bob@x.test ' }).adminEmails).toEqual([
      'nils@x.test',
      'bob@x.test',
    ])
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

describe('plan E config seams (D-pp/D-qq)', () => {
  const oidcEnv = {
    NS_DB_PATH: ':memory:',
    NS_OIDC_ISSUER: 'https://id.example.com/',
    NS_OIDC_CLIENT_ID: 'nightshift',
    NS_PUBLIC_URL: 'http://localhost:3123/',
    NS_SESSION_KEY: 'k'.repeat(32),
  }

  it('strips trailing slashes from issuer and public URL', () => {
    const c = loadConfig(oidcEnv)
    expect(c.oidcIssuer).toBe('https://id.example.com')
    expect(c.publicUrl).toBe('http://localhost:3123')
  })

  it('OIDC configured WITHOUT a session key is invalid env', () => {
    const { NS_SESSION_KEY: _drop, ...env } = oidcEnv
    expect(() => loadConfig(env)).toThrow(/invalid env/)
  })

  it('OIDC configured WITHOUT NS_PUBLIC_URL is invalid env', () => {
    const { NS_PUBLIC_URL: _drop, ...env } = oidcEnv
    expect(() => loadConfig(env)).toThrow(/invalid env/)
  })

  it('session key WITHOUT OIDC is legal (dormant); issuer WITHOUT client id is dormant', () => {
    expect(() =>
      loadConfig({ NS_DB_PATH: ':memory:', NS_SESSION_KEY: 'k'.repeat(32) })
    ).not.toThrow()
    expect(() =>
      loadConfig({ NS_DB_PATH: ':memory:', NS_OIDC_ISSUER: 'https://id.example.com' })
    ).not.toThrow()
  })

  it('oidcEnabled is the single truth for the enabled posture', () => {
    expect(oidcEnabled(loadConfig(oidcEnv))).toBe(true)
    expect(oidcEnabled(loadConfig({ NS_DB_PATH: ':memory:' }))).toBe(false)
  })
})

describe('plan G keepalive config (D-ggg)', () => {
  it('dormant by default: 0/0 — every pre-G deployment byte-unchanged', () => {
    const c = loadConfig({})
    expect(c.keepaliveIntervalMs).toBe(0)
    expect(c.keepaliveTimeoutS).toBe(0)
  })

  it('half-opened enforcement fails the boot, both directions (D-qq precedent)', () => {
    expect(() => loadConfig({ NS_KEEPALIVE_INTERVAL_MS: '30000' })).toThrow(/invalid env/)
    expect(() => loadConfig({ NS_KEEPALIVE_TIMEOUT_S: '300' })).toThrow(/invalid env/)
  })

  it('a budget shorter than the sweep tick is invalid; the enabled pair parses', () => {
    expect(() =>
      loadConfig({ NS_KEEPALIVE_INTERVAL_MS: '30000', NS_KEEPALIVE_TIMEOUT_S: '29' })
    ).toThrow(/invalid env/)
    const c = loadConfig({ NS_KEEPALIVE_INTERVAL_MS: '30000', NS_KEEPALIVE_TIMEOUT_S: '30' })
    expect(c.keepaliveIntervalMs).toBe(30_000)
    expect(c.keepaliveTimeoutS).toBe(30)
  })
})
