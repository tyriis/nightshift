import { describe, expect, it } from 'vitest'
import { generateRawToken, generateWebhookSecret, hashToken } from '#root/infra/token-hash'

describe('token hashing (spec §5: SHA-256 of high-entropy input)', () => {
  it('matches the sha256 test vector', () => {
    expect(hashToken('a')).toBe('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb')
  })

  it('generates url-safe 256-bit tokens', () => {
    const tok = generateRawToken()
    expect(tok).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(new Set(Array.from({ length: 100 }, () => generateRawToken())).size).toBe(100)
  })

  it('webhook signing keys share the raw-token form (D-ff: plaintext is on purpose)', () => {
    const secret = generateWebhookSecret()
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(new Set(Array.from({ length: 100 }, () => generateWebhookSecret())).size).toBe(100)
  })
})
