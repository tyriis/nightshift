import { describe, expect, it } from 'vitest'
import { extractMentions } from '#root/domain/mentions'

describe('extractMentions (decision D-q)', () => {
  it('extracts @handles once each, first-seen order', () => {
    expect(extractMentions('@nils ping @ana and @nils again')).toEqual(['nils', 'ana'])
  })
  it('requires a boundary before the @ — emails never mention', () => {
    expect(extractMentions('write a@b.com please')).toEqual([])
  })
  it('accepts a paren-thrown mention and handle characters', () => {
    expect(extractMentions('(@hermes-1) on it')).toEqual(['hermes-1'])
  })
  it('stops the token at non-handle characters', () => {
    expect(extractMentions('@nils, hi')).toEqual(['nils'])
  })
  it('returns [] for plain text', () => {
    expect(extractMentions('no mentions at all')).toEqual([])
  })
})
