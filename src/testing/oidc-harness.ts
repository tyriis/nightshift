// Task 7 duty (plan Step 2: "makeOidcApp helper gains an export for scenario
// reuse"): the Task-5 RP-test helper extracted from oidc-rp.test.ts into
// src/testing (coverage-excluded; lint/typecheck DO apply). Same shape the
// Task-5 amendment pinned — {t, idp, log, fetch, authorizeOnly, runFlow} — plus
// close() so the caller owns teardown.
//
// Module-freshness discipline stays with the CALLER: discover/jwks caches are
// oidc-rp MODULE state, so `rp` is injected (oidc-rp.test.ts fresh-imports per
// test; the route tests pass the static import and isolate via unique issuers).
import { expect } from 'vitest'
import type { OidcFlow, OidcTokenSet } from '#root/adapters/shared/oidc-rp'
import { makeTestApp, type TestApp } from '#root/testing/test-app'
import { buildStubIdp, makeInjectFetch, type StubIdp, type StubUser } from '#root/testing/stub-idp'

export const SESSION_KEY = 'k'.repeat(32)

export const oidcBaseEnv = (issuer: string): NodeJS.ProcessEnv => ({
  NS_OIDC_ISSUER: issuer,
  NS_OIDC_CLIENT_ID: 'ns',
  NS_OIDC_CLIENT_SECRET: 'supersecret1',
  NS_PUBLIC_URL: 'http://board.test',
  NS_SESSION_KEY: SESSION_KEY,
})

export interface OidcAppOptions {
  /** caller-owned module instance — see the freshness note above */
  rp: typeof import('#root/adapters/shared/oidc-rp')
  issuer: string
  users: Record<string, StubUser>
  userKey?: string
  mutateEnv?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv
}

export interface OidcApp {
  t: TestApp
  idp: StubIdp
  log: string[]
  fetch: typeof globalThis.fetch
  authorizeOnly(userKey?: string): Promise<{ flow: OidcFlow; code: string }>
  runFlow(userKey?: string): Promise<{ flow: OidcFlow; code: string; tokens: OidcTokenSet }>
  close(): Promise<void>
}

export const makeOidcApp = async (opts: OidcAppOptions): Promise<OidcApp> => {
  const base = oidcBaseEnv(opts.issuer)
  const env = opts.mutateEnv ? opts.mutateEnv({ ...base }) : { ...base }
  const idp = buildStubIdp({
    issuer: env.NS_OIDC_ISSUER as string,
    clientId: env.NS_OIDC_CLIENT_ID as string,
    ...(env.NS_OIDC_CLIENT_SECRET ? { clientSecret: env.NS_OIDC_CLIENT_SECRET } : {}),
    redirectUris: [`${env.NS_PUBLIC_URL}/auth/callback`],
    users: opts.users,
  })
  const log: string[] = []
  const fetchFn = makeInjectFetch(env.NS_OIDC_ISSUER as string, idp.app, log)
  const t = await makeTestApp(env, fetchFn)
  const authorizeOnly = async (
    userKey = opts.userKey ?? 'alice'
  ): Promise<{ flow: OidcFlow; code: string }> => {
    const { url, flow } = opts.rp.buildAuthorize(t.deps, '/ui/')
    const res = await idp.app.inject({
      method: 'GET',
      url: `${url.slice(opts.issuer.length)}&login_hint=${userKey}`,
    })
    expect(res.statusCode).toBe(302)
    const loc = new URL(res.headers.location as string)
    expect(loc.searchParams.get('state')).toBe(flow.state) // the browser-side echo check
    expect(loc.searchParams.get('iss')).toBe(opts.issuer) // RFC 9207
    return { flow, code: String(loc.searchParams.get('code')) }
  }
  const runFlow = async (
    userKey?: string
  ): Promise<{ flow: OidcFlow; code: string; tokens: OidcTokenSet }> => {
    const { flow, code } = await authorizeOnly(userKey)
    const tokens = await opts.rp.exchangeCode(t.deps, code, flow.verifier)
    return { flow, code, tokens }
  }
  const close = async (): Promise<void> => {
    await t.close()
    await idp.app.close()
  }
  return { t, idp, log, fetch: fetchFn, authorizeOnly, runFlow, close }
}
