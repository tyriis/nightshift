import { describe, expect, it } from 'vitest'
import { RandomIdGen } from '#root/infra/ids'

describe('RandomIdGen', () => {
  const gen = new RandomIdGen()

  it('prefixes ids with the entity tag', () => {
    expect(gen.newId('t')).toMatch(/^t_[a-z0-9]{16}$/)
  })

  it('never repeats across 1000 draws', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) seen.add(gen.newId('t'))
    expect(seen.size).toBe(1000)
  })
})
