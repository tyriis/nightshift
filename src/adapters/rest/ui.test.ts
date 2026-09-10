// src/adapters/rest/ui.test.ts
// D-vv arms: the /ui static mount seen through the REAL build tree (Task 8's
// ui:build output). Honest skip doctrine (Task 10 Step 1): every build-requiring
// arm is `it.skipIf(!BUILD)` — loud and declared in the reporter when the build is
// absent (never fake-green); tonight's gates run WITH the build, so the arms below
// are counted as RUN. The absent-build face is pinned unconditionally by U8 + the
// drift test's ZERO-member STATIC arm.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { makeTestApp } from '#root/testing/test-app'
import { registerAuth } from '#root/adapters/rest/auth'
import { registerProblemHandlers } from '#root/adapters/rest/problem'
import { encodeSessionCookie } from '#root/adapters/shared/session-codec'
import { mountUi, uiBuildPresent } from '#root/adapters/rest/ui'

const BUILD = uiBuildPresent()
const BUILD_DIR = join(process.cwd(), 'adapters', 'sveltekit', 'build')
const SHELL = BUILD ? readFileSync(join(BUILD_DIR, 'index.html'), 'utf8') : ''

type TestApp = Awaited<ReturnType<typeof makeTestApp>>

// zero new machine strings: every UI fall-through answers the byte-identical
// hook/bearer problems (D-vv: the exemption is GET/HEAD under /ui ONLY)
const MISSING_BEARER = 'missing bearer token (Plan E adds human cookie sessions)'
const D_RR = 'missing or invalid CSRF token (D-rr)'
const NOT_FOUND_BODY = {
  type: 'https://nightshift.local/errors/not_found',
  title: 'not found',
  status: 404,
  code: 'not_found',
  detail: 'route not found',
} as const

const uiApp = async (): Promise<TestApp> => makeTestApp({ NS_SESSION_KEY: 'k'.repeat(32) })

// mint = sessionsRoot.create + encodeSessionCookie — the session-auth.test.ts seam
const mint = async (t: TestApp): Promise<string> => {
  const nowMs = Date.now()
  await t.deps.sessionsRoot.create({
    id: 's_ui',
    actor_id: 'a_nils',
    csrf: 'c_ui',
    created_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + 8 * 3_600_000).toISOString(),
  })
  return encodeSessionCookie(
    { sid: 's_ui', exp: new Date(nowMs + 8 * 3_600_000).toISOString() },
    t.deps.config.sessionKey!
  )
}

