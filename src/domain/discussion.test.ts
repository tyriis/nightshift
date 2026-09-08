import { describe, expect, it } from 'vitest'
import {
  INBOX_ITEM_KINDS,
  LINK_KINDS,
  QUESTION_STATES,
  THREAD_KINDS,
  canTransitionQuestion,
} from '#root/domain/discussion'

describe('discussion vocabulary (spec §6.5/§6.6)', () => {
  it('freezes the kinds/states/link-kinds vocabularies', () => {
    expect(THREAD_KINDS).toEqual(['note', 'question'])
    expect(QUESTION_STATES).toEqual(['open', 'answered', 'resolved', 'wont_fix'])
    expect(LINK_KINDS).toEqual(['pr', 'commit', 'doc', 'other'])
    expect(INBOX_ITEM_KINDS).toEqual(['assigned', 'mentioned', 'question_assigned'])
  })
})

describe('question transitions (decision D-n)', () => {
  // full matrix — domain carries a 100% branch threshold, exhaustive is cheap here
  const matrix: Array<[string, string, boolean]> = [
    ['open', 'open', false],
    ['open', 'answered', true],
    ['open', 'resolved', false], // resolve implies it was answered (D-n)
    ['open', 'wont_fix', true],
    ['answered', 'open', false],
    ['answered', 'answered', false],
    ['answered', 'resolved', true],
    ['answered', 'wont_fix', true],
    ['resolved', 'open', false],
    ['resolved', 'answered', false],
    ['resolved', 'resolved', false],
    ['resolved', 'wont_fix', false],
    ['wont_fix', 'open', false],
    ['wont_fix', 'answered', false],
    ['wont_fix', 'resolved', false],
    ['wont_fix', 'wont_fix', false],
  ]
  it.each(matrix)('%s → %s allowed: %s', (from, to, allowed) => {
    expect(canTransitionQuestion(from as never, to as never)).toBe(allowed)
  })
})
