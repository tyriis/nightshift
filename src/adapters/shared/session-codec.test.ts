import { describe, expect, it } from 'vitest'
import {
  clearSessionCookies,
  decodeSessionCookie,
  encodeSessionCookie,
  parseCookies,
  sessionCookieSet,
} from '#root/adapters/shared/session-codec'
import { createHmac } from 'node:crypto'

const KEY = 'k'.repeat(32)
const NOW = '2026-09-09T12:00:00.000Z'
const FUT = '2026-09-09T20:00:00.000Z'
const PAST = '2026-09-09T11:00:00.000Z'

describe('session codec (D-qq)', () => {
  it('roundtrips a signed payload', () => {
    const raw = encodeSessionCookie({ sid: 's1', exp: FUT }, KEY)
    expect(decodeSessionCookie(raw, KEY, NOW)).toEqual({ sid: 's1', exp: FUT })
  })
  it('rejects a tampered payload and a tampered signature', () => {
    const raw = encodeSessionCookie({ sid: 's1', exp: FUT }, KEY)
    expect(
      decodeSessionCookie(raw.slice(0, -1) + (raw.endsWith('A') ? 'B' : 'A'), KEY, NOW)
    ).toBeNull()
    const [p] = raw.split('.')
    expect(decodeSessionCookie(`${p}.${p}`, KEY, NOW)).toBeNull()
  })
  it('rejects the wrong key, garbage shapes, and a past exp', () => {
    const raw = encodeSessionCookie({ sid: 's1', exp: FUT }, KEY)
    expect(decodeSessionCookie(raw, 'j'.repeat(32), NOW)).toBeNull()
    expect(decodeSessionCookie('nodothere', KEY, NOW)).toBeNull()
    expect(decodeSessionCookie('..', KEY, NOW)).toBeNull()
    expect(
      decodeSessionCookie(encodeSessionCookie({ sid: 's1', exp: PAST }, KEY), KEY, NOW)
    ).toBeNull()
    expect(
      decodeSessionCookie(
        `${Buffer.from(JSON.stringify({ sid: 7, exp: 3 })).toString('base64url')}.x`,
        KEY,
        NOW
      )
    ).toBeNull()
  })
  it('cookie attributes are byte-pinned (__Host-, Secure, Lax, Path=/; HttpOnly on the session leg only)', () => {
    const [sess, csrf] = sessionCookieSet({ sid: 's1', exp: FUT }, 28_800, 'csrfval', KEY)
    expect(sess).toMatch(
      /^__Host-ns_sess=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=28800$/
    )
    expect(csrf).toBe('__Host-ns_csrf=csrfval; Secure; SameSite=Lax; Path=/; Max-Age=28800')
    const [c1, c2] = clearSessionCookies()
    expect(c1).toBe('__Host-ns_sess=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0')
    expect(c2).toBe('__Host-ns_csrf=; Secure; SameSite=Lax; Path=/; Max-Age=0')
  })
  it('parseCookies: absent/empty header, padding, duplicates-first-wins, no-value entries', () => {
    expect(parseCookies(undefined)).toEqual({})
    expect(parseCookies('')).toEqual({})
    expect(parseCookies('  a=1;  b=2 ; a=9 ;flag ;')).toEqual({ a: '1', b: '2' })
  })
})

// Never-lower arm coverage. Every reject in the pinned block dies at the SIGNATURE
// gate, so the parse/shape arms of the decode are unreachable from it. These sign
// the payloads with the real key (the honest adversarial-with-key case — the verify
// must not be the only line of defense for shape) and pin the shape gate itself.
const signJsonText = (json: string): string => {
  const payload = Buffer.from(json, 'utf8').toString('base64url')
  return `${payload}.${createHmac('sha256', KEY).update(payload, 'utf8').digest('base64url')}`
}

describe('session codec — valid-signature shape gate (never-lower arms)', () => {
  it('rejects signed non-JSON, signed non-object and signed null payloads', () => {
    expect(decodeSessionCookie(signJsonText('notjson'), KEY, NOW)).toBeNull()
    expect(decodeSessionCookie(signJsonText('7'), KEY, NOW)).toBeNull()
    expect(decodeSessionCookie(signJsonText('null'), KEY, NOW)).toBeNull()
  })
  it('rejects signed wrong-shape payloads (sid/exp typeof arms)', () => {
    expect(
      decodeSessionCookie(signJsonText(JSON.stringify({ sid: 7, exp: FUT })), KEY, NOW)
    ).toBeNull()
    expect(
      decodeSessionCookie(signJsonText(JSON.stringify({ sid: 's1', exp: 3 })), KEY, NOW)
    ).toBeNull()
  })
})
