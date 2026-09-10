// §11.5 smoke (D-xx): the ONE honest chain against the shipped SPA + API + the
// in-repo stub IdP over real loopback sockets. Selectors are the shipped views'
// OWN markup (Tasks 8/9 passed their own review — if a pin cannot hold, THAT IS
// THE FINDING; the test bends, the views never do).
import { expect, test } from '@playwright/test'
import { APP_BASE } from './e2e-env'

test('§11.5 login -> board -> task -> comment -> status', async ({ page, context }) => {
  // honesty rig: SPA console errors are surfaced, never swallowed
  page.on('pageerror', (e) => console.log(`[browser pageerror] ${e.message}`))
  // CSRF route spy (step 6): every NON-GET /tasks* request the SPA makes, with
  // the x-csrf-token header it carried. page.route + continue — a pure spy.
  const mutating: { url: string; token: string | null }[] = []
  await page.route(
    (url) => url.origin === APP_BASE && url.pathname.startsWith('/tasks'),
    async (route) => {
      const req = route.request()
      if (req.method() !== 'GET')
        mutating.push({ url: req.url(), token: req.headers()['x-csrf-token'] ?? null })
      await route.continue()
    }
  )

  // THE stub's user picker (step 2): the shipped stub has NO HTML login page —
  // selecting a user IS its documented test-only `login_hint` query leg
  // (src/testing/stub-idp.ts:84-96). Redirect hops are NOT surfaced to route
  // interception by this headless-shell build (measured tonight: direct goto IS
  // intercepted, a 302-continuation is not), so the hint rides a rewrite of the
  // /auth/login redirect's OWN Location — every hop after that is a real,
  // un-intercepted browser navigation: :3310/authorize -> callback -> /ui/.
  let authorizeUrl: URL | undefined
  await page.route(
    (url) => url.origin === APP_BASE && url.pathname === '/auth/login',
    async (route) => {
      const res = await route.fetch({ maxRedirects: 0 })
      const loc = new URL(res.headers()['location'])
      authorizeUrl = loc
      loc.searchParams.set('login_hint', 'alice')
      const headers = { ...res.headers() }
      headers.location = loc.toString()
      await route.fulfill({ response: res, headers })
    }
  )

  // --- 1: login view — the OIDC button ONLY; registration is ABSENT (§8-5 pin)
  await page.goto(`${APP_BASE}/ui/login`)
  const signIn = page.getByRole('link', { name: 'Sign in with your account' })
  await expect(signIn).toBeVisible()
  await expect(page.locator('a, button').filter({ hasText: /register|sign.?up/i })).toHaveCount(0)

  // --- 2+3: click -> stub /authorize -> back on /ui/ (board visible). The
  // callback 302 is captured for the raw Set-Cookie attribute pins.
  const callback = page.waitForResponse(
    (r) => new URL(r.url()).origin === APP_BASE && new URL(r.url()).pathname === '/auth/callback'
  )
  await signIn.click()
  await page.waitForURL((url) => url.origin === APP_BASE && url.pathname === '/ui/')

  expect(authorizeUrl?.searchParams.get('client_id')).toBe('nightshift-e2e')
  expect(authorizeUrl?.searchParams.get('redirect_uri')).toBe(`${APP_BASE}/auth/callback`)
  expect(authorizeUrl?.searchParams.get('code_challenge_method')).toBe('S256')
  expect(authorizeUrl?.searchParams.get('state')).toBeTruthy()
  expect(authorizeUrl?.searchParams.get('nonce')).toBeTruthy()

  const cb = await callback
  expect(cb.status()).toBe(302)
  const setCookies = (await cb.headersArray())
    .filter((h) => h.name.toLowerCase() === 'set-cookie')
    .flatMap((h) => h.value.split('\n'))
    .map((line) => line.trim())
    .filter(Boolean)
  const sessLine = setCookies.find((l) => l.startsWith('__Host-ns_sess='))
  const csrfLine = setCookies.find((l) => l.startsWith('__Host-ns_csrf='))
  const flowClear = setCookies.find((l) => l.startsWith('__Host-ns_flow='))
  // __Host- semantics from a REAL browser: Secure + Path=/ + NO Domain anywhere,
  // HttpOnly on the session leg ONLY (D-rr companion stays JS-readable).
  expect(sessLine, 'session cookie in Set-Cookie').toBeDefined()
  expect(sessLine).toContain('; HttpOnly')
  expect(sessLine).toContain('Secure')
  expect(sessLine).toContain('Path=/')
  expect(sessLine).toContain('Max-Age=28800')
  expect(sessLine).not.toContain('Domain=')
  expect(csrfLine, 'CSRF companion cookie in Set-Cookie').toBeDefined()
  expect(csrfLine).not.toContain('HttpOnly')
  expect(csrfLine).toContain('Secure')
  expect(csrfLine).toContain('Path=/')
  expect(csrfLine).not.toContain('Domain=')
  expect(flowClear, 'flow cookie cleared on the callback').toBeDefined()
  expect(flowClear).toContain('Max-Age=0')

  // BOTH __Host- cookies present in the context, attributes asserted (expect.poll)
  const attrs = async (name: string) => {
    const c = (await context.cookies()).find((x) => x.name === name)
    return c && { secure: c.secure, path: c.path, httpOnly: c.httpOnly, domain: c.domain }
  }
  await expect
    .poll(async () => attrs('__Host-ns_sess'))
    .toEqual({ secure: true, path: '/', httpOnly: true, domain: '127.0.0.1' })
  await expect
    .poll(async () => attrs('__Host-ns_csrf'))
    .toEqual({ secure: true, path: '/', httpOnly: false, domain: '127.0.0.1' })
  // the companion is READABLE BY THE PAGE (not HttpOnly) — D-rr proof, real browser
  await expect.poll(() => page.evaluate(() => document.cookie)).toContain('__Host-ns_csrf=')
  // board mounted (SPA shell + fallback answered /ui/) — the file form is there
  await expect(page.getByPlaceholder('File a task…')).toBeVisible()

  // --- 4: file a task via the board form; the swimlane card appears WITHOUT a
  // manual reload (the §8 refresh path — no page navigation happened).
  await page.getByPlaceholder('File a task…').fill('e2e smoke task')
  await page.getByRole('button', { name: 'File', exact: true }).click()
  const card = page.locator('a.card', { hasText: 'e2e smoke task' })
  await expect(card).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/ui/') // still the same page — never reloaded

  // --- 5: task detail — the SIX §8-2 tabs render, exact names, exact order
  await card.click()
  await expect(page.locator('header h1')).toHaveText('e2e smoke task')
  await expect(page.locator('.tabs button.tab')).toHaveText([
    'conversation',
    'children',
    'dependencies',
    'attachments+links',
    'activity',
    'context',
  ])
  const taskId = new URL(page.url()).pathname.split('/').pop() as string

  // --- 6: post a note comment; it appears in the conversation tab, and the
  // route spy proves the CSRF header RODE the real POST (= the companion value).
  await page.getByPlaceholder('comment (becomes a note thread)…').fill('smoke note via comment box')
  await page.getByRole('button', { name: 'Comment' }).click()
  await expect(
    page.locator('article.thread p', { hasText: 'smoke note via comment box' })
  ).toBeVisible()
  const csrfCookie = (await context.cookies()).find((c) => c.name === '__Host-ns_csrf')?.value
  const threadPost = mutating.find((m) => new URL(m.url).pathname === `/tasks/${taskId}/threads`)
  expect(threadPost, 'POST /tasks/{id}/threads observed by the spy').toBeDefined()
  expect(threadPost?.token, 'x-csrf-token mirrors the companion cookie (D-rr)').toBe(csrfCookie)

  // --- 7: PATCH status to in_progress via the HEADER control (human member —
  // no claim, no lease; the reason input is required by the status route).
  await page.getByPlaceholder('reason (required by the status route)').fill('smoke: start work')
  await page.locator('header button.pill', { hasText: /^in_progress$/ }).click()
  await expect(page.locator('header p span.pill').first()).toHaveText('in_progress')

  // --- 8: negative CSRF from the REAL browser: a raw same-origin fetch WITH
  // the cookie but WITHOUT the header answers the pinned D-rr 403.
  const negative = await page.evaluate(async () => {
    const res = await fetch('/tasks', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ title: 'csrf-negative-e2e', status: 'todo' }),
    })
    return {
      status: res.status,
      body: (await res.json().catch(() => null)) as { code?: string; detail?: string } | null,
    }
  })
  expect(negative.status).toBe(403)
  expect(negative.body).toMatchObject({
    code: 'forbidden',
    detail: 'missing or invalid CSRF token (D-rr)',
  })

  // --- 9: sign out via the nav => /ui/login; then a direct goto of a task
  // deep-link answers 401 and the api.ts bounce lands on the login view.
  await page.locator('nav button.signout').click()
  await page.waitForURL((url) => url.origin === APP_BASE && url.pathname === '/ui/login')
  await expect
    .poll(async () => (await context.cookies()).some((c) => c.name === '__Host-ns_sess'))
    .toBe(false)

  const dead = page.waitForResponse(
    (r) =>
      new URL(r.url()).origin === APP_BASE &&
      new URL(r.url()).pathname === `/tasks/${taskId}` &&
      r.status() === 401
  )
  await page.goto(`${APP_BASE}/ui/tasks/${taskId}`)
  expect((await dead).status()).toBe(401)
  await page.waitForURL((url) => url.origin === APP_BASE && url.pathname === '/ui/login')
})
