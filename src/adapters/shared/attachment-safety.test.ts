import { describe, expect, it } from 'vitest'
import { safeFilename, UNSAFE_INLINE } from '#root/adapters/shared/attachment-safety'

describe('attachment safety (D-s, moved verbatim)', () => {
  it('downgrades html/xhtml/svg origins — pinned matrix', () => {
    expect(UNSAFE_INLINE.test('text/html')).toBe(true)
    expect(UNSAFE_INLINE.test('text/HTML; charset=utf-8')).toBe(true)
    expect(UNSAFE_INLINE.test('application/xhtml+xml')).toBe(true)
    expect(UNSAFE_INLINE.test('image/svg+xml')).toBe(true)
    expect(UNSAFE_INLINE.test('text/plain')).toBe(false)
    expect(UNSAFE_INLINE.test('image/png')).toBe(false)
  })

  it('folds control chars, quote and backslash to _ — never a raw ERR_INVALID_CHAR', () => {
    expect(safeFilename('a"b\\c')).toBe('a_b_c')
    expect(safeFilename('tab\there\nlf')).toBe('tab_here_lf')
    expect(safeFilename('del\u007f')).toBe('del_')
    expect(safeFilename('ünïcode ✓.md')).toBe('ünïcode ✓.md')
  })
})
