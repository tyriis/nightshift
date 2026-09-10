// src/testing/inject-fetch.ts — inject-backed fetch for the client/CLI test harnesses:
// zero sockets, the FULL hook chain (auth/idempotency/rate-limit ride a real Request).
// Plan F extraction of client.test.ts's inline injectFetch — behavior byte-identical,
// reused by the CLI tests (D-aaa DI); lives under src/testing/** (coverage-excluded).
import type { FastifyInstance } from 'fastify'

export const makeInjectFetch = (getApp: () => FastifyInstance): typeof globalThis.fetch => {
  return async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const res = await getApp().inject({
      method: request.method as 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(request.headers),
      ...(request.body === null ? {} : { body: Buffer.from(await request.arrayBuffer()) }),
    })
    return new Response(new Uint8Array(res.rawPayload), {
      status: res.statusCode,
      headers: Object.fromEntries(
        Object.entries(res.headers).flatMap(([k, v]) =>
          v === undefined ? [] : [[k, Array.isArray(v) ? v.join(', ') : String(v)]]
        )
      ),
    })
  }
}
