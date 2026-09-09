// src/adapters/mcp/http.test.ts — converter edges of the D-hh mount, probed end-to-end
// (mount.test.ts drives the happy paths through the real app; these pin the
// header-posture edges the harness traffic never produces).
import { describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { webRequestFromFastify, writeWebResponseToFastify } from '#root/adapters/mcp/http'

const fakeReq = (req: {
  headers: Record<string, string | string[] | undefined>
  method: string
  url: string
}): FastifyRequest => req as unknown as FastifyRequest

describe('webRequestFromFastify (D-ii: verbatim header forwarding)', () => {
  it('multi-value request headers ride as repeated appends (array-valued fastify header)', () => {
    const req = fakeReq({
      headers: {
        host: 'example.test',
        accept: ['application/json', 'text/event-stream'],
        'content-length': '999', // hop-by-hop: must NOT ride through
      },
      method: 'POST',
      url: '/mcp',
    })
    const web = webRequestFromFastify(req, new Uint8Array(0))
    // Headers.append joins repeats with ", " — both values survive, none dropped.
    expect(web.headers.get('accept')).toBe('application/json, text/event-stream')
    expect(web.headers.get('content-length')).toBeNull()
  })

  it('missing host header falls back to localhost (defensive: real legs always carry Host)', () => {
    const req = fakeReq({ headers: { authorization: 'Bearer x' }, method: 'GET', url: '/mcp?x=1' })
    const web = webRequestFromFastify(req, undefined)
    expect(web.url).toBe('http://localhost/mcp?x=1')
    expect(web.body).toBeNull() // GET is bodyless by rule
  })
})

describe('writeWebResponseToFastify', () => {
  it('set-cookie survives as an ARRAY via getSetCookie, other headers verbatim (no join-mangling)', async () => {
    const webRes = new Response(null, {
      status: 204,
      headers: { 'set-cookie': 'a=1', 'mcp-session-id': 'sid_1' },
    })
    const raw = { writeHead: vi.fn(), end: vi.fn() }
    await writeWebResponseToFastify(webRes, { raw } as unknown as FastifyReply)
    expect(raw.writeHead).toHaveBeenCalledTimes(1)
    const [status, headers] = raw.writeHead.mock.calls[0] as unknown as [
      number,
      Record<string, string | string[]>,
    ]
    expect(status).toBe(204)
    expect(headers['mcp-session-id']).toBe('sid_1')
    expect(headers['set-cookie']).toEqual(['a=1']) // array, not the forEach join
    expect(raw.end).toHaveBeenCalled()
  })
})
