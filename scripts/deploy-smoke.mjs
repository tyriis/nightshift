#!/usr/bin/env node
// deploy-smoke.mjs — the automated, NON-destructive, self-cleaning deploy probes (D-eee).
// Proves on the LIVE instance: reachability, the D-ccc asset story (the served contract
// byte-matches THIS checkout), the /ui cache posture, the auth posture, and the full
// agent lifecycle over the D-kk contract — one machine line per probe.
// The interactive legs (real Pocket ID, browser, allow-list) and the FTS5 arms are
// operator steps: deploy/DEPLOY-SMOKE.md. Residue by design, audit-visible and honest:
// one canceled task + its attachment + the spine. Secrets env-only, never argv (D-ff).
//
// usage: NS_URL=https://board.example NS_TOKEN=<admin-token> node scripts/deploy-smoke.mjs
// exit: 0 every probe PASS · 1 any FAIL · 2 usage.
import { readFile } from 'node:fs/promises'

const BASE = (process.env.NS_URL ?? '').replace(/\/+$/, '')
const TOKEN = process.env.NS_TOKEN ?? ''
const TIMEOUT = Number(process.env.NS_TIMEOUT_MS ?? 15_000)
if (BASE === '' || TOKEN === '') {
  console.error('usage: NS_URL=... NS_TOKEN=... node scripts/deploy-smoke.mjs')
  process.exit(2)
}

