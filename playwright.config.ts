// D-xx §11.5 Playwright smoke config. THE STATED e2e EXCEPTION: the stub IdP runs
// as a REAL-SOCKET server here for the browser's sake (a browser is a network
// actor by definition) — it stays the IN-REPO stub (src/testing/stub-idp-main.ts
// boots the shipped factory), NEVER a real IdP, loopback only. All vitest/tsc/
// eslint surfaces stay byte-untouched: testDir e2e, *.e2e.ts naming, config at
// repo root (eslint ignores *.config.ts; vitest includes src/** only).
import { defineConfig } from '@playwright/test'
import { APP_BASE, APP_ENV, STUB_BASE } from './e2e/e2e-env'

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  globalSetup: './e2e/global-setup',
  reporter: 'list',
  webServer: [
    {
      // the shipped stub factory on a real socket (readiness leg: /ping, added
      // by the runner — see src/testing/stub-idp-main.ts)
      command: 'NODE_OPTIONS=--conditions=development pnpm exec tsx src/testing/stub-idp-main.ts',
      url: `${STUB_BASE}/ping`,
      reuseExistingServer: false,
      stdout: 'pipe',
      timeout: 120_000,
    },
    {
      // the app under test — env EXACTLY the Task-11 section block (fresh tmp
      // DB/data dir created at config-load time; NS_WEBHOOK_INTERVAL_MS 0 kills
      // the delivery loop; NODE_OPTIONS rides the development #root condition)
      command: 'NODE_OPTIONS=--conditions=development pnpm exec tsx src/index.ts',
      url: `${APP_BASE}/ping`,
      env: APP_ENV,
      reuseExistingServer: false,
      stdout: 'pipe',
      timeout: 120_000,
    },
  ],
})
