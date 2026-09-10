// the client is LOAD-BEARING (D-kk): smoke through the real app
import { describe, expect, it } from 'vitest'
import { createNightshiftClient } from '#root/client/index'
import { makeInjectFetch } from '#root/testing/inject-fetch'
import { makeTestApp } from '#root/testing/test-app'

let CURRENT: Awaited<ReturnType<typeof makeTestApp>>
// inject-backed fetch: zero sockets, the same hook chain (auth middleware rides a real
// Request, so the client exercises the same 401 path a network consumer would)
const injectFetch = makeInjectFetch(() => CURRENT.app)

describe('nightshift-client smoke (D-kk)', () => {
  it('creates via typed paths and branches on the problem code — no text parsing (spec §11 preamble)', async () => {
    CURRENT = await makeTestApp()
    try {
      const client = createNightshiftClient({
        baseUrl: 'http://nightshift.test',
        token: CURRENT.adminToken,
        fetch: injectFetch,
      })
      const created = await client.POST('/tasks', {
        body: { title: 'via client', status: 'todo' }, // claim gate excludes the backlog default
      })
      expect(created.error).toBeUndefined()
      expect(created.data?.title).toBe('via client')
      const id = created.data!.id
      const first = await client.POST('/tasks/{id}/claim', { params: { path: { id } } })
      expect(first.error).toBeUndefined()
      const loser = await client.POST('/tasks/{id}/claim', { params: { path: { id } } })
      expect(loser.data).toBeUndefined()
      expect((loser.error as { code?: string }).code).toBe('already_claimed') // problem+json typed (D-kk probe-proven)
      // FLAT details ride through typed EXACTLY as the REST twin serializes them: the
      // already_claimed problem carries holder_handle/holder_display_name (openapi.yaml:957)
      expect(loser.error).toMatchObject({ status: 409, holder_handle: expect.any(String) })
    } finally {
      await CURRENT.close()
    }
  })

  it('constructs without a fetch override — the D-kk default path, never hand-rolled (no network touched)', () => {
    // construction alone walks the fetch===undefined arm; no request is ever fired
    const client = createNightshiftClient({ baseUrl: 'http://nightshift.test', token: 't' })
    expect(typeof client.GET).toBe('function')
  })
})
