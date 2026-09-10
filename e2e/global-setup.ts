// D-xx §11.5 global setup: bootstrap-admin API ONLY (bearer to 127.0.0.1:3311 —
// no UI, no real network). Seeds the allow-list with alice@example.com (the
// Task-7 email the stub user carries) and flips oidc_provisioning → 'allowlist'.
// The bootstrap token + actor id go to an os.tmpdir()-routed file OUTSIDE the
// repo (review note (e) — no .tokens.json in the tree). Fail-loud on ANY seed
// failure — a half-seeded run would fake the §11.5 story.
import { writeFileSync } from 'node:fs'
import { APP_BASE, BOOTSTRAP_TOKEN, TOKEN_FILE } from './e2e-env'

const headers = {
  authorization: `Bearer ${BOOTSTRAP_TOKEN}`,
  'content-type': 'application/json',
  accept: 'application/json',
}

const seed = async (label: string, path: string, init: RequestInit): Promise<Response> => {
  const res = await fetch(`${APP_BASE}${path}`, init)
  if (!res.ok) {
    throw new Error(`e2e global-setup: ${label} failed: ${res.status} ${await res.text()}`)
  }
  return res
}

export default async function globalSetup(): Promise<void> {
  // 201 (created) or 200 (already there) — both prove the admin route answered
  await seed('POST /admin/allowlist alice@example.com', '/admin/allowlist', {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: 'alice@example.com' }),
  })
  await seed('PUT /admin/policy/oidc_provisioning allowlist', '/admin/policy/oidc_provisioning', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ value: 'allowlist' }),
  })
  const meRes = await seed('GET /auth/me (bootstrap identity)', '/auth/me', { headers })
  const me = (await meRes.json()) as { id: string; role: string }
  writeFileSync(
    TOKEN_FILE,
    JSON.stringify(
      {
        bootstrapToken: BOOTSTRAP_TOKEN,
        actorId: me.id,
        role: me.role,
        seededAt: new Date().toISOString(),
      },
      null,
      2
    ) + '\n'
  )
  console.warn(`e2e global-setup seeded; token file: ${TOKEN_FILE} (outside the repo)`)
}
