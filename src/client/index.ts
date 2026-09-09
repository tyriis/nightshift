// nightshift-client (spec §7.1): generated paths + auth + problem-typed results
import createClient, { type Client, type Middleware } from 'openapi-fetch'
import type { paths } from '#root/client/schema.d.ts'

export interface NightshiftClientOptions {
  baseUrl: string
  token: string
  fetch?: typeof globalThis.fetch
}

// This module IS the spec's `nightshift-client`; extracting a publishable npm
// package is a later human call (D-kk). The drift test keeps `paths` pinned to the
// contract; consumers get typed data/error unions and nothing hand-rolled.
export const createNightshiftClient = (opts: NightshiftClientOptions): Client<paths> => {
  const client = createClient<paths>({
    baseUrl: opts.baseUrl,
    ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
  })
  const auth: Middleware = {
    onRequest({ request }) {
      request.headers.set('authorization', `Bearer ${opts.token}`)
      return request
    },
  }
  client.use(auth)
  return client
}

export type { paths } from '#root/client/schema.d.ts'
