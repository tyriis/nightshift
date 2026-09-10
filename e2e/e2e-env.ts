// D-xx §11.5 e2e constants — ONE file so playwright.config.ts, global-setup and
// the smoke see the SAME values. Fresh tmp paths are created at config-load
// time (playwright.config.ts is TS — mkdtemp here is honest); every run boots
// two fresh servers on loopback: the in-repo stub IdP on :3310, the app on :3311.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const STUB_BASE = 'http://127.0.0.1:3310'
export const APP_BASE = 'http://127.0.0.1:3311'

// 64 hex chars — deterministic on purpose (a fresh tmp DB per run, D-j purge +
// empty tables ⇒ the run is DETERMINISTIC). Env-only posture (D-ff): this is an
// e2e throwaway on loopback, never a real secret.
export const BOOTSTRAP_TOKEN = 'e2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee'

export const E2E_TMP_DIR = mkdtempSync(join(tmpdir(), 'nightshift-e2e-'))
/** bootstrap bearer + actor id land OUTSIDE the repo (review note (e)) */
export const TOKEN_FILE = join(E2E_TMP_DIR, 'bootstrap-token.json')

/** The app process env — EXACTLY the Task-11 section's block. */
export const APP_ENV: Record<string, string> = {
  NS_PORT: '3311',
  NS_DB_PATH: join(E2E_TMP_DIR, 'nightshift-e2e.db'),
  NS_DATA_DIR: join(E2E_TMP_DIR, 'data'),
  NS_OIDC_ISSUER: STUB_BASE,
  NS_OIDC_CLIENT_ID: 'nightshift-e2e',
  NS_OIDC_CLIENT_SECRET: 'e2e-secret-not-a-real-one-0001',
  NS_PUBLIC_URL: APP_BASE,
  NS_SESSION_KEY: 'e2e-session-key-0000000000000000000000000',
  NS_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
  NS_WEBHOOK_INTERVAL_MS: '0',
}