let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || detail === '' ? '' : ` — ${detail}`}`)
}
const sha256 = async (text) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
const bodyOf = async (res) => {
  const text = await res.text()
  try {
    return { res, text, json: JSON.parse(text) }
  } catch {
    return { res, text, json: undefined }
  }
}
const json = (method, payload) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
})
// the admin door (bootstrap token, or any human-admin bearer)
const call = async (path, init = {}) =>
  bodyOf(
    await fetch(`${BASE}${path}`, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT),
      headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
    })
  )
const anon = (path, init = {}) =>
  fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT) })

try {
  const stamp = Date.now().toString(36)
  // public surface + the asset story (D-ccc): the served contract IS this checkout
  const ping = await call('/ping')
  check('/ping answers the pong', ping.res.status === 200 && ping.json?.pong === 'it worked!')
  const spec = await call('/openapi.yaml')
  const local = await readFile(new URL('../openapi/openapi.yaml', import.meta.url), 'utf8')
  check(
    'served /openapi.yaml byte-matches the repo contract',
    spec.res.status === 200 && (await sha256(spec.text)) === (await sha256(local))
  )
  // the UI shell, its caching posture, the hashed assets, the SPA fallback
  const shell = await call('/ui/')
  check(
    '/ui/ answers the html shell',
    shell.res.status === 200 && (shell.res.headers.get('content-type') ?? '').includes('text/html')
  )
  check(
    '/ui shell is no-cache',
    (shell.res.headers.get('cache-control') ?? '').includes('no-cache'),
    shell.res.headers.get('cache-control') ?? 'none'
  )
  const asset = (shell.text.match(/["'](\/ui\/[^"']+\.js)["']/) ?? [])[1]
  if (asset === undefined) {
    check('hashed /ui/*.js asset referenced by the shell', false, 'no asset href found')
  } else {
    const head = await anon(asset, { method: 'HEAD' })
    check(
      `hashed asset ${asset.slice(0, 40)}… max-age cached`,
      head.status === 200 && (head.headers.get('cache-control') ?? '').includes('max-age='),
      head.headers.get('cache-control') ?? `status ${head.status}`
    )
  }
  const deep = await anon('/ui/deploy-smoke-deep-link')
  check(
    'SPA deep-link answers the shell 200 html',
    deep.status === 200 && (deep.headers.get('content-type') ?? '').includes('text/html')
  )
  // auth posture: everything that matters is shut without credentials
  check('GET /tasks without a bearer is 401', (await anon('/tasks')).status === 401)
  check(
    'POST /mcp without a bearer is 401 (D-ww)',
    (
      await anon('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    ).status === 401
  )
  // the admin is human-only; the smoke agent gets a token shown once (D-ff)
  const actor = await call(
    '/admin/actors',
    json('POST', {
      kind: 'agent',
      handle: `deploy-smoke-${stamp}`,
      display_name: `Deploy smoke ${stamp}`,
    })
  )
  check('admin creates the smoke agent', actor.res.status === 201, actor.text.slice(0, 160))
  const issued = await call(
    `/admin/actors/${actor.json.id}/tokens`,
    json('POST', { label: `deploy-smoke-${stamp}` })
  )
  check(
    'admin issues the smoke token (shown once)',
    issued.res.status === 201 && typeof issued.json?.raw_token === 'string'
  )
  const agent = issued.json.raw_token
  const agentCall = async (path, init = {}) =>
    bodyOf(
      await fetch(`${BASE}${path}`, {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT),
        headers: { authorization: `Bearer ${agent}`, ...(init.headers ?? {}) },
      })
    )
  check(
    'the agent on /admin/actors is 403 (admin is human-only)',
    (await agentCall('/admin/actors')).res.status === 403
  )
  // the agent lifecycle on the live contract — the §12 spine, self-cleaning
  const created = await agentCall(
    '/tasks',
    json('POST', {
      title: `deploy-smoke ${stamp}`,
      description: `smoke marker ns-smoke-${stamp} — deploy probe`,
      status: 'todo',
    })
  )
  check('agent creates a ready task', created.res.status === 201, created.text.slice(0, 160))
  const id = created.json?.id
  if (typeof id !== 'string')
    throw new Error(`no task id — ${created.res.status} ${created.text.slice(0, 160)}`)
  const claimed = await agentCall(`/tasks/${id}/claim`, { method: 'POST' })
  check(
    'agent claims (lease issued)',
    claimed.res.status === 200 && typeof claimed.json?.lease_token === 'string',
    claimed.text.slice(0, 160)
  )
  const released = await agentCall(`/tasks/${id}/release`, { method: 'POST' })
  check(
    'release answers with the task',
    released.res.status === 200 && released.json?.id === id,
    released.text.slice(0, 160)
  )
  const reclaim = await agentCall(`/tasks/${id}/claim`, { method: 'POST' })
  check(
    're-claim after release works',
    reclaim.res.status === 200 && typeof reclaim.json?.lease_token === 'string'
  )
  const moved = await agentCall(
    `/tasks/${id}/status`,
    json('PATCH', {
      status: 'in_progress',
      reason: 'deploy smoke',
      lease_token: reclaim.json.lease_token,
    })
  )
  check(
    'lease-gated status → in_progress',
    moved.res.status === 200 && moved.json?.status === 'in_progress',
    moved.text.slice(0, 160)
  )
  // the D-gg FTS substrate on the LIVE image (D-rrr): the create INSERT rode the
  // real task_fts triggers; the marker in the description must come back from the
  // D-ppp search contract. The token form is probe-picked (P5): a base36 stamp is a
  // single unicode61 alnum token — the hyphen-marker form needs phrase semantics.
  const found = await agentCall(`/search?q=${stamp}&limit=10`)
  check(
    'search finds the smoke task (FTS5 live)',
    found.res.status === 200 && Array.isArray(found.json) && found.json.some((h) => h.id === id),
    found.text.slice(0, 160)
  )
  const note = await agentCall(
    `/tasks/${id}/threads`,
    json('POST', { kind: 'note', body: `deploy-smoke ${stamp} — agent note on the live board` })
  )
  check('agent posts a thread note', note.res.status === 201, note.text.slice(0, 160))
  const bytes = new TextEncoder().encode(`nightshift deploy-smoke ${stamp}`)
  const uploaded = await fetch(
    `${BASE}/tasks/${id}/attachments?filename=smoke.txt&content_type=text/plain`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${agent}`, 'content-type': 'application/octet-stream' },
      body: bytes,
      signal: AbortSignal.timeout(TIMEOUT),
    }
  )
  const upload = await bodyOf(uploaded)
  check(
    'attachment uploads to the volume (octet-stream)',
    uploaded.status === 201,
    upload.text.slice(0, 160)
  )
  const back = await agentCall(`/attachments/${upload.json?.id}/content`)
  check(
    'attachment content round-trips',
    back.res.status === 200 && back.text.includes(`deploy-smoke ${stamp}`)
  )
  const events = await call('/events?cursor=0&limit=500')
  const cursors = Array.isArray(events.json) ? events.json.map((e) => e.cursor) : []
  check(
    '/events answers the ascending cursor feed',
    events.res.status === 200 &&
      cursors.length > 0 &&
      cursors.every((v, i) => i === 0 || v > cursors[i - 1]),
    `rows ${cursors.length}`
  )
  // cleanup: in_progress does NOT clear the claim (update-status.ts clears on
  // in_review/done/canceled — B2/S2 + D-mmm) — the AGENT releases first (the arm P9 verified
  // claim→move→release→human-cancel = 200), then the HUMAN closes (agents may not);
  // the token goes away; the task + note stay as the honest audit-visible residue
  const released2 = await agentCall(`/tasks/${id}/release`, { method: 'POST' })
  check(
    'agent releases the claim for the human close',
    released2.res.status === 200,
    released2.text.slice(0, 160)
  )
  const canceled = await call(
    `/tasks/${id}/status`,
    json('PATCH', { status: 'canceled', reason: 'deploy smoke cleanup — the human close path' })
  )
  check(
    'human(admin) cancels the smoke task (the §14-6 close path)',
    canceled.res.status === 200 && canceled.json?.status === 'canceled',
    canceled.text.slice(0, 160)
  )
  const revoked = await call(`/admin/tokens/${issued.json.token_id}/revoke`, { method: 'POST' })
  check('smoke token revoked', revoked.res.status === 204)
} catch (err) {
  check(
    'unexpected failure (see detail)',
    false,
    err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  )
}
console.log(failures === 0 ? 'deploy-smoke: ALL PASS' : `deploy-smoke: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