describe('ui mount (D-vv) — built-tree arms U1-U7', () => {
  it.skipIf(!BUILD)('U1 GET /ui/ and GET /ui answer the shell, html, no-cache', async () => {
    const t = await uiApp()
    for (const url of ['/ui/', '/ui']) {
      const res = await t.app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toContain('text/html')
      expect(res.headers['cache-control']).toBe('no-cache')
      expect(res.body).toBe(SHELL)
    }
    await t.close()
  })

  it.skipIf(!BUILD)(
    'U2 SPA deep-links (files absent) answer the shell via the scope notFound — no-cache',
    async () => {
      const t = await uiApp()
      for (const url of ['/ui/login', '/ui/tasks/NS-1']) {
        const res = await t.app.inject({ method: 'GET', url })
        expect(res.statusCode).toBe(200)
        expect(res.headers['content-type']).toContain('text/html')
        expect(res.headers['cache-control']).toBe('no-cache')
        expect(res.body).toBe(SHELL)
      }
      await t.close()
    }
  )

  it.skipIf(!BUILD)(
    'U3 hashed asset is immutable 30d; preCompressed pairs the build .br',
    async () => {
      const t = await uiApp()
      const asset = readdirSync(join(BUILD_DIR, '_app', 'immutable', 'entry')).find(
        (f) => !f.endsWith('.br') && !f.endsWith('.gz')
      )!
      const url = `/ui/_app/immutable/entry/${asset}`
      const res = await t.app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(200)
      expect(res.headers['cache-control']).toBe('public, max-age=2592000, immutable')
      // preCompressed: true pairs adapter-static precompress: true — the shipped
      // .br sibling is what a br-negotiating client receives
      const br = await t.app.inject({ method: 'GET', url, headers: { 'accept-encoding': 'br' } })
      expect(br.headers['content-encoding']).toBe('br')
      await t.close()
    }
  )

  it.skipIf(!BUILD)(
    'U4 HEAD rides the GET exemption: /ui/ 200 no body; HEAD deep-link rides the fallback',
    async () => {
      const t = await uiApp()
      const head = await t.app.inject({ method: 'HEAD', url: '/ui/' })
      expect(head.statusCode).toBe(200)
      expect(head.headers['cache-control']).toBe('no-cache')
      expect(head.payload).toBe('')
      // HEAD arm of the scope notFound (the request.method === 'HEAD' disjunct)
      const deep = await t.app.inject({ method: 'HEAD', url: '/ui/login' })
      expect(deep.statusCode).toBe(200)
      expect(deep.payload).toBe('')
      await t.close()
    }
  )

  it.skipIf(!BUILD)(
    'U6 POST /ui/ with NO credentials => byte-identical missing-bearer 401 (exemption is GET/HEAD ONLY)',
    async () => {
      const t = await uiApp()
      const res = await t.app.inject({ method: 'POST', url: '/ui/' })
      expect(res.statusCode).toBe(401)
      expect(res.json().code).toBe('unauthenticated')
      expect(res.json().detail).toBe(MISSING_BEARER)
      await t.close()
    }
  )

  it.skipIf(!BUILD)(
    'U6b session POST /ui/x WITHOUT CSRF => 403 D-rr — non-GET under /ui falls THROUGH the hook',
    async () => {
      const t = await uiApp()
      const sess = await mint(t)
      const res = await t.app.inject({
        method: 'POST',
        url: '/ui/x',
        headers: { cookie: `__Host-ns_sess=${sess}` },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json().code).toBe('forbidden')
      expect(res.json().detail).toBe(D_RR)
      await t.close()
    }
  )

  it.skipIf(!BUILD)(
    'U6c in-scope non-GET (bearer past the hook) answers the ROOT problem+json 404 byte-for-byte',
    async () => {
      const t = await uiApp()
      const bearer = { authorization: `Bearer ${t.adminToken}` }
      // the root notFound owns /no/such — the byte-shape oracle for the in-scope re-shape
      const ghost = await t.app.inject({
        method: 'GET',
        url: '/no/such/route/at/all',
        headers: bearer,
      })
      expect(ghost.statusCode).toBe(404)
      expect(ghost.json()).toEqual(NOT_FOUND_BODY)
      const res = await t.app.inject({ method: 'POST', url: '/ui/deep/thing', headers: bearer })
      expect(res.statusCode).toBe(404)
      expect(res.headers['content-type']).toContain('application/problem+json')
      // plan duty: the in-scope non-GET body MATCHES the root envelope byte-for-byte
      expect(res.json()).toEqual(ghost.json())
      await t.close()
    }
  )

  it.skipIf(!BUILD)(
    'U7 GET /uix => 401 — single-member set: /ui/ prefix ONLY (/uix is NOT under it)',
    async () => {
      const t = await uiApp()
      const res = await t.app.inject({ method: 'GET', url: '/uix' })
      expect(res.statusCode).toBe(401)
      expect(res.json().detail).toBe(MISSING_BEARER)
      await t.close()
    }
  )
})

// U5 — re-pinned honestly (preflight P7/fix13): inject (and EVERY browser UA)
// normalizes dot-segments BEFORE the hook sees the URL, so no dot-segment inject
// can exercise a UI-path fail-close. The honest pin is the hook's normalizer AS
// SHIPPED: the regexes are machine-coupled to auth.ts source (a drift there
// breaks the coupling assertion, not a silently diverged lookalike), then their
// behavior is unit-pinned. Membership is fail-closed: collapse/strip can only add
// PUBLIC spellings of SET members — dot runs pass THROUGH untouched, so a path
// under /ui never escapes into /openapi.yaml (or anything else) at the hook layer.
describe('U5 hook normalizer unit (dot-segment reality — fail-closed membership)', () => {
  const authSrc = readFileSync(new URL('./auth.ts', import.meta.url), 'utf8')

  const normalize = (url: string): string =>
    (url.split('?')[0] ?? '/').replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1')

  it('is machine-coupled to the shipped auth.ts normalizer (source-verbatim regexes)', () => {
    expect(authSrc).toContain("(request.url.split('?')[0] ?? '/')")
    expect(authSrc).toContain(".replace(/\\/{2,}/g, '/')")
    expect(authSrc).toContain(".replace(/(.)\\/+$/, '$1')")
  })

  it('collapses duplicate slashes, strips trailing (root kept), strips query — dots pass through', () => {
    expect(normalize('/ui//login')).toBe('/ui/login')
    expect(normalize('/ui///x')).toBe('/ui/x')
    expect(normalize('//ping')).toBe('/ping')
    expect(normalize('/ui/login/')).toBe('/ui/login')
    expect(normalize('/ui/')).toBe('/ui')
    expect(normalize('/')).toBe('/') // the strip requires a preceding char — root survives
    expect(normalize('/ui/login?x=1')).toBe('/ui/login')
    // dot runs are NEVER rewritten: /ui/.. stays under the /ui prefix treatment,
    // the collapse can never rewrite a UI path into /openapi.yaml or any other member
    expect(normalize('/ui/../openapi.yaml')).toBe('/ui/../openapi.yaml')
    expect(normalize('/ui/../../etc/passwd')).toBe('/ui/../../etc/passwd')
  })
})

describe('U8 D-vv skip arm: build absent ⇒ warn + mount SKIPS + root 404 intact', () => {
  it('mountUi against an absent build dir: warn-once, zero routes, /ui/x answers root problem+json', async () => {
    // honest mechanism: BUILD_DIR is the module-load process.cwd() literal, so the
    // "cwd pointing elsewhere" of the plan is effected by spying cwd for a FRESH
    // import of ui.ts — the real build dir is never moved (parallel-safe)
    const t = await makeTestApp()
    const empty = mkdtempSync(join(tmpdir(), 'ns-ui-absent-'))
    const logs: string[] = []
    try {
      vi.spyOn(process, 'cwd').mockReturnValue(empty)
      vi.resetModules()
      const { mountUi: mountFresh } =
        (await import('#root/adapters/rest/ui')) as typeof import('#root/adapters/rest/ui')
      const app = Fastify({
        logger: { level: 'warn', stream: { write: (line: string) => logs.push(line) } },
      })
      registerProblemHandlers(app)
      registerAuth(app, t.deps)
      mountFresh(app, t.deps)
      await app.ready() // boot NEVER crashes

      expect(app.hasRoute({ method: 'GET', url: '/ui/*' })).toBe(false)
      expect(logs.filter((l) => l.includes('UI build absent')).length).toBe(1) // warn-ONCE
      expect(
        logs.some((l) =>
          l.includes(
            'UI build absent (adapters/sveltekit/build) — /ui mount skipped; run pnpm ui:build'
          )
        )
      ).toBe(true)

      const res = await app.inject({ method: 'GET', url: '/ui/x' })
      expect(res.statusCode).toBe(404) // the GET/HEAD exemption is hook-side; with no mount the root notFound owns it
      expect(res.headers['content-type']).toContain('application/problem+json')
      expect(res.json()).toEqual(NOT_FOUND_BODY)
      await app.close()
    } finally {
      vi.restoreAllMocks()
      vi.resetModules() // drop the cwd-shifted module copy; top-level imports are untouched
      rmSync(empty, { recursive: true, force: true })
      await t.close()
    }
  })
})
