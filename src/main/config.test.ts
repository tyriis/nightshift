import { describe, expect, it } from 'vitest'
import { loadConfig } from '#root/main/config'

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig({})).toEqual({
      port: 3123,
      dbPath: './nightshift.db',
      bootstrapToken: undefined,
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
})
