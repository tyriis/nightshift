# nightshift Plan A — Agent Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A curl-testable nightshift backend: task tree with dependencies, atomic claims with fencing tokens, split, review-gated status transitions, agent-token auth, idempotent writes, RFC 9457 errors, committed OpenAPI 3.1 contract — the agent-side half of spec §14.

**Architecture:** Clean architecture (spec §9) inside a single package: `src/domain` (pure invariants), `src/application` (use-cases + ports), `src/adapters/rest` (Fastify), `src/infra/sqlite` (Kysely + better-sqlite3, WAL), `src/main` (composition root, zod env). Tooling baseline copied from `https://github.com/tyriis/agent-test` (ESM, `#root/*` conditional imports, Node 24, pnpm, vitest, eslint+prettier, lefthook, mise).

**Tech Stack:** TypeScript (nodenext, strict), Node >=24, Fastify 5, Kysely, better-sqlite3, zod, yaml (contract test), vitest 4, fast-check (property tests).

**Spec:** `docs/superpowers/specs/2026-09-05-nightshift-design.md` — Plan A covers §5 (agent actors), §6.1–6.4 (tasks/tree/deps/invariants), §6.7 (audit), §7.2–7.3 (REST core + idempotency), §10 (agent auth), §11 (errors/tests, partial).

**Deliberately NOT in Plan A (later plans):** threads/questions/inbox (Plan B — question gate `open_questions` and `threads_on_parent` error codes exist but are unreachable until B), attachments/links (B), event feed/webhooks/FTS (C), MCP server + generated client (D), OIDC/human auth + UI (E), Docker/homelab deploy (F). Per-actor rate limiting (spec §10, configurable) is a one-hook middleware deferred to Plan B with the other HTTP-surface work; human `admin|member` roles arrive with OIDC in E.

---

## Decision record for this plan (spec-derived interpretations)

Locked here so implementers don't re-litigate:

- **D-a** Claim CAS sets `assignee_id` to claimant and moves `todo → in_progress` atomically. Release/heartbeat require the presented lease token to match the task's current generation.
- **D-b** Lease token is the opaque string `"<task_id>:<generation>"`. Generation bumps on every acquire, release, and split-release; an old token can never validate again.
- **D-c** `PATCH /tasks/{id}/status` on a **claimed** task requires a valid lease token (invariant 3, literal). Consequence: humans cannot change status while a claim is active. To unblock this, agents **auto-release the claim** when transitioning to `in_review` or `done` (audited `"claim released on review"`) — so a human can always close after review (spec §14.6). A human force-release admin endpoint is deferred (no spec requirement in v1).
- **D-d** `POST /split` is exempt from the lease-token requirement (spec §6.2 explicitly handles "parent was claimed"): split releases any claim, bumps generation (invalidating the old token), and audits `"claim released by split"`.
- **D-e** Invariant 3 ("all transitions") applies to **status and claim transitions**, not content edits. `PATCH /tasks/{id}` (title/description/AC/blocked_flag/assignee) is allowed without a token and audited.
- **D-f** Content-patch/re-parent cycle risk is nil in Plan A: `parent_id` is only set at creation, so a `parent_id` cycle is structurally impossible (invariant 7 holds by construction). Re-parenting endpoint is not built (YAGNI).
- **D-g** Review gate is a workspace policy flag `review_gate` (`on|off`, default `on`) in a `policy` table, admin-adjustable (spec §7.2 "policy flags").
- **D-h** Plan A authorization: bootstrap admin (human, from env token) + humans created by admin. `admin` vs `member` roles arrive with OIDC in Plan E; **admin endpoints require actor kind `human`**. Agent tokens can never call `/admin/*`.
- **D-i** `position` is a REAL (fractional sibling order; append = max+1). Public `NS-nn` short keys are cosmetic and deferred.
- **D-j** Idempotency: `Idempotency-Key` header on POST/PATCH/PUT/DELETE; stored `{key → (status, body)}` per actor; concurrent duplicate gets `409 idempotency_in_flight`; 5xx responses **delete** the reservation so retries actually re-execute. Crash-window recovery (Task 6 review): at server startup, unresolved reservations (`status IS NULL`) are purged — a fresh process can have nothing legitimately in flight, so no TTL/age policy is needed. Task 13 pins from that review: middleware normalizes `payload ?? ''` (204s must complete, not strand the key); same-actor cross-endpoint key replay is accepted D-j semantics (`request_method`/`request_path` are provenance only); binary/attachment responses never flow through JSON replay (attachments are Plan B's separate route).
- **D-k** OpenAPI is **hand-written `openapi/openapi.yaml` as the contract** (spec: "committed spec diff = API change"); a contract test asserts the Fastify route table matches the spec's path×method set exactly. No swagger codegen in Plan A.
- **D-l** Heartbeats are audited (audit is the system's memory, §6.7).

## File structure (target, after all tasks)

```
openapi/openapi.yaml            committed API contract (Task 17)
src/
  index.ts                      env → deps → app → listen, graceful shutdown (Task 13)
  main/
    config.ts                   zod env schema + loadConfig (Task 3)
    deps.ts                     buildDeps: db, migrate, uow, clock, ids, use-cases (Task 13)
  domain/                       pure TS, no outer imports
    errors.ts                   DomainError + stable codes + status map (Task 2)
    task.ts                     TaskStatus, TaskRecord, TaskDraft, ActorKind (Task 2)
    claim.ts                    lease token format/parse (Task 2)
    ready.ts                    ready() predicate (Task 2)
  application/
    ports.ts                    Clock, IdGen, ActorRef, repo interfaces, UnitOfWork (Task 4)
    usecases/
      create-task.ts update-task.ts split-task.ts update-status.ts (Tasks 7–9)
      claim-task.ts release-claim.ts heartbeat.ts (Task 10)
      add-block.ts remove-block.ts (Task 11)
      get-next.ts get-context.ts (Task 12)
      manage-actors.ts          CreateAgent, CreateToken, RevokeToken, ensure-bootstrap (Task 13)
      manage-policy.ts          GetPolicy, SetPolicy (Task 13)
  adapters/rest/
    app.ts                      buildApp(deps): FastifyInstance (Task 1→13)
    problem.ts                  RFC 9457 error/not-found handlers (Task 13)
    auth.ts                     bearer middleware + humanOnly guard (Task 13)
    idempotency.ts              idempotency hooks (Task 14)
    routes/
      tasks.ts                  CRUD + status + split + context + next (Task 15)
      dependencies.ts labels.ts   blocks + labels (Task 16)
      admin.ts                  agents, tokens, policy, actors (Task 16)
      audit.ts                  audit search (Task 16)
    openapi-contract.test.ts    spec ⇄ routes drift test (Task 17)
  infra/
    clock.ts ids.ts token-hash.ts (Task 3)
    sqlite/
      schema.ts db.ts migrations.ts (Task 3)
      task-repo.ts audit-repo.ts (Task 4)
      uow.ts dependency-repo.ts label-repo.ts actor-repo.ts (Task 5)
      idempotency-store.ts (Task 6)
  testing/
    test-app.ts                 ephemeral app + seeded admin token helper (Task 13)
  app.ts                        ping-only buildApp seed, extended by Task 13 (Task 1)
```

Conventions for every task: run `pnpm test <file>` for red/green checks, `pnpm lint && pnpm typecheck` before commit, commit messages in conventional-commit style. All timestamps are ISO-8601 strings (UTC). All tests colocated `*.test.ts`.

---

### Task 1: Project scaffold from agent-test baseline

**Files:**

- Create: `package.json`, `pnpm-workspace.yaml`, `.mise.toml`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, `.prettierrc`, `.prettierignore`, `.editorconfig`, `.gitignore`, `lefthook.yaml`
- Create: `.github/workflows/ci.yaml`, `LICENSE`
- Create: `src/app.ts`, `src/app.test.ts`

- [ ] **Step 1.1: Create `package.json`** (deps added here so later tasks don't touch it again):

```json
{
  "name": "nightshift",
  "version": "0.1.0",
  "description": "Self-hosted task board where humans and AI agents are first-class actors",
  "type": "module",
  "license": "Apache-2.0",
  "imports": {
    "#root/*": {
      "development": "./src/*.ts",
      "default": "./dist/*.js"
    }
  },
  "main": "dist/index.js",
  "scripts": {
    "clean": "rm -rf dist",
    "dev": "NODE_OPTIONS=--conditions=development tsx watch src/index.ts",
    "start:dev": "NODE_OPTIONS=--conditions=development tsx src/index.ts",
    "build": "pnpm run clean && tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "lint": "eslint src",
    "lint:fix": "eslint src --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  },
  "packageManager": "pnpm@10.33.0",
  "engines": {
    "node": ">=24.0.0",
    "pnpm": ">=10.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "9.6.0",
    "@types/node": "24.13.3",
    "@typescript-eslint/eslint-plugin": "8.58.2",
    "@typescript-eslint/parser": "8.58.2",
    "@vitest/coverage-v8": "^4.1.5",
    "eslint": "10.2.0",
    "eslint-config-prettier": "10.1.8",
    "fast-check": "^4.2.0",
    "prettier": "3.8.3",
    "tsx": "4.21.0",
    "typescript": "6.0.3",
    "vitest": "^4.1.5",
    "yaml": "^2.9.0"
  },
  "dependencies": {
    "better-sqlite3": "13.0.3",
    "fastify": "5.12.3",
    "kysely": "0.29.5",
    "zod": "4.5.4"
  }
}
```

> **Versions verified 2026-09-06** against the live npm registry with an install + strict-typecheck probe (Node ESM), then re-verified in this repo: better-sqlite3 13.0.3 (N-API prebuilds; pnpm still requires the `onlyBuiltDependencies` approval entry — see workspace file note), kysely 0.29.5 (**migration symbols import from `kysely/migration`, root re-exports are deprecated type-error stubs**; do not use the `0.30.0-beta` on tag `next`), zod 4.5.4, fastify 5.12.3 (supersedes agent-test's 5.8.5), typescript 6.0.3, @types/node 24.13.3. Remaining pins match `tyriis/agent-test` verbatim.

- [ ] **Step 1.2: Create root config files.**

`pnpm-workspace.yaml`:

```yaml
onlyBuiltDependencies:
  - esbuild
  - better-sqlite3
```

(pnpm 10+ blocks dependency build scripts unless explicitly approved — empirically verified on this repo: without the `better-sqlite3` entry pnpm silently ignores its install script and no native binding lands, breaking Task 3 on every clean checkout. If the entry ever turns out unnecessary on a future version, the symptom is `Cannot find module ... better_sqlite3.node`.)

`.mise.toml`:

```toml
[tools]
node = "24"
pnpm = "10.33.0"
direnv = "2.37.1"
lefthook = "2.1.6"
```

(node pinned to the CI/engines floor so local runs exercise the same major the pipeline tests. better-sqlite3 is N-API → its prebuilt binding is ABI-stable across majors; after switching run `pnpm install`.)

`tsconfig.json` (from agent-test verbatim):

```json
{
  "compilerOptions": {
    "target": "ES2025",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "paths": {
      "#root/*": ["./src/*"]
    },
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "types": ["node"],
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "resolveJsonModule": true,
    "sourceMap": true,
    "noImplicitAny": true
  },
  "include": ["src"]
}
```

`vitest.config.ts` (agent-test base; domain keeps 100%, global floor 85%):

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '#root': new URL('./src', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'coverage/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/testing/**'],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 85,
        statements: 85,
        '**/src/domain/**': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
      },
    },
  },
})
```

`eslint.config.js`, `.prettierrc`, `.prettierignore`, `.editorconfig`, `.gitignore` — copy verbatim from the cloned reference (`/tmp/opencode/agent-test` if still present, else `git clone --depth 1 https://github.com/tyriis/agent-test /tmp/agent-test && cp ...`), **except** write `.gitignore` as exactly:

```
node_modules/
dist/
coverage/
*.db
*.db-shm
*.db-wal
.env
.env.*
```

and `.prettierignore` as exactly:

```
dist
coverage
pnpm-lock.yaml
```

`lefthook.yaml` (agent-test verbatim):

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/evilmartians/lefthook/master/schema.json
pre-commit:
  parallel: false
  commands:
    format:
      run: pnpm exec prettier --write {staged_files}
      stage_fixed: true
    lint:
      glob: src/**/*.ts
      run: pnpm exec eslint --fix {staged_files}
      stage_fixed: true
    test:
      glob: src/**/*.ts
      run: pnpm test

pre-push:
  parallel: false
  commands:
    typecheck:
      run: pnpm typecheck
    test-coverage:
      run: pnpm test:coverage
```

`.github/workflows/ci.yaml`:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
```

(`pnpm build` guards the production half of the `#root/*` import map — `dist/*.js` default condition — which lint/test never touch.)

- [ ] **Step 1.3: Fetch the Apache-2.0 license.**

```bash
curl -fsSL https://www.apache.org/licenses/LICENSE-2.0.txt -o LICENSE
head -1 LICENSE
```

Expected: `                                 Apache License`

- [ ] **Step 1.4: Write the failing ping test** `src/app.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildApp } from '#root/app'

describe('app', () => {
  it('answers ping', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/ping' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ pong: 'it worked!' })
    await app.close()
  })
})
```

- [ ] **Step 1.5: Install and verify red.**

```bash
pnpm install && pnpm test src/app.test.ts
```

Expected: FAIL — `Cannot find module '#root/app'`.

- [ ] **Step 1.6: Implement `src/app.ts`** (agent-test pattern; deps are threaded in at Task 13):

```ts
import Fastify, { FastifyInstance } from 'fastify'

export const buildApp = (opts: { logger?: boolean } = {}): FastifyInstance => {
  const server: FastifyInstance = Fastify({ logger: opts.logger ?? false })

  server.get('/ping', async () => {
    return { pong: 'it worked!' }
  })

  return server
}
```

- [ ] **Step 1.7: Verify green + hygiene.**

```bash
pnpm test src/app.test.ts && pnpm lint && pnpm typecheck
```

Expected: 1 test passed; lint/typecheck silent success.

- [ ] **Step 1.8: Commit** (lefthook hooks activate on first commit — run `git config core.hooksPath .git/hooks; lefthook install` first if lefthook is on PATH):

```bash
git add -A
git commit -m "chore: scaffold project tooling from agent-test baseline"
```

---

### Task 2: Domain core — errors, task types, lease tokens, ready predicate

**Files:**

- Create: `src/domain/errors.ts`, `src/domain/task.ts`, `src/domain/claim.ts`, `src/domain/ready.ts`
- Test: `src/domain/claim.test.ts`, `src/domain/ready.test.ts`

- [ ] **Step 2.1: Write failing lease-token tests** `src/domain/claim.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { formatLeaseToken, parseLeaseToken } from '#root/domain/claim'

describe('lease tokens', () => {
  it('round-trips', () => {
    const ref = parseLeaseToken(formatLeaseToken('t_abc', 7))
    expect(ref).toEqual({ taskId: 't_abc', generation: 7 })
  })

  it('rejects missing separator', () => {
    expect(parseLeaseToken('t_abc')).toBeNull()
  })

  it('rejects non-numeric generation', () => {
    expect(parseLeaseToken('t_abc:x')).toBeNull()
  })

  it('rejects negative generation', () => {
    expect(parseLeaseToken('t_abc:-1')).toBeNull()
  })

  it('rejects float generation', () => {
    expect(parseLeaseToken('t_abc:1.5')).toBeNull()
  })
})
```

- [ ] **Step 2.2: Run to verify failure.**

```bash
pnpm test src/domain/claim.test.ts
```

Expected: FAIL — cannot find `#root/domain/claim`.

- [ ] **Step 2.3: Implement `src/domain/claim.ts`:**

```ts
export interface LeaseTokenRef {
  taskId: string
  generation: number
}

export const formatLeaseToken = (taskId: string, generation: number): string =>
  `${taskId}:${generation}`

export const parseLeaseToken = (raw: unknown): LeaseTokenRef | null => {
  if (typeof raw !== 'string') return null
  const idx = raw.lastIndexOf(':')
  if (idx <= 0) return null
  const taskId = raw.slice(0, idx)
  const gen = raw.slice(idx + 1)
  if (!/^\d+$/.test(gen)) return null
  return { taskId, generation: Number(gen) }
}
```

- [ ] **Step 2.4: Run to verify green.** `pnpm test src/domain/claim.test.ts` → 5 passed.

- [ ] **Step 2.5: Write failing ready-predicate tests** `src/domain/ready.test.ts` (spec §6.3 `ready()`; table + fast-check property):

```ts
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { isTaskReady, type ReadyCandidate } from '#root/domain/ready'

const base: ReadyCandidate = {
  status: 'todo',
  blocked_flag: false,
  child_count: 0,
  claim_holder: false,
  unmet_blockers: 0,
}

describe('ready predicate (spec 6.3)', () => {
  it('base candidate is ready', () => {
    expect(isTaskReady(base)).toBe(true)
  })

  it.each([
    ['wrong status', { status: 'backlog' } as const],
    ['blocked flag', { blocked_flag: true } as const],
    ['has children', { child_count: 1 } as const],
    ['claimed', { claim_holder: true } as const],
    ['unmet blockers', { unmet_blockers: 2 } as const],
  ])('not ready when %s', (_name, patch) => {
    expect(isTaskReady({ ...base, ...patch })).toBe(false)
  })

  it('property: ready implies every gate is clear', () => {
    fc.assert(
      fc.property(
        fc.record({
          status: fc.constantFrom(
            'backlog',
            'todo',
            'in_progress',
            'in_review',
            'done',
            'canceled'
          ),
          blocked_flag: fc.boolean(),
          child_count: fc.nat(4),
          claim_holder: fc.boolean(),
          unmet_blockers: fc.nat(4),
        }),
        (c) =>
          isTaskReady(c) ===
          (c.status === 'todo' &&
            !c.blocked_flag &&
            c.child_count === 0 &&
            !c.claim_holder &&
            c.unmet_blockers === 0)
      )
    )
  })
})
```

- [ ] **Step 2.6: Verify red** (`pnpm test src/domain/ready.test.ts`), then **implement `src/domain/ready.ts`:**

```ts
import type { TaskStatus } from '#root/domain/task'

export interface ReadyCandidate {
  status: TaskStatus
  blocked_flag: boolean
  child_count: number
  claim_holder: boolean
  unmet_blockers: number
}

export const isTaskReady = (t: ReadyCandidate): boolean =>
  t.status === 'todo' &&
  !t.blocked_flag &&
  t.child_count === 0 &&
  !t.claim_holder &&
  t.unmet_blockers === 0
```

- [ ] **Step 2.7: Implement `src/domain/task.ts`:**

```ts
export const TASK_STATUSES = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'canceled',
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export type ActorKind = 'human' | 'agent'

export interface TaskRecord {
  id: string
  parent_id: string | null
  title: string
  description: string
  acceptance_criteria: string
  status: TaskStatus
  blocked_flag: boolean
  assignee_id: string | null
  position: number
  created_by: string
  created_at: string
  updated_at: string
  claim_token_id: string | null
  claim_generation: number
  last_heartbeat_at: string | null
}

export interface TaskDraft {
  id: string
  parent_id: string | null
  title: string
  description: string
  acceptance_criteria: string
  status: TaskStatus
  position: number
  created_by: string
  created_at: string
  updated_at: string
}
```

- [ ] **Step 2.8: Implement `src/domain/errors.ts`:**

```ts
export type DomainErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'invalid_request'
  | 'handle_taken'
  | 'already_claimed'
  | 'not_a_leaf'
  | 'open_descendants'
  | 'stale_lease'
  | 'dependency_cycle'
  | 'agent_close_forbidden'
  | 'open_questions'
  | 'threads_on_parent'
  | 'idempotency_in_flight'

const DOMAIN_ERROR_STATUS: Record<DomainErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  invalid_request: 400,
  handle_taken: 409,
  already_claimed: 409,
  not_a_leaf: 409,
  open_descendants: 409,
  stale_lease: 412,
  dependency_cycle: 409,
  agent_close_forbidden: 403,
  open_questions: 409,
  threads_on_parent: 409,
  idempotency_in_flight: 409,
}

export class DomainError extends Error {
  readonly status: number
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'DomainError'
    this.status = DOMAIN_ERROR_STATUS[code]
  }
}

export const isDomainError = (e: unknown): e is DomainError => e instanceof DomainError
```

- [ ] **Step 2.9: Verify all green + hygiene.** `pnpm test && pnpm lint && pnpm typecheck` → all pass.

- [ ] **Step 2.10: Commit.** `git add -A && git commit -m "feat(domain): task types, stable error codes, lease tokens, ready predicate"`

---

### Task 3: Infra foundations — env config, clock, ids, token hashing, SQLite db + migrations

**Files:**

- Create: `src/main/config.ts`, `src/infra/clock.ts`, `src/infra/ids.ts`, `src/infra/token-hash.ts`, `src/infra/sqlite/schema.ts`, `src/infra/sqlite/db.ts`, `src/infra/sqlite/migrations.ts`
- Test: `src/main/config.test.ts`, `src/infra/ids.test.ts`, `src/infra/token-hash.test.ts`, `src/infra/sqlite/migrations.test.ts`

- [ ] **Step 3.1: Write failing config tests** `src/main/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { loadConfig } from '#root/main/config'

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig({})).toEqual({
      port: 3123,
      dbPath: './nightshift.db',
      bootstrapToken: undefined,
    })
  })

  it('coerces numeric port', () => {
    expect(loadConfig({ NS_PORT: '8080' }).port).toBe(8080)
  })

  it('rejects non-numeric port', () => {
    expect(() => loadConfig({ NS_PORT: 'abc' })).toThrow(/invalid env/)
  })

  it('rejects empty-string port (zod coerce gotcha)', () => {
    expect(() => loadConfig({ NS_PORT: '' })).toThrow(/invalid env/)
  })

  it('rejects short bootstrap token', () => {
    expect(() => loadConfig({ NS_BOOTSTRAP_TOKEN: 'short' })).toThrow(/invalid env/)
  })
})
```

- [ ] **Step 3.2: Verify red** (`pnpm test src/main/config.test.ts`), then **implement `src/main/config.ts`:**

```ts
import { z } from 'zod'

const EnvSchema = z.object({
  NS_PORT: z.coerce.number().int().min(1024).max(65535).default(3123),
  NS_DB_PATH: z.string().min(1).default('./nightshift.db'),
  NS_BOOTSTRAP_TOKEN: z.string().min(32).optional(),
})

export interface Config {
  port: number
  dbPath: string
  bootstrapToken?: string
}

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const r = EnvSchema.safeParse(env)
  if (!r.success) {
    throw new Error(`invalid env: ${JSON.stringify(z.treeifyError(r.error))}`)
  }
  return {
    port: r.data.NS_PORT,
    dbPath: r.data.NS_DB_PATH,
    bootstrapToken: r.data.NS_BOOTSTRAP_TOKEN,
  }
}
```

- [ ] **Step 3.3: Write failing ids/token-hash tests.**

`src/infra/ids.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { RandomIdGen } from '#root/infra/ids'

describe('RandomIdGen', () => {
  const gen = new RandomIdGen()

  it('prefixes ids with the entity tag', () => {
    expect(gen.newId('t')).toMatch(/^t_[a-z0-9]{16}$/)
  })

  it('never repeats across 1000 draws', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) seen.add(gen.newId('t'))
    expect(seen.size).toBe(1000)
  })
})
```

`src/infra/token-hash.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { generateRawToken, hashToken } from '#root/infra/token-hash'

describe('token hashing (spec §5: SHA-256 of high-entropy input)', () => {
  it('matches the sha256 test vector', () => {
    expect(hashToken('a')).toBe('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb')
  })

  it('generates url-safe 256-bit tokens', () => {
    const tok = generateRawToken()
    expect(tok).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(new Set(Array.from({ length: 100 }, () => generateRawToken())).size).toBe(100)
  })
})
```

- [ ] **Step 3.4: Implement `src/infra/clock.ts`, `src/infra/ids.ts`, `src/infra/token-hash.ts`:**

```ts
export class SystemClock {
  now(): Date {
    return new Date()
  }
}

export const isoNow = (clock: { now(): Date } = new SystemClock()): string =>
  clock.now().toISOString()
```

```ts
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

export class RandomIdGen {
  newId(prefix: string): string {
    // WebCrypto has NO randomBytes() — verified on Node 26.8: globalThis.crypto.randomBytes is
    // undefined. getRandomValues is the CSPRNG that exists; fill a Uint8Array directly.
    const bytes = new Uint8Array(16)
    globalThis.crypto.getRandomValues(bytes)
    let out = ''
    for (const b of bytes) out += ALPHABET[b % ALPHABET.length]
    return `${prefix}_${out}`
  }
}
```

(`src/infra/clock.ts` = only the `SystemClock`+`isoNow` block; `src/infra/ids.ts` = the `RandomIdGen` block.)

```ts
import { createHash, randomBytes } from 'node:crypto'

export const hashToken = (raw: string): string => createHash('sha256').update(raw).digest('hex')

export const generateRawToken = (): string => randomBytes(32).toString('base64url')
```

- [ ] **Step 3.5: Verify green** for all three test files.

- [ ] **Step 3.6: Write failing migration test** `src/infra/sqlite/migrations.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { makeDb } from '#root/infra/sqlite/db'
import { migrateToLatest } from '#root/infra/sqlite/migrations'

const TABLES = [
  'actors',
  'tokens',
  'tasks',
  'dependencies',
  'labels',
  'task_labels',
  'audit_log',
  'policy',
  'idempotency_keys',
]

describe('migrations', () => {
  it('creates all tables', async () => {
    const db = makeDb(':memory:')
    await migrateToLatest(db)
    // 'sqlite%' filter required: the autoincrement columns in the migration itself create
    // SQLite's internal sqlite_sequence table, which would otherwise fail this assertion.
    const rows = await sql<{ name: string }>`
      select name from sqlite_master
       where type = 'table' and name not like 'kysely%' and name not like 'sqlite%'
    `.execute(db)
    const names = rows.rows.map((r) => r.name).sort()
    expect(names).toEqual([...TABLES].sort())
    await db.destroy()
  })

  it('is idempotent', async () => {
    const db = makeDb(':memory:')
    await migrateToLatest(db)
    await migrateToLatest(db) // second run must not throw
    await db.destroy()
  })

  it('seeds review_gate policy on', async () => {
    const db = makeDb(':memory:')
    await migrateToLatest(db)
    const r = await sql<{
      value: string
    }>`select value from policy where key = 'review_gate'`.execute(db)
    expect(r.rows[0]?.value).toBe('on')
    await db.destroy()
  })

  it('enforces foreign keys', async () => {
    const db = makeDb(':memory:')
    await migrateToLatest(db)
    await expect(
      sql`insert into tasks (id, title, position, created_by, created_at, updated_at)
          values ('t_x', 'x', 1, 'a_missing', '2026-01-01', '2026-01-01')`.execute(db)
    ).rejects.toThrow(/FOREIGN KEY|foreign key/i)
    await db.destroy()
  })

  // Constraint-contract tests: pin the CHECK/unique/index guarantees that later
  // use-cases and repos rely on, so a silent DDL edit in a future migration fails CI.
  const seedActorAndTask = async (db: ReturnType<typeof makeDb>): Promise<void> => {
    await sql`insert into actors (id, kind, handle, display_name, description, created_at)
              values ('a_x','human','x','X','','2026-01-01')`.execute(db)
    await sql`insert into tasks (id, title, position, created_by, created_at, updated_at)
              values ('t_x','x',1,'a_x','2026-01-01','2026-01-01')`.execute(db)
  }

  it('rejects invalid status, self-edges, duplicate handles, non-boolean flags', async () => {
    const db = makeDb(':memory:')
    await migrateToLatest(db)
    await seedActorAndTask(db)
    await expect(
      sql`insert into tasks (id, title, position, status, created_by, created_at, updated_at)
          values ('t_bad','x',1,'shipped','a_x','2026-01-01','2026-01-01')`.execute(db)
    ).rejects.toThrow(/CHECK|check/i)
    await expect(
      sql`insert into dependencies (blocker_id, blocked_id) values ('t_x','t_x')`.execute(db)
    ).rejects.toThrow(/CHECK|check/i)
    await expect(
      sql`insert into actors (id, kind, handle, display_name, description, created_at)
          values ('a_y','agent','x','Y','','2026-01-01')`.execute(db)
    ).rejects.toThrow(/UNIQUE/i)
    await expect(
      sql`insert into tasks (id, title, position, blocked_flag, created_by, created_at, updated_at)
          values ('t_flag','x',1,2,'a_x','2026-01-01','2026-01-01')`.execute(db)
    ).rejects.toThrow(/CHECK|check/i)
    await db.destroy()
  })

  it('indexes the hot dependency and audit query paths', async () => {
    const db = makeDb(':memory:')
    await migrateToLatest(db)
    const r = await sql<{ name: string }>`
      select name from sqlite_master
       where type = 'index'
         and name in ('dependencies_blocked_idx', 'audit_log_entity_idx')
    `.execute(db)
    expect(r.rows.map((x) => x.name).sort()).toEqual([
      'audit_log_entity_idx',
      'dependencies_blocked_idx',
    ])
    await db.destroy()
  })
})
```

- [ ] **Step 3.7: Implement `src/infra/sqlite/schema.ts`** (all columns inserted explicitly by repos; only autoincrement ids are `Generated`):

```ts
import type { Generated } from 'kysely'
import type { ActorKind, TaskStatus } from '#root/domain/task'

export interface ActorsTable {
  id: string
  kind: ActorKind
  handle: string
  display_name: string
  description: string
  created_at: string
}

export interface TokensTable {
  id: string
  actor_id: string
  token_hash: string
  label: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

export interface TasksTable {
  id: string
  parent_id: string | null
  title: string
  description: string
  acceptance_criteria: string
  status: TaskStatus
  blocked_flag: number
  assignee_id: string | null
  position: number
  created_by: string
  created_at: string
  updated_at: string
  claim_token_id: string | null
  claim_generation: number
  last_heartbeat_at: string | null
}

export interface DependenciesTable {
  id: Generated<number>
  blocker_id: string
  blocked_id: string
}

export interface LabelsTable {
  id: string
  name: string
  color: string
  created_at: string
}

export interface TaskLabelsTable {
  task_id: string
  label_id: string
}

export interface AuditLogTable {
  id: Generated<number>
  actor_id: string | null
  token_id: string | null
  action: string
  entity_type: string
  entity_id: string
  before_json: string | null
  after_json: string | null
  reason: string | null
  created_at: string
}

export interface PolicyTable {
  key: string
  value: string
}

export interface IdempotencyKeysTable {
  actor_id: string
  idem_key: string
  request_method: string
  request_path: string
  status: number | null
  body: string | null
  created_at: string
}

export interface DB {
  actors: ActorsTable
  tokens: TokensTable
  tasks: TasksTable
  dependencies: DependenciesTable
  labels: LabelsTable
  task_labels: TaskLabelsTable
  audit_log: AuditLogTable
  policy: PolicyTable
  idempotency_keys: IdempotencyKeysTable
}
```

- [ ] **Step 3.8: Implement `src/infra/sqlite/db.ts`:**

```ts
import Database from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import type { DB } from '#root/infra/sqlite/schema'

export const makeDb = (path: string): Kysely<DB> => {
  const sqlite = new Database(path)
  sqlite.pragma('foreign_keys = ON')
  if (path !== ':memory:') {
    sqlite.pragma('journal_mode = WAL')
  }
  sqlite.pragma('busy_timeout = 5000')
  return new Kysely<DB>({ dialect: new SqliteDialect({ database: sqlite }) })
}
```

- [ ] **Step 3.9: Implement `src/infra/sqlite/migrations.ts`.** API trap (verified): `Migrator`, `Migration`, `MigrationProvider` import from **`kysely/migration`** — the root `kysely` re-exports are type-error stubs in 0.29.x. `MigrationProvider` has exactly one member (`getMigrations`); no `getLock`. `down` omitted intentionally (v1, append-only schema).

Lint adaptations (verified): the type-checked eslint config (`no-explicit-any`, `require-await`, `only-throw-error`) forces `Kysely<DB>` instead of `Kysely<any>`, a non-`async` `getMigrations` returning `Promise.resolve(...)`, and wrapping a non-`Error` migrator rejection before throwing.

```ts
import { sql, type Kysely } from 'kysely'
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration'
import type { DB } from '#root/infra/sqlite/schema'

const migrations: Record<string, Migration> = {
  '2026-09-06_init': {
    up: async (db: Kysely<DB>) => {
      await sql`create table actors (
        id text primary key,
        kind text not null check (kind in ('human','agent')),
        handle text not null unique,
        display_name text not null,
        description text not null default '',
        created_at text not null
      )`.execute(db)

      await sql`create table tokens (
        id text primary key,
        actor_id text not null references actors(id),
        token_hash text not null unique,
        label text not null,
        created_at text not null,
        last_used_at text,
        revoked_at text
      )`.execute(db)

      await sql`create table tasks (
        id text primary key,
        parent_id text references tasks(id),
        title text not null,
        description text not null default '',
        acceptance_criteria text not null default '',
        status text not null default 'backlog'
          check (status in ('backlog','todo','in_progress','in_review','done','canceled')),
        blocked_flag integer not null default 0 check (blocked_flag in (0,1)),
        assignee_id text references actors(id),
        position real not null,
        created_by text not null references actors(id),
        created_at text not null,
        updated_at text not null,
        claim_token_id text references tokens(id),
        claim_generation integer not null default 0,
        last_heartbeat_at text
      )`.execute(db)
      await sql`create index tasks_parent_idx on tasks (parent_id)`.execute(db)
      await sql`create index tasks_status_idx on tasks (status)`.execute(db)

      await sql`create table dependencies (
        id integer primary key autoincrement,
        blocker_id text not null references tasks(id),
        blocked_id text not null references tasks(id),
        unique (blocker_id, blocked_id),
        check (blocker_id <> blocked_id)
      )`.execute(db)
      -- blocked_id-leading index: wouldCycle CTE, unmetBlockers, the unmet-blocker correlated
      -- subqueries and listReady's NOT EXISTS all filter by blocked_id alone (EXPLAIN-verified:
      -- without it each is a full SCAN per candidate — get-next is the hot agent-poll path).
      await sql`create index dependencies_blocked_idx on dependencies (blocked_id)`.execute(db)

      await sql`create table labels (
        id text primary key,
        name text not null unique,
        color text not null default '#888888',
        created_at text not null
      )`.execute(db)

      await sql`create table task_labels (
        task_id text not null references tasks(id),
        label_id text not null references labels(id),
        primary key (task_id, label_id)
      )`.execute(db)

      await sql`create table audit_log (
        id integer primary key autoincrement,
        actor_id text,
        token_id text,
        action text not null,
        entity_type text not null,
        entity_id text not null,
        before_json text,
        after_json text,
        reason text,
        created_at text not null
      )`.execute(db)
      -- entity_id index: audit is never purged (spec §6.7) and every entity/activity-tab read
      -- filters entity_id order by id desc (EXPLAIN-verified: SCAN without this).
      await sql`create index audit_log_entity_idx on audit_log (entity_id)`.execute(db)

      await sql`create table policy (key text primary key, value text not null)`.execute(db)
      await sql`insert into policy (key, value) values ('review_gate', 'on')`.execute(db)

      await sql`create table idempotency_keys (
        actor_id text not null,
        idem_key text not null,
        request_method text not null,
        request_path text not null,
        status integer,
        body text,
        created_at text not null,
        primary key (actor_id, idem_key)
      )`.execute(db)
    },
  },
}

class InCodeMigrationProvider implements MigrationProvider {
  getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve(migrations)
  }
}

export const migrateToLatest = async (db: Kysely<DB>): Promise<void> => {
  const { error } = await new Migrator({
    db,
    provider: new InCodeMigrationProvider(),
  }).migrateToLatest()
  if (error) throw error instanceof Error ? error : new Error('migration failed', { cause: error })
}
```

- [ ] **Step 3.10: Verify green** (`pnpm test src/infra` → all pass) then **full suite + hygiene + commit:**

```bash
pnpm test && pnpm lint && pnpm typecheck
git add -A && git commit -m "feat(infra): sqlite schema, in-code kysely migrations, env config, ids, token hashing"
```

---

### Task 4: Application ports + audit and task repositories

> **Amendment (oracle ruling A, 2026-09-06):** spec §6.3 `ready()` has **no parent-status gate** —
> a todo leaf under a live parent IS ready (required for the §7.4/§14 discovery flow: split children
> must be discoverable while the parent is in progress). The original Task-4 and Task-12 test fixtures
> had slips asserting the opposite; both are amended inline in this file. The committed `task-repo.ts`
> additionally renders the raw predicates as typed `sql<SqlBool>` consts (`isLeaf`, `noUnmetBlockers`,
> `hasLabel(label)`) passed bare to `.where()`, and uses `.selectAll('tasks')` instead of `sql<TaskRow>`
> aliases (SQLite rejects `… as task`) — semantics identical to the blocks below.

**Files:**

- Create: `src/application/ports.ts`, `src/infra/sqlite/audit-repo.ts`, `src/infra/sqlite/task-repo.ts`, `src/testing/fixtures.ts`
- Test: `src/infra/sqlite/audit-repo.test.ts`, `src/infra/sqlite/task-repo.test.ts`

- [ ] **Step 4.1: Implement `src/application/ports.ts`** (the seam for the later Postgres swap, spec §9):

```ts
import type { ActorKind, TaskDraft, TaskRecord, TaskStatus } from '#root/domain/task'

export interface Clock {
  now(): Date
}

export interface IdGen {
  newId(prefix: string): string
}

export interface ActorRef {
  id: string
  kind: ActorKind
  handle: string
  display_name: string
}

// ---- audit

export interface AuditEntryDraft {
  actor_id: string | null
  token_id: string | null
  action: string
  entity_type: string
  entity_id: string
  before?: unknown
  after?: unknown
  reason?: string
  created_at: string
}

export interface AuditRow {
  id: number
  actor_id: string | null
  token_id: string | null
  action: string
  entity_type: string
  entity_id: string
  before: unknown
  after: unknown
  reason: string | null
  created_at: string
}

export interface AuditRepo {
  append(entry: AuditEntryDraft): Promise<void>
  search(q: { entity_type?: string; entity_id?: string; limit: number }): Promise<AuditRow[]>
}

// ---- tasks

export interface TaskWithCounts {
  task: TaskRecord
  child_count: number
  unmet_blockers: number
}

export interface TaskPatch {
  title?: string
  description?: string
  acceptance_criteria?: string
  blocked_flag?: boolean
  assignee_id?: string | null
}

export interface TaskRepo {
  create(draft: TaskDraft): Promise<TaskRecord>
  findById(id: string): Promise<TaskRecord | null>
  findWithCounts(id: string): Promise<TaskWithCounts | null>
  listAllWithCounts(): Promise<TaskWithCounts[]>
  listReady(filter: { label?: string; limit: number }): Promise<TaskWithCounts[]>
  patch(id: string, patch: TaskPatch, updated_at: string): Promise<void>
  setStatus(id: string, status: TaskStatus, updated_at: string): Promise<void>
  hasChildren(id: string): Promise<boolean>
  countOpenDescendants(id: string): Promise<number>
  nextPosition(parentId: string | null): Promise<number>
  /** Atomic CAS: succeeds only if unclaimed. `status` is the new status computed by the use-case. */
  tryClaim(
    taskId: string,
    tokenId: string,
    claimantActorId: string,
    status: TaskStatus,
    updated_at: string
  ): Promise<{ generation: number } | null>
  /** Clears the claim and bumps the generation, invalidating the old fencing token. */
  clearClaim(taskId: string, updated_at: string): Promise<void>
  setHeartbeat(taskId: string, at: string): Promise<void>
  /** Ancestors of the task, root first, excluding the task itself. */
  ancestors(id: string): Promise<TaskRecord[]>
}

// ---- dependencies

export interface BlockerRow {
  id: string
  title: string
  status: TaskStatus
}

export interface DependencyRepo {
  /** `blockerId blocks blockedId`; idempotent. */
  add(blockerId: string, blockedId: string): Promise<void>
  remove(blockerId: string, blockedId: string): Promise<void>
  /** True iff adding `blockerId blocks blockedId` would create a cycle. */
  wouldCycle(blockerId: string, blockedId: string): Promise<boolean>
  unmetBlockers(taskId: string): Promise<BlockerRow[]>
}

// ---- labels

export interface LabelRow {
  id: string
  name: string
  color: string
  created_at: string
}

export interface LabelRepo {
  /** Create-or-get by name; returns the existing label when present. */
  ensure(input: { id: string; name: string; color: string; created_at: string }): Promise<LabelRow>
  list(): Promise<LabelRow[]>
  attach(taskId: string, labelId: string): Promise<void>
  detach(taskId: string, labelId: string): Promise<void>
  labelsFor(taskId: string): Promise<LabelRow[]>
}

// ---- actors, tokens, policy

export interface ActorRow {
  id: string
  kind: ActorKind
  handle: string
  display_name: string
  description: string
  created_at: string
}

export interface TokenRow {
  id: string
  actor_id: string
  label: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

export interface TokenLookup {
  token: TokenRow
  actor: ActorRow
}

export interface ActorRepo {
  create(input: {
    id: string
    kind: ActorKind
    handle: string
    display_name: string
    description: string
    created_at: string
  }): Promise<ActorRow>
  findByHandle(handle: string): Promise<ActorRow | null>
  findById(id: string): Promise<ActorRow | null>
  list(): Promise<ActorRow[]>
  insertToken(input: {
    id: string
    actor_id: string
    token_hash: string
    label: string
    created_at: string
  }): Promise<void>
  findActiveTokenByHash(hash: string): Promise<TokenLookup | null>
  revokeToken(id: string, at: string): Promise<void>
  touchToken(id: string, at: string): Promise<void>
  listTokensForActor(actorId: string): Promise<TokenRow[]>
  getPolicy(key: string): Promise<string | null>
  setPolicy(key: string, value: string): Promise<void>
}

// ---- wiring seams

export interface Repos {
  tasks: TaskRepo
  audit: AuditRepo
  deps: DependencyRepo
  labels: LabelRepo
  actors: ActorRepo
}

export interface UnitOfWork {
  withTransaction<T>(fn: (repos: Repos) => Promise<T>): Promise<T>
}
```

- [ ] **Step 4.2: Create `src/testing/fixtures.ts`** (shared test seeding helper; excluded from coverage):

```ts
import { makeDb } from '#root/infra/sqlite/db'
import { migrateToLatest } from '#root/infra/sqlite/migrations'
import type { Kysely } from 'kysely'
import type { DB } from '#root/infra/sqlite/schema'
import type { ActorKind, TaskDraft, TaskStatus } from '#root/domain/task'

export const freshDb = async (): Promise<Kysely<DB>> => {
  const db = makeDb(':memory:')
  await migrateToLatest(db)
  return db
}

export const seedActor = async (
  db: Kysely<DB>,
  id: string,
  kind: ActorKind = 'agent',
  handle?: string
): Promise<void> => {
  await db
    .insertInto('actors')
    .values({
      id,
      kind,
      handle: handle ?? `${kind}_${id}`,
      display_name: `Seed ${id}`,
      description: '',
      created_at: '2026-01-01T00:00:00.000Z',
    })
    .execute()
}

export const seedToken = async (
  db: Kysely<DB>,
  id: string,
  actorId: string,
  hash = `hash_${id}`
): Promise<void> => {
  await db
    .insertInto('tokens')
    .values({
      id,
      actor_id: actorId,
      token_hash: hash,
      label: 'test',
      created_at: '2026-01-01T00:00:00.000Z',
      last_used_at: null,
      revoked_at: null,
    })
    .execute()
}

export const seedTask = async (
  db: Kysely<DB>,
  id: string,
  patch: Partial<TaskDraft> & { title?: string } = {}
): Promise<string> => {
  await db
    .insertInto('tasks')
    .values({
      id,
      parent_id: patch.parent_id ?? null,
      title: patch.title ?? `Task ${id}`,
      description: patch.description ?? '',
      acceptance_criteria: patch.acceptance_criteria ?? '',
      status: patch.status ?? 'todo',
      blocked_flag: 0,
      assignee_id: null,
      position: patch.position ?? 1,
      created_by: patch.created_by ?? 'a_creator',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      claim_token_id: null,
      claim_generation: 0,
      last_heartbeat_at: null,
    })
    .execute()
  return id
}

export const setStatus = async (db: Kysely<DB>, id: string, status: TaskStatus): Promise<void> => {
  await db.updateTable('tasks').set({ status }).where('id', '=', id).execute()
}
```

(Fixtures insert `'a_creator'` as a placeholder author — call `seedActor(db, 'a_creator')` before `seedTask` in tests.)

- [ ] **Step 4.3: Write failing audit-repo test** `src/infra/sqlite/audit-repo.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { SqliteAuditRepo } from '#root/infra/sqlite/audit-repo'
import { freshDb } from '#root/testing/fixtures'

const entry = (entityId: string, action = 'task_created') => ({
  actor_id: 'a_1',
  token_id: null,
  action,
  entity_type: 'task',
  entity_id: entityId,
  after: { title: 'x' },
  reason: 'because',
  created_at: '2026-01-01T00:00:00.000Z',
})

describe('SqliteAuditRepo', () => {
  it('appends and searches newest-first with parsed payloads', async () => {
    const db = await freshDb()
    const repo = new SqliteAuditRepo(db)
    await repo.append(entry('t_1'))
    await repo.append(entry('t_2', 'status_changed'))

    const all = await repo.search({ limit: 10 })
    expect(all.map((r) => r.entity_id)).toEqual(['t_2', 't_1'])
    expect(all[0]?.after).toEqual({ title: 'x' })
    expect(all[0]?.reason).toBe('because')

    const filtered = await repo.search({ entity_type: 'task', entity_id: 't_1', limit: 10 })
    expect(filtered).toHaveLength(1)
    await db.destroy()
  })

  it('caps by limit', async () => {
    const db = await freshDb()
    const repo = new SqliteAuditRepo(db)
    for (let i = 0; i < 5; i++) await repo.append(entry(`t_${i}`))
    expect(await repo.search({ limit: 2 })).toHaveLength(2)
    await db.destroy()
  })
})
```

- [ ] **Step 4.4: Implement `src/infra/sqlite/audit-repo.ts`:**

```ts
import type { Kysely } from 'kysely'
import type { AuditEntryDraft, AuditRepo, AuditRow } from '#root/application/ports'
import type { AuditLogTable, DB } from '#root/infra/sqlite/schema'

type Row = Omit<AuditLogTable, 'id'> & { id: number }

const parseJson = (raw: string | null): unknown => (raw === null ? null : JSON.parse(raw))

export class SqliteAuditRepo implements AuditRepo {
  constructor(private readonly db: Kysely<DB>) {}

  async append(entry: AuditEntryDraft): Promise<void> {
    await this.db
      .insertInto('audit_log')
      .values({
        actor_id: entry.actor_id,
        token_id: entry.token_id,
        action: entry.action,
        entity_type: entry.entity_type,
        entity_id: entry.entity_id,
        before_json: entry.before === undefined ? null : JSON.stringify(entry.before),
        after_json: entry.after === undefined ? null : JSON.stringify(entry.after),
        reason: entry.reason ?? null,
        created_at: entry.created_at,
      })
      .execute()
  }

  async search(q: {
    entity_type?: string
    entity_id?: string
    limit: number
  }): Promise<AuditRow[]> {
    let query = this.db.selectFrom('audit_log').selectAll().orderBy('id', 'desc').limit(q.limit)
    if (q.entity_type !== undefined) query = query.where('entity_type', '=', q.entity_type)
    if (q.entity_id !== undefined) query = query.where('entity_id', '=', q.entity_id)
    const rows = await query.execute()
    return rows.map((r: Row) => ({
      id: r.id,
      actor_id: r.actor_id,
      token_id: r.token_id,
      action: r.action,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      before: parseJson(r.before_json),
      after: parseJson(r.after_json),
      reason: r.reason,
      created_at: r.created_at,
    }))
  }
}
```

- [ ] **Step 4.5: Write failing task-repo test** `src/infra/sqlite/task-repo.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { SqliteTaskRepo } from '#root/infra/sqlite/task-repo'
import { freshDb, seedActor, seedTask } from '#root/testing/fixtures'

const setup = async () => {
  const db = await freshDb()
  await seedActor(db, 'a_creator', 'human')
  await seedActor(db, 'a_agent', 'agent')
  await seedTask(db, 'a_creator', {}) // no-op placeholder removed below
  return db
}

const draft = (id: string, parentId: string | null = null, position = 1) => ({
  id,
  parent_id: parentId,
  title: `Task ${id}`,
  description: 'd',
  acceptance_criteria: 'ac',
  status: 'todo' as const,
  position,
  created_by: 'a_creator',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
})

describe('SqliteTaskRepo', () => {
  it('creates and reads back a task with defaults', async () => {
    const db = await setup()
    const repo = new SqliteTaskRepo(db)
    const created = await repo.create(draft('t_1'))
    expect(created.blocked_flag).toBe(false)
    expect(created.claim_generation).toBe(0)
    const found = await repo.findById('t_1')
    expect(found).toEqual(created)
    await db.destroy()
  })

  it('reports child counts and unmet blockers', async () => {
    const db = await setup()
    const repo = new SqliteTaskRepo(db)
    await repo.create(draft('t_parent'))
    await repo.create(draft('t_child', 't_parent'))
    await repo.create(draft('t_blocker'))
    await sql`insert into dependencies (blocker_id, blocked_id) values ('t_blocker', 't_child')`.execute(
      db
    )

    const parent = await repo.findWithCounts('t_parent')
    expect(parent?.child_count).toBe(1)
    const child = await repo.findWithCounts('t_child')
    expect(child?.unmet_blockers).toBe(1)

    // done blocker is met
    await repo.setStatus('t_blocker', 'done', '2026-01-02T00:00:00.000Z')
    expect((await repo.findWithCounts('t_child'))?.unmet_blockers).toBe(0)
    await db.destroy()
  })

  it('listReady applies every gate and the label filter', async () => {
    const db = await setup()
    const repo = new SqliteTaskRepo(db)
    // spec §6.3: NO parent-status gate — a todo leaf under a live todo parent is ready
    // (oracle ruling A). Distinct positions make the ordered assertion deterministic,
    // since positions are only unique per-parent.
    await repo.create(draft('t_parent', null, 2))
    await repo.create(draft('t_child', 't_parent', 1)) // todo leaf under live parent → ready
    await repo.create({ ...draft('t_blocked', null, 1), status: 'backlog' }) // status gate
    await repo.create(draft('t_ready', null, 3))
    // the remaining §6.3 gates, seeded explicitly:
    await seedToken(db, 'tok_gate', 'a_agent')
    await repo.create(draft('t_claimed', null, 4)) // claimed gate
    await sql`update tasks set claim_token_id = 'tok_gate' where id = 't_claimed'`.execute(db)
    await repo.create({ ...draft('t_gate_blocker', null, 6), status: 'backlog' }) // unmet blocker; todo would be a ready leaf under ruling A
    await repo.create(draft('t_depblocked', null, 5)) // dependency gate
    await sql`insert into dependencies (blocker_id, blocked_id)
              values ('t_gate_blocker', 't_depblocked')`.execute(db)
    await repo.create(draft('t_flagged', null, 7)) // blocked_flag gate
    await sql`update tasks set blocked_flag = 1 where id = 't_flagged'`.execute(db)
    await sql`insert into labels (id, name, color, created_at)
              values ('l_infra', 'infra', '#f00', '2026-01-01')`.execute(db)
    await sql`insert into task_labels (task_id, label_id) values ('t_ready', 'l_infra')`.execute(db)

    const all = await repo.listReady({ limit: 10 })
    expect(all.map((r) => r.task.id)).toEqual(['t_child', 't_ready'])
    const labeled = await repo.listReady({ label: 'infra', limit: 10 })
    expect(labeled.map((r) => r.task.id)).toEqual(['t_ready'])
    const other = await repo.listReady({ label: 'ui', limit: 10 })
    expect(other).toHaveLength(0)
    await db.destroy()
  })

  it('claim CAS: one winner, generation bumps, clear invalidates', async () => {
    const db = await setup()
    const repo = new SqliteTaskRepo(db)
    await repo.create({ ...draft('t_1'), status: 'todo' })

    const first = await repo.tryClaim(
      't_1',
      'tok_1',
      'a_agent',
      'in_progress',
      '2026-01-02T00:00:00.000Z'
    )
    expect(first).toEqual({ generation: 1 })
    const second = await repo.tryClaim(
      't_1',
      'tok_2',
      'a_agent',
      'in_progress',
      '2026-01-02T00:00:00.000Z'
    )
    expect(second).toBeNull()

    const claimed = await repo.findById('t_1')
    expect(claimed?.status).toBe('in_progress')
    expect(claimed?.assignee_id).toBe('a_agent')
    expect(claimed?.claim_token_id).toBe('tok_1')

    await repo.clearClaim('t_1', '2026-01-02T00:00:01.000Z')
    expect((await repo.findById('t_1'))?.claim_generation).toBe(2)

    // re-claim yields generation 3 — old token (gen 1) can never validate again
    const third = await repo.tryClaim(
      't_1',
      'tok_2',
      'a_agent',
      'in_progress',
      '2026-01-02T00:00:02.000Z'
    )
    expect(third).toEqual({ generation: 3 })
    await db.destroy()
  })

  it('claiming an in_progress task keeps its status', async () => {
    const db = await setup()
    const repo = new SqliteTaskRepo(db)
    await repo.create({ ...draft('t_1'), status: 'in_progress' })
    await repo.tryClaim('t_1', 'tok_1', 'a_agent', 'in_progress', '2026-01-02T00:00:00.000Z')
    expect((await repo.findById('t_1'))?.status).toBe('in_progress')
    await db.destroy()
  })

  it('open-descendant count skips done/canceled, includes grandchildren', async () => {
    const db = await setup()
    const repo = new SqliteTaskRepo(db)
    await repo.create(draft('t_root'))
    await repo.create({ ...draft('t_mid', 't_root'), status: 'done' })
    await repo.create({ ...draft('t_leaf', 't_mid'), status: 'canceled' })
    await repo.create({ ...draft('t_leaf2', 't_mid'), status: 'in_progress' })
    expect(await repo.countOpenDescendants('t_root')).toBe(1)
    expect(await repo.hasChildren('t_root')).toBe(true)
    expect(await repo.hasChildren('t_leaf2')).toBe(false)
    await db.destroy()
  })

  it('ancestors returns the chain root-first', async () => {
    const db = await setup()
    const repo = new SqliteTaskRepo(db)
    await repo.create(draft('t_a'))
    await repo.create(draft('t_b', 't_a'))
    await repo.create(draft('t_c', 't_b'))
    const chain = await repo.ancestors('t_c')
    expect(chain.map((t) => t.id)).toEqual(['t_a', 't_b'])
    expect(await repo.ancestors('t_a')).toEqual([])
    await db.destroy()
  })

  it('patch maps booleans and whitelists columns; nextPosition orders siblings', async () => {
    const db = await setup()
    const repo = new SqliteTaskRepo(db)
    await repo.create(draft('t_1'))
    await repo.create(draft('t_2'))
    expect(await repo.nextPosition(null)).toBe(2)
    expect(await repo.nextPosition('t_1')).toBe(1)
    await repo.patch(
      't_1',
      { blocked_flag: true, title: 'renamed', assignee_id: 'a_agent' },
      '2026-01-03T00:00:00.000Z'
    )
    const t = await repo.findById('t_1')
    expect(t?.blocked_flag).toBe(true)
    expect(t?.title).toBe('renamed')
    expect(t?.assignee_id).toBe('a_agent')
    await db.destroy()
  })

  it('heartbeat records liveness timestamp', async () => {
    const db = await setup()
    const repo = new SqliteTaskRepo(db)
    await repo.create(draft('t_1'))
    await repo.setHeartbeat('t_1', '2026-01-04T00:00:00.000Z')
    expect((await repo.findById('t_1'))?.last_heartbeat_at).toBe('2026-01-04T00:00:00.000Z')
    await db.destroy()
  })
})
```

(`setup()` above is intentionally simple: the `seedTask(db, 'a_creator', …)` placeholder line does **not** exist in the final test — write `setup` exactly as: freshDb + two `seedActor` calls + return db.)

- [ ] **Step 4.6: Implement `src/infra/sqlite/task-repo.ts`:**

```ts
import { sql, type Kysely } from 'kysely'
import type { TaskDraft, TaskRecord, TaskStatus } from '#root/domain/task'
import type { TaskPatch, TaskRepo, TaskWithCounts } from '#root/application/ports'
import type { DB, TasksTable } from '#root/infra/sqlite/schema'

type TaskRow = TasksTable

const toRecord = (r: TaskRow): TaskRecord => ({
  id: r.id,
  parent_id: r.parent_id,
  title: r.title,
  description: r.description,
  acceptance_criteria: r.acceptance_criteria,
  status: r.status,
  blocked_flag: r.blocked_flag === 1,
  assignee_id: r.assignee_id,
  position: r.position,
  created_by: r.created_by,
  created_at: r.created_at,
  updated_at: r.updated_at,
  claim_token_id: r.claim_token_id,
  claim_generation: r.claim_generation,
  last_heartbeat_at: r.last_heartbeat_at,
})

const childCount = sql`
  (select count(*) from tasks c where c.parent_id = tasks.id)`

const unmetBlockers = sql`
  (select count(*) from dependencies d
     join tasks b on b.id = d.blocker_id
    where d.blocked_id = tasks.id and b.status != 'done')`

export class SqliteTaskRepo implements TaskRepo {
  constructor(private readonly db: Kysely<DB>) {}

  async create(draft: TaskDraft): Promise<TaskRecord> {
    const row = await this.db
      .insertInto('tasks')
      .values({
        id: draft.id,
        parent_id: draft.parent_id,
        title: draft.title,
        description: draft.description,
        acceptance_criteria: draft.acceptance_criteria,
        status: draft.status,
        blocked_flag: 0,
        assignee_id: null,
        position: draft.position,
        created_by: draft.created_by,
        created_at: draft.created_at,
        updated_at: draft.updated_at,
        claim_token_id: null,
        claim_generation: 0,
        last_heartbeat_at: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return toRecord(row)
  }

  async findById(id: string): Promise<TaskRecord | null> {
    const r = await this.db.selectFrom('tasks').selectAll().where('id', '=', id).executeTakeFirst()
    return r ? toRecord(r) : null
  }

  async findWithCounts(id: string): Promise<TaskWithCounts | null> {
    const r = await this.db
      .selectFrom('tasks')
      .select(sql<number>`tasks.*`.as('task'))
      .select(childCount.as('child_count'))
      .select(unmetBlockers.as('unmet_blockers'))
      .where('id', '=', id)
      .executeTakeFirst()
    if (!r) return null
    return {
      task: toRecord(r.task as unknown as TaskRow),
      child_count: Number(r.child_count),
      unmet_blockers: Number(r.unmet_blockers),
    }
  }

  async listAllWithCounts(): Promise<TaskWithCounts[]> {
    const rows = await this.db
      .selectFrom('tasks')
      .select(sql<TaskRow>`tasks.*`.as('task'))
      .select(childCount.as('child_count'))
      .select(unmetBlockers.as('unmet_blockers'))
      .orderBy('position', 'asc')
      .execute()
    return rows.map((r) => ({
      task: toRecord(r.task as unknown as TaskRow),
      child_count: Number(r.child_count),
      unmet_blockers: Number(r.unmet_blockers),
    }))
  }

  async listReady(filter: { label?: string; limit: number }): Promise<TaskWithCounts[]> {
    let query = this.db
      .selectFrom('tasks')
      .select(sql<TaskRow>`tasks.*`.as('task'))
      .select(childCount.as('child_count'))
      .select(unmetBlockers.as('unmet_blockers'))
      .where('tasks.status', '=', 'todo')
      .where('tasks.blocked_flag', '=', 0)
      .where('tasks.claim_token_id', 'is', null)
      .where(
        sql<unknown>`not exists (select 1 from tasks c where c.parent_id = tasks.id)`,
        '=?',
        []
      )
      .where(
        sql<unknown>`not exists (select 1 from dependencies d
                       join tasks b on b.id = d.blocker_id
                      where d.blocked_id = tasks.id and b.status != 'done')`,
        '=?',
        []
      )
      .orderBy('tasks.position', 'asc')
      .limit(filter.limit)
    if (filter.label) {
      query = query.where(
        sql<unknown>`exists (select 1 from task_labels tl
                   join labels l on l.id = tl.label_id
                  where tl.task_id = tasks.id and l.name = ${filter.label})`,
        '=?',
        []
      ) as typeof query
    }
    const rows = await query.execute()
    return rows.map((r) => ({
      task: toRecord(r.task as unknown as TaskRow),
      child_count: Number(r.child_count),
      unmet_blockers: Number(r.unmet_blockers),
    }))
  }

  async patch(id: string, patch: TaskPatch, updated_at: string): Promise<void> {
    const values: Partial<TasksTable> = { updated_at }
    if (patch.title !== undefined) values.title = patch.title
    if (patch.description !== undefined) values.description = patch.description
    if (patch.acceptance_criteria !== undefined)
      values.acceptance_criteria = patch.acceptance_criteria
    if (patch.blocked_flag !== undefined) values.blocked_flag = patch.blocked_flag ? 1 : 0
    if (patch.assignee_id !== undefined) values.assignee_id = patch.assignee_id
    await this.db.updateTable('tasks').set(values).where('id', '=', id).execute()
  }

  async setStatus(id: string, status: TaskStatus, updated_at: string): Promise<void> {
    await this.db.updateTable('tasks').set({ status, updated_at }).where('id', '=', id).execute()
  }

  async hasChildren(id: string): Promise<boolean> {
    const r = await sql<{ n: number }>`
      select count(*) as n from tasks where parent_id = ${id}
    `.execute(this.db)
    return Number(r.rows[0]?.n ?? 0) > 0
  }

  async countOpenDescendants(id: string): Promise<number> {
    const r = await sql<{ n: number }>`
      with recursive d(id) as (
        select id from tasks where parent_id = ${id}
        union all
        select t.id from tasks t join d on t.parent_id = d.id
      )
      select count(*) as n from d join tasks on tasks.id = d.id
       where tasks.status not in ('done','canceled')
    `.execute(this.db)
    return Number(r.rows[0]?.n ?? 0)
  }

  async nextPosition(parentId: string | null): Promise<number> {
    const r = await sql<{ m: number | null }>`
      select max(position) as m from tasks where parent_id ${
        parentId === null ? sql`is null` : sql`= ${parentId}`
      }
    `.execute(this.db)
    return Number(r.rows[0]?.m ?? 0) + 1
  }

  async tryClaim(
    taskId: string,
    tokenId: string,
    claimantActorId: string,
    status: TaskStatus,
    updated_at: string
  ): Promise<{ generation: number } | null> {
    // Single statement: UPDATE … RETURNING. The generation read must be ATOMIC with the
    // CAS — a separate findById between the two awaits could surface a generation this
    // claim never wrote when a split/release races the read. (Quality-review fix; Kysely
    // 0.29.5 supports update…returning on current SQLite.)
    const row = await this.db
      .updateTable('tasks')
      .set((eb) => ({
        claim_token_id: tokenId,
        assignee_id: claimantActorId,
        claim_generation: eb('claim_generation', '+', 1),
        status,
        updated_at,
      }))
      .where('id', '=', taskId)
      .where('claim_token_id', 'is', null)
      .returning('claim_generation')
      .executeTakeFirst()
    return row ? { generation: row.claim_generation } : null
  }

  async clearClaim(taskId: string, updated_at: string): Promise<void> {
    await this.db
      .updateTable('tasks')
      .set((eb) => ({
        claim_token_id: null,
        claim_generation: eb('claim_generation', '+', 1),
        updated_at,
      }))
      .where('id', '=', taskId)
      .execute()
  }

  async setHeartbeat(taskId: string, at: string): Promise<void> {
    await this.db
      .updateTable('tasks')
      .set({ last_heartbeat_at: at })
      .where('id', '=', taskId)
      .execute()
  }

  async ancestors(id: string): Promise<TaskRecord[]> {
    const r = await sql<TaskRow>`
      with recursive anc(id, depth) as (
        select parent_id, 1 from tasks where id = ${id} and parent_id is not null
        union all
        select t.parent_id, anc.depth + 1
          from tasks t join anc on t.id = anc.id
         where t.parent_id is not null
      )
      select tasks.* from tasks join anc on tasks.id = anc.id
       order by anc.depth desc
    `.execute(this.db)
    return r.rows.map(toRecord)
  }
}
```

**Note for the implementer:** if the `.where(sql<unknown>…, '=?', [])` form above fights Kysely typing, use the `sql` template inside `.where(sql\`…\`, 'is', 1)`-free variants — the canonical Kysely way to add a raw boolean predicate to a query builder is `.where((eb) => eb(sql\`not exists (…)\` as any, '=', 0 as any))`; simplest escape hatch: build the whole query with `sql`…`.execute(db)`. Keep semantics exactly as written; passing tests is the acceptance bar.

- [ ] **Step 4.7: Verify green, hygiene, commit.**

```bash
pnpm test src/infra/sqlite && pnpm test && pnpm lint && pnpm typecheck
git add -A && git commit -m "feat(repos): ports, audit repo, task repo with claim CAS and tree queries"
```

---

### Task 5: Unit of work + dependency, label, actor repositories

**Files:**

- Create: `src/infra/sqlite/uow.ts`, `src/infra/sqlite/dependency-repo.ts`, `src/infra/sqlite/label-repo.ts`, `src/infra/sqlite/actor-repo.ts`
- Test: `src/infra/sqlite/dependency-repo.test.ts`, `src/infra/sqlite/label-repo.test.ts`, `src/infra/sqlite/actor-repo.test.ts`, `src/infra/sqlite/uow.test.ts`

- [ ] **Step 5.1: Write failing dependency tests** `src/infra/sqlite/dependency-repo.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { SqliteDependencyRepo } from '#root/infra/sqlite/dependency-repo'
import { freshDb, seedActor, seedTask, setStatus } from '#root/testing/fixtures'

const setup = async () => {
  const db = await freshDb()
  await seedActor(db, 'a_creator', 'human')
  await seedTask(db, 't_x')
  await seedTask(db, 't_y')
  await seedTask(db, 't_z')
  return { db, repo: new SqliteDependencyRepo(db) }
}

describe('SqliteDependencyRepo', () => {
  it('add is idempotent and remove works', async () => {
    const { db, repo } = await setup()
    await repo.add('t_x', 't_y')
    await repo.add('t_x', 't_y') // no throw
    await repo.remove('t_x', 't_y')
    await repo.remove('t_x', 't_y') // no throw on missing edge
    await db.destroy()
  })

  it('detects direct and transitive cycles', async () => {
    const { db, repo } = await setup()
    // X blocks Y  (t_x -> t_y)
    await repo.add('t_x', 't_y')
    // adding Y blocks X would close the cycle
    expect(await repo.wouldCycle('t_y', 't_x')).toBe(true)
    // Z is unrelated — no cycle
    expect(await repo.wouldCycle('t_z', 't_x')).toBe(false)
    expect(await repo.wouldCycle('t_y', 't_z')).toBe(false)
    // transitive: Z blocks X, and X blocks Y ⇒ Y blocking Z is a cycle
    await repo.add('t_z', 't_x')
    expect(await repo.wouldCycle('t_y', 't_z')).toBe(true)
    await db.destroy()
  })

  it('unmetBlockers skips done blockers', async () => {
    const { db, repo } = await setup()
    await repo.add('t_x', 't_y')
    expect((await repo.unmetBlockers('t_y')).map((b) => b.id)).toEqual(['t_x'])
    await setStatus(db, 't_x', 'done')
    expect(await repo.unmetBlockers('t_y')).toEqual([])
    await db.destroy()
  })
})
```

- [ ] **Step 5.2: Implement `src/infra/sqlite/dependency-repo.ts`:**

```ts
import { sql, type Kysely } from 'kysely'
import type { BlockerRow, DependencyRepo } from '#root/application/ports'
import type { DB } from '#root/infra/sqlite/schema'

export class SqliteDependencyRepo implements DependencyRepo {
  constructor(private readonly db: Kysely<DB>) {}

  async add(blockerId: string, blockedId: string): Promise<void> {
    await this.db
      .insertInto('dependencies')
      .values({ blocker_id: blockerId, blocked_id: blockedId })
      .onConflict((oc) => oc.columns(['blocker_id', 'blocked_id']).doNothing())
      .execute()
  }

  async remove(blockerId: string, blockedId: string): Promise<void> {
    await this.db
      .deleteFrom('dependencies')
      .where('blocker_id', '=', blockerId)
      .where('blocked_id', '=', blockedId)
      .execute()
  }

  async wouldCycle(blockerId: string, blockedId: string): Promise<boolean> {
    // Adding "blockerId blocks blockedId" closes a cycle iff blockedId ALREADY
    // transitively blocks blockerId — i.e. blockedId appears among the transitive
    // blockers of blockerId. (Plan verbatim had the two interpolations swapped, which
    // detects "edge already transitively implied" instead — fails the plan's own
    // cycle test.) Anchor + recursion stay on blocked_id so SQLite uses
    // dependencies_blocked_idx.
    const r = await sql<{ hit: number }>`
      with recursive r(id) as (
        select blocker_id from dependencies where blocked_id = ${blockerId}
        union
        select d.blocker_id from dependencies d join r on d.blocked_id = r.id
      )
      select 1 as hit from r where r.id = ${blockedId} limit 1
    `.execute(this.db)
    return r.rows.length > 0
  }

  async unmetBlockers(taskId: string): Promise<BlockerRow[]> {
    const r = await sql<BlockerRow>`
      select b.id, b.title, b.status
        from dependencies d join tasks b on b.id = d.blocker_id
       where d.blocked_id = ${taskId} and b.status != 'done'
       order by b.title, b.id
    `.execute(this.db)
    return r.rows
  }
}
```

- [ ] **Step 5.3: Write failing label + actor tests.**

`src/infra/sqlite/label-repo.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { SqliteLabelRepo } from '#root/infra/sqlite/label-repo'
import { freshDb, seedActor, seedTask } from '#root/testing/fixtures'

const setup = async () => {
  const db = await freshDb()
  await seedActor(db, 'a_creator', 'human')
  await seedTask(db, 't_1')
  return { db, repo: new SqliteLabelRepo(db) }
}

describe('SqliteLabelRepo', () => {
  it('ensure is create-or-get', async () => {
    const { db, repo } = await setup()
    const made = await repo.ensure({
      id: 'l_new',
      name: 'infra',
      color: '#f00',
      created_at: '2026-01-01T00:00:00.000Z',
    })
    const again = await repo.ensure({
      id: 'l_other',
      name: 'infra',
      color: '#00f',
      created_at: '2026-01-01T00:00:00.000Z',
    })
    expect(again.id).toBe(made.id)
    expect(await repo.list()).toHaveLength(1)
    await db.destroy()
  })

  it('attach/detach and labelsFor', async () => {
    const { db, repo } = await setup()
    const label = await repo.ensure({
      id: 'l_a',
      name: 'a',
      color: '#f00',
      created_at: '2026-01-01T00:00:00.000Z',
    })
    await repo.attach('t_1', label.id)
    await repo.attach('t_1', label.id) // idempotent
    expect((await repo.labelsFor('t_1')).map((l) => l.name)).toEqual(['a'])
    await repo.detach('t_1', label.id)
    expect(await repo.labelsFor('t_1')).toEqual([])
    await db.destroy()
  })
})
```

`src/infra/sqlite/actor-repo.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { SqliteActorRepo } from '#root/infra/sqlite/actor-repo'
import { freshDb } from '#root/testing/fixtures'

describe('SqliteActorRepo', () => {
  const seed = async () => {
    const db = await freshDb()
    const repo = new SqliteActorRepo(db)
    const actor = await repo.create({
      id: 'a_1',
      kind: 'agent',
      handle: 'hermes-1',
      display_name: 'Hermes',
      description: '',
      created_at: '2026-01-01T00:00:00.000Z',
    })
    return { db, repo, actor }
  }

  it('create/find/list by handle and id', async () => {
    const { db, repo } = await seed()
    expect((await repo.findByHandle('hermes-1'))?.id).toBe('a_1')
    expect(await repo.findByHandle('nope')).toBeNull()
    expect((await repo.findById('a_1'))?.kind).toBe('agent')
    expect(await repo.list()).toHaveLength(1)
    await db.destroy()
  })

  it('token lookup only returns active tokens; revoke hides them', async () => {
    const { db, repo } = await seed()
    await repo.insertToken({
      id: 'tok_1',
      actor_id: 'a_1',
      token_hash: 'deadbeef',
      label: 'ci',
      created_at: '2026-01-01T00:00:00.000Z',
    })
    const hit = await repo.findActiveTokenByHash('deadbeef')
    expect(hit?.actor.handle).toBe('hermes-1')
    await repo.touchToken('tok_1', '2026-01-02T00:00:00.000Z')
    expect((await repo.listTokensForActor('a_1'))[0]?.last_used_at).toBe('2026-01-02T00:00:00.000Z')

    await repo.revokeToken('tok_1', '2026-01-03T00:00:00.000Z')
    expect(await repo.findActiveTokenByHash('deadbeef')).toBeNull()
    expect((await repo.listTokensForActor('a_1'))[0]?.revoked_at).toBe('2026-01-03T00:00:00.000Z')
    await db.destroy()
  })

  it('policy get/set with upsert', async () => {
    const { db, repo } = await seed()
    expect(await repo.getPolicy('review_gate')).toBe('on')
    await repo.setPolicy('review_gate', 'off')
    expect(await repo.getPolicy('review_gate')).toBe('off')
    expect(await repo.getPolicy('unknown_key')).toBeNull()
    await db.destroy()
  })
})
```

- [ ] **Step 5.4: Implement `src/infra/sqlite/label-repo.ts`:**

```ts
import type { Kysely } from 'kysely'
import type { LabelRepo, LabelRow } from '#root/application/ports'
import type { DB } from '#root/infra/sqlite/schema'

export class SqliteLabelRepo implements LabelRepo {
  constructor(private readonly db: Kysely<DB>) {}

  async ensure(input: {
    id: string
    name: string
    color: string
    created_at: string
  }): Promise<LabelRow> {
    await this.db
      .insertInto('labels')
      .values(input)
      .onConflict((oc) => oc.column('name').doNothing())
      .execute()
    return (await this.db
      .selectFrom('labels')
      .selectAll()
      .where('name', '=', input.name)
      .executeTakeFirst()) as LabelRow
  }

  async list(): Promise<LabelRow[]> {
    return this.db.selectFrom('labels').selectAll().orderBy('name', 'asc').execute() as Promise<
      LabelRow[]
    >
  }

  async attach(taskId: string, labelId: string): Promise<void> {
    await this.db
      .insertInto('task_labels')
      .values({ task_id: taskId, label_id: labelId })
      .onConflict((oc) => oc.columns(['task_id', 'label_id']).doNothing())
      .execute()
  }

  async detach(taskId: string, labelId: string): Promise<void> {
    await this.db
      .deleteFrom('task_labels')
      .where('task_id', '=', taskId)
      .where('label_id', '=', labelId)
      .execute()
  }

  async labelsFor(taskId: string): Promise<LabelRow[]> {
    return this.db
      .selectFrom('labels')
      .selectAll()
      .innerJoin('task_labels', 'task_labels.label_id', 'labels.id')
      .where('task_labels.task_id', '=', taskId)
      .orderBy('labels.name', 'asc')
      .execute() as Promise<LabelRow[]>
  }
}
```

- [ ] **Step 5.5: Implement `src/infra/sqlite/actor-repo.ts`:**

```ts
import type { Kysely } from 'kysely'
import type { ActorRepo, ActorRow, TokenLookup, TokenRow } from '#root/application/ports'
import type { DB } from '#root/infra/sqlite/schema'

export class SqliteActorRepo implements ActorRepo {
  constructor(private readonly db: Kysely<DB>) {}

  async create(input: {
    id: string
    kind: ActorRow['kind']
    handle: string
    display_name: string
    description: string
    created_at: string
  }): Promise<ActorRow> {
    await this.db.insertInto('actors').values(input).execute()
    return (await this.db
      .selectFrom('actors')
      .selectAll()
      .where('id', '=', input.id)
      .executeTakeFirst()) as ActorRow
  }

  async findByHandle(handle: string): Promise<ActorRow | null> {
    const r = await this.db
      .selectFrom('actors')
      .selectAll()
      .where('handle', '=', handle)
      .executeTakeFirst()
    return (r as ActorRow | undefined) ?? null
  }

  async findById(id: string): Promise<ActorRow | null> {
    const r = await this.db.selectFrom('actors').selectAll().where('id', '=', id).executeTakeFirst()
    return (r as ActorRow | undefined) ?? null
  }

  async list(): Promise<ActorRow[]> {
    return this.db.selectFrom('actors').selectAll().orderBy('handle', 'asc').execute() as Promise<
      ActorRow[]
    >
  }

  async insertToken(input: {
    id: string
    actor_id: string
    token_hash: string
    label: string
    created_at: string
  }): Promise<void> {
    await this.db.insertInto('tokens').values(input).execute()
  }

  async findActiveTokenByHash(hash: string): Promise<TokenLookup | null> {
    const r = await this.db
      .selectFrom('tokens')
      .selectAll()
      .innerJoin('actors', 'actors.id', 'tokens.actor_id')
      .select([
        'actors.kind as a_kind',
        'actors.handle as a_handle',
        'actors.display_name as a_display',
      ])
      .where('tokens.token_hash', '=', hash)
      .where('tokens.revoked_at', 'is', null)
      .executeTakeFirst()
    if (!r) return null
    const token: TokenRow = {
      id: r.id,
      actor_id: r.actor_id,
      label: r.label,
      created_at: r.created_at,
      last_used_at: r.last_used_at,
      revoked_at: r.revoked_at,
    }
    const actor: ActorRow = {
      id: r.actor_id,
      kind: r.a_kind,
      handle: r.a_handle,
      display_name: r.a_display,
      description: '',
      created_at: '',
    }
    return { token, actor }
  }

  async revokeToken(id: string, at: string): Promise<void> {
    await this.db.updateTable('tokens').set({ revoked_at: at }).where('id', '=', id).execute()
  }

  async touchToken(id: string, at: string): Promise<void> {
    await this.db.updateTable('tokens').set({ last_used_at: at }).where('id', '=', id).execute()
  }

  async listTokensForActor(actorId: string): Promise<TokenRow[]> {
    const rows = await this.db
      .selectFrom('tokens')
      .selectAll()
      .where('actor_id', '=', actorId)
      .orderBy('created_at', 'asc')
      .execute()
    return rows.map((r) => ({
      id: r.id,
      actor_id: r.actor_id,
      label: r.label,
      created_at: r.created_at,
      last_used_at: r.last_used_at,
      revoked_at: r.revoked_at,
    }))
  }

  async getPolicy(key: string): Promise<string | null> {
    const r = await this.db
      .selectFrom('policy')
      .select('value')
      .where('key', '=', key)
      .executeTakeFirst()
    return r?.value ?? null
  }

  async setPolicy(key: string, value: string): Promise<void> {
    await this.db
      .insertInto('policy')
      .values({ key, value })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value }))
      .execute()
  }
}
```

**Note:** the join in `findActiveTokenByHash` deliberately returns a trimmed actor (no description/created_at round-trip needed by auth); `description: ''`/`created_at: ''` placeholders are acceptable because the auth path only consumes `id`, `kind`, `handle`, `display_name`.

- [ ] **Step 5.6: Write failing UoW test** `src/infra/sqlite/uow.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { SqliteUnitOfWork } from '#root/infra/sqlite/uow'
import { freshDb, seedActor } from '#root/testing/fixtures'
import { SqliteTaskRepo } from '#root/infra/sqlite/task-repo'

class Boom extends Error {}

const draft = (id: string) => ({
  id,
  parent_id: null,
  title: id,
  description: '',
  acceptance_criteria: '',
  status: 'todo' as const,
  position: 1,
  created_by: 'a_creator',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
})

describe('SqliteUnitOfWork', () => {
  it('rolls back on error', async () => {
    const db = await freshDb()
    await seedActor(db, 'a_creator', 'human')
    const uow = new SqliteUnitOfWork(db)
    await expect(
      uow.withTransaction(async (repos) => {
        await repos.tasks.create(draft('t_rolled'))
        throw new Boom('nope')
      })
    ).rejects.toBeInstanceOf(Boom)
    expect(await new SqliteTaskRepo(db).findById('t_rolled')).toBeNull()
    await db.destroy()
  })

  it('commits on success and repos inside share the tx connection', async () => {
    const db = await freshDb()
    await seedActor(db, 'a_creator', 'human')
    const uow = new SqliteUnitOfWork(db)
    await uow.withTransaction(async (repos) => {
      await repos.tasks.create(draft('t_kept'))
      // visible inside the same transaction
      expect(await repos.tasks.findById('t_kept')).not.toBeNull()
    })
    expect(await new SqliteTaskRepo(db).findById('t_kept')).not.toBeNull()
    await db.destroy()
  })

  it('runs transactions one after another on the single writer', async () => {
    const db = await freshDb()
    await seedActor(db, 'a_creator', 'human')
    const uow = new SqliteUnitOfWork(db)
    const results = await Promise.all([
      uow.withTransaction(async (repos) => {
        await repos.tasks.create(draft('t_c1'))
        return 1
      }),
      uow.withTransaction(async (repos) => {
        await repos.tasks.create(draft('t_c2'))
        return 2
      }),
    ])
    expect(results).toEqual([1, 2])
    expect(await new SqliteTaskRepo(db).findById('t_c1')).not.toBeNull()
    expect(await new SqliteTaskRepo(db).findById('t_c2')).not.toBeNull()
    await db.destroy()
  })
})
```

- [ ] **Step 5.7: Implement `src/infra/sqlite/uow.ts`:**

```ts
import type { Kysely } from 'kysely'
import type { Repos, UnitOfWork } from '#root/application/ports'
import type { DB } from '#root/infra/sqlite/schema'
import { SqliteActorRepo } from '#root/infra/sqlite/actor-repo'
import { SqliteAuditRepo } from '#root/infra/sqlite/audit-repo'
import { SqliteDependencyRepo } from '#root/infra/sqlite/dependency-repo'
import { SqliteLabelRepo } from '#root/infra/sqlite/label-repo'
import { SqliteTaskRepo } from '#root/infra/sqlite/task-repo'

export class SqliteUnitOfWork implements UnitOfWork {
  constructor(private readonly db: Kysely<DB>) {}

  private repos(tx: Kysely<DB>): Repos {
    return {
      tasks: new SqliteTaskRepo(tx),
      audit: new SqliteAuditRepo(tx),
      deps: new SqliteDependencyRepo(tx),
      labels: new SqliteLabelRepo(tx),
      actors: new SqliteActorRepo(tx),
    }
  }

  // Kysely 0.29.5 already serializes connection acquisition for SQLite
  // (RuntimeDriver wraps the single connection in its own ConnectionMutex, held from
  // BEGIN through COMMIT/ROLLBACK), so overlapping transactions do NOT error. This
  // promise-chain queue adds STRICT FIFO fairness on the single writer and keeps
  // ordering deterministic if a pooled or multi-connection dialect ever replaces
  // SqliteDialect.
  //
  // NOT reentrant: never touch the root db from inside fn — neither a nested
  // withTransaction nor a plain root-db query. Kysely's own connection mutex is held
  // for the whole transaction, so an inner acquisition waits FOREVER (silent deadlock,
  // no error, no timeout). Use-cases own transactions; repos receive the tx and never
  // start their own or capture the root db.
  //
  // FIFO scope is per-instance; SAFETY is global (Kysely's driver mutex), so multiple
  // UoW instances over one db cannot corrupt anything — they only lose shared ordering.
  private txQueue: Promise<unknown> = Promise.resolve()

  async withTransaction<T>(fn: (repos: Repos) => Promise<T>): Promise<T> {
    const run = (): Promise<T> => this.db.transaction().execute((trx) => fn(this.repos(trx)))
    const result = this.txQueue.then(run, run)
    this.txQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
```

- [ ] **Step 5.8: Verify green, hygiene, commit.**

```bash
pnpm test src/infra && pnpm test && pnpm lint && pnpm typecheck
git add -A && git commit -m "feat(repos): unit-of-work, dependency cycle detection, labels, actors/tokens/policy"
```

---

### Task 6: Idempotency store (spec §7.3)

**Files:**

- Modify: `src/application/ports.ts` (append two interfaces)
- Create: `src/infra/sqlite/idempotency-repo.ts`
- Test: `src/infra/sqlite/idempotency-repo.test.ts`

- [ ] **Step 6.1: Append to `src/application/ports.ts`:**

```ts
// ---- idempotency (spec §7.3)

export type IdempotencyOutcome =
  | { state: 'complete'; status: number; body: string }
  | { state: 'reserved' }
  | { state: 'in_flight' }

export interface IdempotencyRepo {
  reserve(input: {
    actor_id: string
    idem_key: string
    request_method: string
    request_path: string
    created_at: string
  }): Promise<IdempotencyOutcome>
  complete(actorId: string, key: string, status: number, body: string): Promise<void>
  remove(actorId: string, key: string): Promise<void>
}
```

- [ ] **Step 6.2: Write failing test** `src/infra/sqlite/idempotency-repo.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { SqliteIdempotencyRepo } from '#root/infra/sqlite/idempotency-repo'
import { freshDb } from '#root/testing/fixtures'

const req = (key = 'k-1') => ({
  actor_id: 'a_1',
  idem_key: key,
  request_method: 'POST',
  request_path: '/tasks',
  created_at: '2026-01-01T00:00:00.000Z',
})

describe('SqliteIdempotencyRepo', () => {
  it('reserve → complete → replay', async () => {
    const db = await freshDb()
    const repo = new SqliteIdempotencyRepo(db)
    expect(await repo.reserve(req())).toEqual({ state: 'reserved' })
    // concurrent duplicate while unresolved:
    expect(await repo.reserve(req())).toEqual({ state: 'in_flight' })
    await repo.complete('a_1', 'k-1', 201, '{"id":"t_1"}')
    expect(await repo.reserve(req())).toEqual({
      state: 'complete',
      status: 201,
      body: '{"id":"t_1"}',
    })
    await db.destroy()
  })

  it('keys are scoped per actor', async () => {
    const db = await freshDb()
    const repo = new SqliteIdempotencyRepo(db)
    expect(await repo.reserve(req())).toEqual({ state: 'reserved' })
    expect(await repo.reserve({ ...req(), actor_id: 'a_2' })).toEqual({ state: 'reserved' })
    await db.destroy()
  })

  it('remove frees the key for retry (5xx path, decision D-j)', async () => {
    const db = await freshDb()
    const repo = new SqliteIdempotencyRepo(db)
    await repo.reserve(req())
    await repo.remove('a_1', 'k-1')
    expect(await repo.reserve(req())).toEqual({ state: 'reserved' })
    await db.destroy()
  })
})
```

- [ ] **Step 6.3: Implement `src/infra/sqlite/idempotency-repo.ts`:**

```ts
import type { Kysely } from 'kysely'
import type { IdempotencyOutcome, IdempotencyRepo } from '#root/application/ports'
import type { DB } from '#root/infra/sqlite/schema'

export class SqliteIdempotencyRepo implements IdempotencyRepo {
  constructor(private readonly db: Kysely<DB>) {}

  async reserve(input: {
    actor_id: string
    idem_key: string
    request_method: string
    request_path: string
    created_at: string
  }): Promise<IdempotencyOutcome> {
    const res = await this.db
      .insertInto('idempotency_keys')
      .values({ ...input, status: null, body: null })
      .onConflict((oc) => oc.columns(['actor_id', 'idem_key']).doNothing())
      .executeTakeFirst()
    // Kysely 0.29.5 InsertResult exposes numInsertedOrUpdatedRows (not numInsertedRows);
    // with onConflict doNothing a racer's no-op yields 0.
    if (Number(res.numInsertedOrUpdatedRows) === 1) return { state: 'reserved' } // Task-4/5 idiom: executeTakeFirstOrThrow for the insert result

    const row = await this.db
      .selectFrom('idempotency_keys')
      .selectAll()
      .where('actor_id', '=', input.actor_id)
      .where('idem_key', '=', input.idem_key)
      .executeTakeFirst()
    if (row && row.status !== null && row.body !== null) {
      return { state: 'complete', status: row.status, body: row.body }
    }
    return { state: 'in_flight' }
  }

  async complete(actorId: string, key: string, status: number, body: string): Promise<void> {
    await this.db
      .updateTable('idempotency_keys')
      .set({ status, body })
      .where('actor_id', '=', actorId)
      .where('idem_key', '=', key)
      .execute()
  }

  async remove(actorId: string, key: string): Promise<void> {
    await this.db
      .deleteFrom('idempotency_keys')
      .where('actor_id', '=', actorId)
      .where('idem_key', '=', key)
      .execute()
  }
}
```

- [ ] **Step 6.4: Verify green, hygiene, commit.**

```bash
pnpm test src/infra/sqlite/idempotency-repo.test.ts && git add -A && git commit -m "feat: idempotency-key reservation and replay store"
```

---

### Task 7: Use-cases — CreateTask, UpdateTask

**Files:**

- Modify: `src/application/ports.ts` (append `ActorContext`)
- Create: `src/application/usecases/create-task.ts`, `src/application/usecases/update-task.ts`
- Test: `src/application/usecases/create-task.test.ts`, `src/application/usecases/update-task.test.ts`

- [ ] **Step 7.1: Append to `src/application/ports.ts`:**

```ts
// ---- actor context passed into every use-case invocation

export interface ActorContext {
  actor: ActorRef
  /** id of the authenticated token performing the request (audit attribution, spec §5) */
  tokenId: string | null
}
```

- [ ] **Step 7.2: Write failing CreateTask test** `src/application/usecases/create-task.test.ts`. Shared use-case test harness (later test files reuse `buildUow`):

```ts
import { describe, expect, it } from 'vitest'
import { SqliteUnitOfWork } from '#root/infra/sqlite/uow'
import { SqliteActorRepo } from '#root/infra/sqlite/actor-repo'
import { SqliteLabelRepo } from '#root/infra/sqlite/label-repo'
import { freshDb, seedActor } from '#root/testing/fixtures'
import { CreateTask } from '#root/application/usecases/create-task'
import { DomainError } from '#root/domain/errors'
import type { ActorContext, Clock, IdGen } from '#root/application/ports'

export const fixedClock = (): Clock => ({ now: () => new Date('2026-05-05T05:05:05.000Z') })
export const seqIds = (): IdGen => {
  let n = 0
  return {
    newId: (prefix: string) => {
      n += 1
      return `${prefix}_seq${n}`
    },
  }
}
export const buildUow = async () => {
  const db = await freshDb()
  await seedActor(db, 'a_human', 'human', 'nils')
  const uow = new SqliteUnitOfWork(db)
  return { db, uow }
}
export const human: ActorContext = {
  actor: { id: 'a_human', kind: 'human', handle: 'nils', display_name: 'Nils' },
  tokenId: null,
}

describe('CreateTask', () => {
  it('creates a root task with defaults and audits it', async () => {
    const { db, uow } = await buildUow()
    const uc = new CreateTask(uow, fixedClock(), seqIds())
    const task = await uc.run({ ...human, title: 'Ship v1' })
    expect(task.id).toBe('t_seq1')
    expect(task.status).toBe('backlog')
    expect(task.position).toBe(1)
    expect(task.created_at).toBe('2026-05-05T05:05:05.000Z')

    const audit = await new SqliteActorRepo(db) // reuse any repo for db handle? no — audit via search below
      .getPolicy('nonexistent') // dummy to keep import; replaced in final test
      .then(() => undefined)
    void audit

    const auditRows = await new (await import('#root/infra/sqlite/audit-repo')).SqliteAuditRepo(
      db
    ).search({
      entity_type: 'task',
      entity_id: task.id,
      limit: 5,
    })
    expect(auditRows[0]?.action).toBe('task_created')
    expect(auditRows[0]?.actor_id).toBe('a_human')
    await db.destroy()
  })

  it('creates children under a parent with ordered positions and ensured labels', async () => {
    const { db, uow } = await buildUow()
    const uc = new CreateTask(uow, fixedClock(), seqIds())
    const parent = await uc.run({ ...human, title: 'parent' })
    const child = await uc.run({
      ...human,
      title: 'child',
      parent_id: parent.id,
      status: 'todo',
      labels: ['infra'],
    })
    expect(child.parent_id).toBe(parent.id)
    expect(child.position).toBe(1) // first child
    const sibling = await uc.run({ ...human, title: 'sibling', parent_id: parent.id })
    expect(sibling.position).toBe(2)

    const labels = await new SqliteLabelRepo(db).labelsFor(child.id)
    expect(labels.map((l) => l.name)).toEqual(['infra'])
    await db.destroy()
  })

  it('rejects unknown parent with not_found', async () => {
    const { db, uow } = await buildUow()
    const uc = new CreateTask(uow, fixedClock(), seqIds())
    await expect(uc.run({ ...human, title: 'x', parent_id: 't_missing' })).rejects.toMatchObject({
      code: 'not_found',
    })
    await db.destroy()
  })

  it('rejects invalid status with invalid_request', async () => {
    const { db, uow } = await buildUow()
    const uc = new CreateTask(uow, fixedClock(), seqIds())
    await expect(
      uc.run({ ...human, title: 'x', status: 'shipped' as never })
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(
      uc.run({ ...human, title: 'x', status: 'shipped' as never })
    ).rejects.toBeInstanceOf(DomainError)
    await db.destroy()
  })
})
```

**Implementer note:** the first test's `SqliteActorRepo` dummy lines are scaffolding noise — in the final file, delete the `const audit = …` block and the dynamic import; import `SqliteAuditRepo` statically at top and assert audit rows directly. Clean final version of that block:

```ts
const auditRows = await new SqliteAuditRepo(db).search({
  entity_type: 'task',
  entity_id: task.id,
  limit: 5,
})
```

- [ ] **Step 7.3: Implement `src/application/usecases/create-task.ts`:**

```ts
import { TASK_STATUSES, type TaskRecord, type TaskStatus } from '#root/domain/task'
import { DomainError } from '#root/domain/errors'
import type { ActorContext, Clock, IdGen, UnitOfWork } from '#root/application/ports'

export interface CreateTaskInput extends ActorContext {
  title: string
  description?: string
  acceptance_criteria?: string
  parent_id?: string
  status?: TaskStatus
  labels?: string[]
}

export class CreateTask {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGen
  ) {}

  async run(input: CreateTaskInput): Promise<TaskRecord> {
    const now = this.clock.now().toISOString()
    const status: TaskStatus = input.status ?? 'backlog'
    if (!TASK_STATUSES.includes(status)) {
      throw new DomainError('invalid_request', `unknown status '${status}'`)
    }
    return this.uow.withTransaction(async (repos) => {
      if (input.parent_id) {
        const parent = await repos.tasks.findById(input.parent_id)
        if (!parent) {
          throw new DomainError('not_found', `parent task ${input.parent_id} not found`)
        }
      }
      const position = await repos.tasks.nextPosition(input.parent_id ?? null)
      const task = await repos.tasks.create({
        id: this.ids.newId('t'),
        parent_id: input.parent_id ?? null,
        title: input.title,
        description: input.description ?? '',
        acceptance_criteria: input.acceptance_criteria ?? '',
        status,
        position,
        created_by: input.actor.id,
        created_at: now,
        updated_at: now,
      })
      for (const name of input.labels ?? []) {
        const label = await repos.labels.ensure({
          id: this.ids.newId('l'),
          name,
          color: '#888888',
          created_at: now,
        })
        await repos.labels.attach(task.id, label.id)
      }
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'task_created',
        entity_type: 'task',
        entity_id: task.id,
        after: { title: task.title, status: task.status, parent_id: task.parent_id },
        reason: 'task created',
        created_at: now,
      })
      return task
    })
  }
}
```

- [ ] **Step 7.4: Verify CreateTask green** (`pnpm test src/application/usecases/create-task.test.ts`), commit red→green steps as usual (test commit optional; single commit at task end is fine).

- [ ] **Step 7.5: Write failing UpdateTask test** `src/application/usecases/update-task.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { CreateTask } from '#root/application/usecases/create-task'
import { UpdateTask } from '#root/application/usecases/update-task'
import { buildUow, fixedClock, human, seqIds } from '#root/application/usecases/create-task.test'
import { SqliteTaskRepo } from '#root/infra/sqlite/task-repo'
import { DomainError } from '#root/domain/errors'

describe('UpdateTask (content patch, decision D-e)', () => {
  it('patches content fields and audits before/after', async () => {
    const { db, uow } = await buildUow()
    const created = await new CreateTask(uow, fixedClock(), seqIds()).run({
      ...human,
      title: 'old',
    })
    const uc = new UpdateTask(uow, fixedClock())
    const updated = await uc.run({
      ...human,
      taskId: created.id,
      patch: { title: 'new', blocked_flag: true, acceptance_criteria: 'AC-1' },
    })
    expect(updated.title).toBe('new')
    expect(updated.blocked_flag).toBe(true)
    expect((await new SqliteTaskRepo(db).findById(created.id))?.acceptance_criteria).toBe('AC-1')
    await db.destroy()
  })

  it('rejects unknown assignee actor', async () => {
    const { db, uow } = await buildUow()
    const created = await new CreateTask(uow, fixedClock(), seqIds()).run({ ...human, title: 'x' })
    const uc = new UpdateTask(uow, fixedClock())
    await expect(
      uc.run({ ...human, taskId: created.id, patch: { assignee_id: 'a_ghost' } })
    ).rejects.toBeInstanceOf(DomainError)
    await db.destroy()
  })

  it('rejects unknown task with not_found', async () => {
    const { db, uow } = await buildUow()
    const uc = new UpdateTask(uow, fixedClock())
    await expect(
      uc.run({ ...human, taskId: 't_ghost', patch: { title: 'x' } })
    ).rejects.toMatchObject({ code: 'not_found' })
    await db.destroy()
  })

  it('empty patch is a no-op (no audit noise)', async () => {
    const { db, uow } = await buildUow()
    const created = await new CreateTask(uow, fixedClock(), seqIds()).run({ ...human, title: 'x' })
    const updated = await new UpdateTask(uow, fixedClock()).run({
      ...human,
      taskId: created.id,
      patch: {},
    })
    expect(updated.title).toBe('x')
    await db.destroy()
  })
})
```

- [ ] **Step 7.6: Implement `src/application/usecases/update-task.ts`:**

```ts
import type { TaskRecord } from '#root/domain/task'
import { DomainError } from '#root/domain/errors'
import type { ActorContext, Clock, TaskPatch, UnitOfWork } from '#root/application/ports'

export interface UpdateTaskInput extends ActorContext {
  taskId: string
  patch: TaskPatch
}

export class UpdateTask {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock
  ) {}

  async run(input: UpdateTaskInput): Promise<TaskRecord> {
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      const before = await repos.tasks.findById(input.taskId)
      if (!before) throw new DomainError('not_found', `task ${input.taskId} not found`)
      // M-3 hardening (ora-12): existence check runs on any non-null SET — catches ''
      if (input.patch.assignee_id !== undefined && input.patch.assignee_id !== null) {
        const assignee = await repos.actors.findById(input.patch.assignee_id)
        if (!assignee) {
          throw new DomainError('not_found', `assignee ${input.patch.assignee_id} not found`)
        }
      }
      const meaningful = Object.keys(input.patch).length > 0
      if (meaningful) {
        await repos.tasks.patch(input.taskId, input.patch, now)
        const after = (await repos.tasks.findById(input.taskId)) as TaskRecord
        await repos.audit.append({
          actor_id: input.actor.id,
          token_id: input.tokenId,
          action: 'task_updated',
          entity_type: 'task',
          entity_id: input.taskId,
          before: {
            title: before.title,
            description: before.description,
            blocked_flag: before.blocked_flag,
            assignee_id: before.assignee_id,
            acceptance_criteria: before.acceptance_criteria,
          },
          after: {
            title: after.title,
            description: after.description,
            blocked_flag: after.blocked_flag,
            assignee_id: after.assignee_id,
            acceptance_criteria: after.acceptance_criteria,
          },
          reason: 'content updated',
          created_at: now,
        })
        return after
      }
      return before
    })
  }
}
```

- [ ] **Step 7.7: Verify green, hygiene, commit.**

```bash
pnpm test && pnpm lint && pnpm typecheck
git add -A && git commit -m "feat(usecases): CreateTask, UpdateTask with audit trail"
```

---

### Task 8: Use-case — SplitTask (atomic split, auto-release under claim, spec §6.2)

> **Execution note (orchestrator, 2026-09-07):** Tasks 8–10 are dispatched as ONE combined implementer run
> because their test blocks import each other's modules (Task 8's test uses `ClaimTask`; Task 9's uses
> `ClaimTask`+`SplitTask`; Task 10's uses `UpdateStatus`+`SplitTask`) — a sequential per-task "verify green"
> is impossible. Inside the run: write Task 8's test first (RED: missing modules), then implement
> Step 10.1 (ports + `findActorByTokenId`) and the five use-case modules (split/claim/release/heartbeat,
> then update-status), keeping each task's test file verbatim; commit(s) note the merge. Task content,
> APIs and invariants are unchanged.

**Files:**

- Create: `src/application/usecases/split-task.ts`
- Test: `src/application/usecases/split-task.test.ts`

- [ ] **Step 8.1: Write failing test** `src/application/usecases/split-task.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { CreateTask } from '#root/application/usecases/create-task'
import { SplitTask } from '#root/application/usecases/split-task'
import { ClaimTask } from '#root/application/usecases/claim-task'
import { buildUow, fixedClock, human, seqIds } from '#root/application/usecases/create-task.test'
import { SqliteAuditRepo } from '#root/infra/sqlite/audit-repo'
import { SqliteTaskRepo } from '#root/infra/sqlite/task-repo'
import { seedActor, seedToken } from '#root/testing/fixtures'

describe('SplitTask (spec §6.2)', () => {
  it('creates N children under the parent in order', async () => {
    const { db, uow } = await buildUow()
    const parent = await new CreateTask(uow, fixedClock(), seqIds()).run({ ...human, title: 'big' })
    const split = await new SplitTask(uow, fixedClock(), seqIds()).run({
      ...human,
      taskId: parent.id,
      children: [
        { title: 'c1', acceptance_criteria: 'AC1', status: 'todo' },
        { title: 'c2' }, // defaults: status backlog
      ],
    })
    expect(split.created.map((c) => c.title)).toEqual(['c1', 'c2'])
    expect(split.created[0]?.parent_id).toBe(parent.id)
    expect(split.created[0]?.acceptance_criteria).toBe('AC1')
    expect(split.created[0]?.status).toBe('todo')
    expect(split.created[1]?.status).toBe('backlog')
    expect(split.parent.child_count).toBe(2)

    const audit = await new SqliteAuditRepo(db).search({
      entity_type: 'task',
      entity_id: parent.id,
      limit: 5,
    })
    expect(audit.some((a) => a.action === 'task_split')).toBe(true)
    await db.destroy()
  })

  it('auto-releases an active claim and bumps the fencing generation (decision D-d)', async () => {
    const { db, uow } = await buildUow()
    await seedActor(db, 'a_agent', 'agent', 'hermes-1')
    await seedToken(db, 'tok_agent', 'a_agent')
    const parent = await new CreateTask(uow, fixedClock(), seqIds()).run({
      ...human,
      title: 'big',
      status: 'todo',
    })
    const claim = await new ClaimTask(uow, fixedClock()).run({
      actor: { id: 'a_agent', kind: 'agent', handle: 'hermes-1', display_name: 'Hermes' },
      tokenId: 'tok_agent',
      taskId: parent.id,
    })
    expect(claim.generation).toBe(1)

    const split = await new SplitTask(uow, fixedClock(), seqIds()).run({
      ...human,
      taskId: parent.id,
      children: [{ title: 'c1' }],
    })
    expect(split.parent.task.claim_token_id).toBeNull()
    expect(split.parent.task.claim_generation).toBe(2)

    const audit = await new SqliteAuditRepo(db).search({
      entity_type: 'task',
      entity_id: parent.id,
      limit: 10,
    })
    expect(audit.some((a) => a.reason === 'claim released by split')).toBe(true)

    // the old lease token can never be used again:
    const { UpdateStatus } = await import('#root/application/usecases/update-status')
    await expect(
      new UpdateStatus(uow, fixedClock()).run({
        actor: { id: 'a_agent', kind: 'agent', handle: 'hermes-1', display_name: 'Hermes' },
        tokenId: 'tok_agent',
        taskId: parent.id,
        to: 'in_review',
        reason: 'donezo',
        lease_token: claim.lease_token,
      })
    ).rejects.toMatchObject({ code: 'stale_lease' })

    // parent is no longer a leaf → cannot be claimed
    await expect(
      new ClaimTask(uow, fixedClock()).run({
        actor: { id: 'a_agent', kind: 'agent', handle: 'hermes-1', display_name: 'Hermes' },
        tokenId: 'tok_agent',
        taskId: parent.id,
      })
    ).rejects.toMatchObject({ code: 'not_a_leaf' })

    // children are claimable leaves
    const child = split.created[0] as { id: string }
    const childClaim = await new ClaimTask(uow, fixedClock()).run({
      actor: { id: 'a_agent', kind: 'agent', handle: 'hermes-1', display_name: 'Hermes' },
      tokenId: 'tok_agent',
      taskId: child.id,
    })
    expect(childClaim.generation).toBe(1)
    expect((await new SqliteTaskRepo(db).findById(child.id))?.status).toBe('in_progress')
    await db.destroy()
  })

  it('rejects zero children and unknown parent', async () => {
    const { db, uow } = await buildUow()
    const parent = await new CreateTask(uow, fixedClock(), seqIds()).run({ ...human, title: 'big' })
    const uc = new SplitTask(uow, fixedClock(), seqIds())
    await expect(uc.run({ ...human, taskId: parent.id, children: [] })).rejects.toMatchObject({
      code: 'invalid_request',
    })
    await expect(
      uc.run({ ...human, taskId: 't_ghost', children: [{ title: 'x' }] })
    ).rejects.toMatchObject({ code: 'not_found' })
    await db.destroy()
  })
})
```

- [ ] **Step 8.2: Implement `src/application/usecases/split-task.ts`** (`ClaimTask`/`UpdateStatus` land in Tasks 9–10; if executed in strict task order, write this test file but mark Steps 8.3 green-check as "green after Task 10" — or reorder: implement Task 10's ClaimTask first if the harness prefers. The commit below still stands when all imports resolve):

```ts
import { TASK_STATUSES, type TaskRecord, type TaskStatus } from '#root/domain/task'
import { DomainError } from '#root/domain/errors'
import type {
  ActorContext,
  Clock,
  IdGen,
  UnitOfWork,
  TaskWithCounts,
} from '#root/application/ports'

export interface SplitChildDraft {
  title: string
  description?: string
  acceptance_criteria?: string
  status?: TaskStatus
}

export interface SplitTaskInput extends ActorContext {
  taskId: string
  children: SplitChildDraft[]
}

export interface SplitTaskResult {
  parent: TaskWithCounts
  created: TaskRecord[]
}

export class SplitTask {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGen
  ) {}

  async run(input: SplitTaskInput): Promise<SplitTaskResult> {
    const now = this.clock.now().toISOString()
    if (input.children.length === 0) {
      throw new DomainError('invalid_request', 'split requires at least one child')
    }
    for (const child of input.children) {
      // ora-14 M-2: validate the PROVIDED status only — no fabricated default here (the
      // real default lives in the create call below, per Dev-2 derivation).
      if (child.status !== undefined && !TASK_STATUSES.includes(child.status)) {
        throw new DomainError('invalid_request', `unknown status '${child.status}'`)
      }
    }
    return this.uow.withTransaction(async (repos) => {
      const parent = await repos.tasks.findById(input.taskId)
      if (!parent) throw new DomainError('not_found', `task ${input.taskId} not found`)

      if (parent.claim_token_id) {
        await repos.tasks.clearClaim(input.taskId, now)
        await repos.audit.append({
          actor_id: input.actor.id,
          token_id: input.tokenId,
          action: 'claim_released',
          entity_type: 'task',
          entity_id: input.taskId,
          reason: 'claim released by split',
          created_at: now,
        })
      }

      const created: TaskRecord[] = []
      for (const child of input.children) {
        const position = await repos.tasks.nextPosition(input.taskId)
        const childTask = await repos.tasks.create({
          id: this.ids.newId('t'),
          parent_id: input.taskId,
          title: child.title,
          description: child.description ?? '',
          acceptance_criteria: child.acceptance_criteria ?? '',
          // Dev-2 (spec-review ruling): children of an ACTIVE (non-backlog) parent default to
          // 'todo' so "the ex-claimant continues by claiming one of the children" (spec §6.2)
          // is immediately claimable; backlog parents spawn backlog children. Explicit status
          // always wins. This is a DEFAULT derivation, never a gate — Ruling A unaffected.
          status: child.status ?? (parent.status === 'backlog' ? 'backlog' : 'todo'),
          position,
          created_by: input.actor.id,
          created_at: now,
          updated_at: now,
        })
        created.push(childTask)
      }

      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'task_split',
        entity_type: 'task',
        entity_id: input.taskId,
        after: { child_ids: created.map((c) => c.id) },
        reason: `split into ${created.length} children`,
        created_at: now,
      })

      const parentWithCounts = (await repos.tasks.findWithCounts(input.taskId)) as TaskWithCounts
      return { parent: parentWithCounts, created }
    })
  }
}
```

- [ ] **Step 8.3: Commit (typecheck deferred to Task 10 green):**

```bash
git add -A && git commit -m "feat(usecases): atomic SplitTask with auto claim-release (tests complete after claim use-cases)"
```

---

### Task 9: Use-case — UpdateStatus (invariants 2, 3, 5 + canceled terminal)

**Files:**

- Modify: `src/domain/errors.ts` (add `canceled_terminal` code)
- Create: `src/application/usecases/update-status.ts`
- Test: `src/application/usecases/update-status.test.ts`

- [ ] **Step 9.1: Extend the error union.** In `src/domain/errors.ts`, add `| 'canceled_terminal'` after `'threads_on_parent'` in `DomainErrorCode`, and add `canceled_terminal: 409,` to `DOMAIN_ERROR_STATUS`. (Spec §6.1: "cancel is terminal" — the machine-readable rejection code is `canceled_terminal`.)

- [ ] **Step 9.2: Write failing test** `src/application/usecases/update-status.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { CreateTask } from '#root/application/usecases/create-task'
import { ClaimTask } from '#root/application/usecases/claim-task'
import { UpdateStatus } from '#root/application/usecases/update-status'
import { SplitTask } from '#root/application/usecases/split-task'
import { buildUow, fixedClock, human, seqIds } from '#root/application/usecases/create-task.test'
import { seedActor, seedToken } from '#root/testing/fixtures'
import { SqliteAuditRepo } from '#root/infra/sqlite/audit-repo'
import type { ActorContext } from '#root/application/ports'

const agent: ActorContext = {
  actor: { id: 'a_agent', kind: 'agent', handle: 'hermes-1', display_name: 'Hermes' },
  tokenId: 'tok_agent',
}

const withAgent = async () => {
  const ctx = await buildUow()
  await seedActor(ctx.db, 'a_agent', 'agent', 'hermes-1')
  await seedToken(ctx.db, 'tok_agent', 'a_agent')
  return ctx
}

describe('UpdateStatus gates (spec §6.4)', () => {
  it('happy path: backlog → todo → in_progress (claimed) → in_review releases claim → human done', async () => {
    const { db, uow } = await withAgent()
    const task = await new CreateTask(uow, fixedClock(), seqIds()).run({ ...human, title: 'x' })
    const uc = new UpdateStatus(uow, fixedClock())
    await uc.run({ ...human, taskId: task.id, to: 'todo', reason: 'groomed' })
    const claim = await new ClaimTask(uow, fixedClock()).run({ ...agent, taskId: task.id })
    await uc.run({
      ...agent,
      taskId: task.id,
      to: 'in_review',
      reason: 'PR opened',
      lease_token: claim.lease_token,
    })

    const audit = await new SqliteAuditRepo(db).search({
      entity_type: 'task',
      entity_id: task.id,
      limit: 20,
    })
    expect(audit.some((a) => a.reason === 'claim released on review')).toBe(true)

    await uc.run({ ...human, taskId: task.id, to: 'done', reason: 'ship it' }) // claim gone → no token needed (D-c)
    await db.destroy()
  })

  it('invariant 3: claimed task without valid lease gets stale_lease', async () => {
    const { db, uow } = await withAgent()
    const task = await new CreateTask(uow, fixedClock(), seqIds()).run({
      ...human,
      title: 'x',
      status: 'todo',
    })
    const claim = await new ClaimTask(uow, fixedClock()).run({ ...agent, taskId: task.id })
    const uc = new UpdateStatus(uow, fixedClock())
    await expect(
      uc.run({ ...human, taskId: task.id, to: 'in_progress', reason: 'nudge' })
    ).rejects.toMatchObject({ code: 'stale_lease' })
    await expect(
      uc.run({
        ...human,
        taskId: task.id,
        to: 'in_progress',
        reason: 'nudge',
        lease_token: 't_wrong:1',
      })
    ).rejects.toMatchObject({ code: 'stale_lease' })
    await expect(
      uc.run({
        ...human,
        taskId: task.id,
        to: 'in_progress',
        reason: 'nudge',
        lease_token: `${task.id}:99`,
      })
    ).rejects.toMatchObject({ code: 'stale_lease' })
    // the actual holder succeeds
    await expect(
      uc.run({
        ...agent,
        taskId: task.id,
        to: 'in_review',
        reason: 'ok',
        lease_token: claim.lease_token,
      })
    ).resolves.toBeTruthy()
    await db.destroy()
  })

  it('invariant 2: open_descendants blocks done', async () => {
    const { db, uow } = await withAgent()
    const parent = await new CreateTask(uow, fixedClock(), seqIds()).run({
      ...human,
      title: 'p',
      status: 'todo',
    })
    const split = await new SplitTask(uow, fixedClock(), seqIds()).run({
      ...human,
      taskId: parent.id,
      children: [{ title: 'c1', status: 'in_progress' }],
    })
    const uc = new UpdateStatus(uow, fixedClock())
    await expect(
      uc.run({ ...human, taskId: parent.id, to: 'done', reason: 'x' })
    ).rejects.toMatchObject({
      code: 'open_descendants',
    })
    await uc.run({ ...human, taskId: split.created[0]!.id, to: 'canceled', reason: 'dropped' })
    await expect(
      uc.run({ ...human, taskId: parent.id, to: 'done', reason: 'x' })
    ).resolves.toBeTruthy()
    await db.destroy()
  })

  it('invariant 5: agent cannot set done while review_gate on; policy off allows; human always allowed', async () => {
    const { db, uow } = await withAgent()
    const task = await new CreateTask(uow, fixedClock(), seqIds()).run({
      ...human,
      title: 'x',
      status: 'todo',
    })
    const uc = new UpdateStatus(uow, fixedClock())
    await expect(
      uc.run({ ...agent, taskId: task.id, to: 'done', reason: 'yolo' })
    ).rejects.toMatchObject({
      code: 'agent_close_forbidden',
    })
    // admin flips policy off
    await uow.withTransaction(async (repos) => repos.actors.setPolicy('review_gate', 'off'))
    await expect(
      uc.run({ ...agent, taskId: task.id, to: 'done', reason: 'yolo' })
    ).resolves.toBeTruthy()
    await db.destroy()
  })

  it('canceled is terminal (D-m: canceled_terminal)', async () => {
    const { db, uow } = await withAgent()
    const task = await new CreateTask(uow, fixedClock(), seqIds()).run({ ...human, title: 'x' })
    const uc = new UpdateStatus(uow, fixedClock())
    await uc.run({ ...human, taskId: task.id, to: 'canceled', reason: 'nope' })
    await expect(
      uc.run({ ...human, taskId: task.id, to: 'todo', reason: 'reconsider' })
    ).rejects.toMatchObject({
      code: 'canceled_terminal',
    })
    await db.destroy()
  })

  it('unknown task → not_found; empty reason → invalid_request', async () => {
    const { db, uow } = await withAgent()
    const uc = new UpdateStatus(uow, fixedClock())
    await expect(
      uc.run({ ...human, taskId: 't_ghost', to: 'todo', reason: 'x' })
    ).rejects.toMatchObject({
      code: 'not_found',
    })
    const task = await new CreateTask(uow, fixedClock(), seqIds()).run({ ...human, title: 'x' })
    await expect(
      uc.run({ ...human, taskId: task.id, to: 'todo', reason: '  ' })
    ).rejects.toMatchObject({
      code: 'invalid_request',
    })
    await db.destroy()
  })

  it('invariant 6 (question gate): open human-assigned question gates agent in_review — Plan B wires the repo; here the seam is exercised with zero questions', async () => {
    const { db, uow } = await withAgent()
    const task = await new CreateTask(uow, fixedClock(), seqIds()).run({
      ...human,
      title: 'x',
      status: 'todo',
    })
    const claim = await new ClaimTask(uow, fixedClock()).run({ ...agent, taskId: task.id })
    // with no questions present, in_review succeeds:
    await expect(
      new UpdateStatus(uow, fixedClock()).run({
        ...agent,
        taskId: task.id,
        to: 'in_review',
        reason: 'pr',
        lease_token: claim.lease_token,
      })
    ).resolves.toBeTruthy()
    await db.destroy()
  })
})
```

- [ ] **Step 9.3: Implement `src/application/usecases/update-status.ts`:**

```ts
import { TASK_STATUSES, type TaskRecord, type TaskStatus } from '#root/domain/task'
import { parseLeaseToken } from '#root/domain/claim'
import { DomainError } from '#root/domain/errors'
import type { ActorContext, Clock, UnitOfWork } from '#root/application/ports'

export interface UpdateStatusInput extends ActorContext {
  taskId: string
  to: TaskStatus
  reason: string
  lease_token?: string
}

export class UpdateStatus {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock
  ) {}

  async run(input: UpdateStatusInput): Promise<TaskRecord> {
    const now = this.clock.now().toISOString()
    if (!input.reason || input.reason.trim() === '') {
      throw new DomainError('invalid_request', 'status changes require a reason (spec §6.7)')
    }
    // ora-14 M-5: uniform input validation with the sibling use-cases (create/split) — a
    // bogus `to` is rejected as invalid_request, not left to SQLite or silent acceptance.
    if (!TASK_STATUSES.includes(input.to)) {
      throw new DomainError('invalid_request', `unknown status '${input.to}'`)
    }
    return this.uow.withTransaction(async (repos) => {
      const task = await repos.tasks.findById(input.taskId)
      if (!task) throw new DomainError('not_found', `task ${input.taskId} not found`)
      if (task.status === 'canceled') {
        throw new DomainError(
          'canceled_terminal',
          `task ${input.taskId} is canceled; cancel is terminal`
        )
      }

      // Invariant 3: any transition of a claimed task requires its current fencing token.
      if (task.claim_token_id !== null) {
        const ref = parseLeaseToken(input.lease_token)
        if (!ref || ref.taskId !== input.taskId || ref.generation !== task.claim_generation) {
          throw new DomainError('stale_lease', 'task is claimed; current lease_token required', {
            claimed: true,
          })
        }
        // Dev-1 (spec-review ruling): a lease presented on an UNCLAIMED task is a zombie
        // (released by split/review) — D-b: "an old token can never validate again". The
        // plan's original silent-accept contradicted Task 8's own 'old lease can never be
        // used again' test. An ABSENT lease on an unclaimed task stays allowed (D-c human
        // closes).
      } else if (input.lease_token !== undefined) {
        throw new DomainError('stale_lease', 'task is not claimed; lease token is stale', {
          claimed: false,
        })
      }

      if (input.to === 'done') {
        const gate = await repos.actors.getPolicy('review_gate')
        if ((gate ?? 'on') === 'on' && input.actor.kind === 'agent') {
          throw new DomainError(
            'agent_close_forbidden',
            'agents may move work to in_review, not done (spec §6.4.5)'
          )
        }
        // Invariant 6 seam: Plan B adds "open question assigned to a human → open_questions 409" here.
        const openDesc = await repos.tasks.countOpenDescendants(input.taskId)
        if (openDesc > 0) {
          throw new DomainError('open_descendants', `${openDesc} descendants still open`, {
            open: openDesc,
          })
        }
      }

      await repos.tasks.setStatus(input.taskId, input.to, now)

      // D-c: leave review/done un-claimed so humans can close without a lease.
      if ((input.to === 'in_review' || input.to === 'done') && task.claim_token_id !== null) {
        await repos.tasks.clearClaim(input.taskId, now)
        await repos.audit.append({
          actor_id: input.actor.id,
          token_id: input.tokenId,
          action: 'claim_released',
          entity_type: 'task',
          entity_id: input.taskId,
          reason: 'claim released on review',
          created_at: now,
        })
      }

      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'status_changed',
        entity_type: 'task',
        entity_id: input.taskId,
        before: { status: task.status },
        after: { status: input.to },
        reason: input.reason,
        created_at: now,
      })

      return (await repos.tasks.findById(input.taskId)) as TaskRecord
    })
  }
}
```

- [ ] **Step 9.4: Commit (green after Task 10 provides ClaimTask):**

```bash
git add -A && git commit -m "feat(usecases): UpdateStatus with invariants 2/3/5, review-gate policy, claim release on review"
```

---

### Task 10: Use-cases — ClaimTask, ReleaseClaim, Heartbeat (invariants 1, 3, 4) + model-based interleaving test

**Files:**

- Modify: `src/application/ports.ts` (add `findActorByTokenId` to `ActorRepo`)
- Modify: `src/infra/sqlite/actor-repo.ts` (implement it)
- Create: `src/application/usecases/claim-task.ts`, `src/application/usecases/release-claim.ts`, `src/application/usecases/heartbeat.ts`
- Test: `src/application/usecases/claim-task.test.ts`

- [ ] **Step 10.1: Extend `ActorRepo`.** In `src/application/ports.ts`, inside `interface ActorRepo`, add:

```ts
  /** Actor that owns the given token id (for exposing a claim holder's public identity). */
  findActorByTokenId(tokenId: string): Promise<ActorRow | null>
```

In `src/infra/sqlite/actor-repo.ts`, implement:

```ts
  async findActorByTokenId(tokenId: string): Promise<ActorRow | null> {
    const r = await this.db
      .selectFrom('actors')
      .selectAll()
      .innerJoin('tokens', 'tokens.actor_id', 'actors.id')
      .where('tokens.id', '=', tokenId)
      .executeTakeFirst()
    return (r as ActorRow | undefined) ?? null
  }
```

- [ ] **Step 10.2: Write failing test** `src/application/usecases/claim-task.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { CreateTask } from '#root/application/usecases/create-task'
import { ClaimTask } from '#root/application/usecases/claim-task'
import { ReleaseClaim } from '#root/application/usecases/release-claim'
import { Heartbeat } from '#root/application/usecases/heartbeat'
import { UpdateStatus } from '#root/application/usecases/update-status'
import { SplitTask } from '#root/application/usecases/split-task'
import { buildUow, fixedClock, human, seqIds } from '#root/application/usecases/create-task.test'
import { seedActor, seedToken } from '#root/testing/fixtures'
import { SqliteTaskRepo } from '#root/infra/sqlite/task-repo'
import { formatLeaseToken } from '#root/domain/claim'
import type { ActorContext } from '#root/application/ports'

const agentA: ActorContext = {
  actor: { id: 'a_agent_a', kind: 'agent', handle: 'hermes-a', display_name: 'Hermes A' },
  tokenId: 'tok_a',
}
const agentB: ActorContext = {
  actor: { id: 'a_agent_b', kind: 'agent', handle: 'hermes-b', display_name: 'Hermes B' },
  tokenId: 'tok_b',
}

const setup = async () => {
  const { db, uow } = await buildUow()
  await seedActor(db, 'a_agent_a', 'agent', 'hermes-a')
  await seedActor(db, 'a_agent_b', 'agent', 'hermes-b')
  await seedToken(db, 'tok_a', 'a_agent_a')
  await seedToken(db, 'tok_b', 'a_agent_b')
  const task = await new CreateTask(uow, fixedClock(), seqIds()).run({
    ...human,
    title: 'work',
    status: 'todo',
  })
  return { db, uow, task }
}

describe('ClaimTask exclusivity (spec §6.4.1/4)', () => {
  it('first claim wins, second gets already_claimed with holder identity, release frees it', async () => {
    const { db, uow, task } = await setup()
    const claimUc = new ClaimTask(uow, fixedClock())
    const won = await claimUc.run({ ...agentA, taskId: task.id })
    expect(won).toEqual({ lease_token: formatLeaseToken(task.id, 1), generation: 1 })

    await expect(claimUc.run({ ...agentB, taskId: task.id })).rejects.toMatchObject({
      code: 'already_claimed',
      details: { holder_handle: 'hermes-a' },
    })

    await new ReleaseClaim(uow, fixedClock()).run({ ...agentA, taskId: task.id })
    const second = await claimUc.run({ ...agentB, taskId: task.id })
    expect(second.generation).toBe(3) // 1: claim, 2: release-bump, 3: re-claim

    const after = await new SqliteTaskRepo(db).findById(task.id)
    expect(after?.claim_token_id).toBe('tok_b')
    expect(after?.assignee_id).toBe('a_agent_b')
    await db.destroy()
  })

  it('gates: not_a_leaf on parent, invalid_request on backlog, canceled_terminal, token required', async () => {
    const { db, uow, task } = await setup()
    const split = await new SplitTask(uow, fixedClock(), seqIds()).run({
      ...human,
      taskId: task.id,
      children: [{ title: 'c' }],
    })
    await expect(
      new ClaimTask(uow, fixedClock()).run({ ...agentA, taskId: task.id })
    ).rejects.toMatchObject({ code: 'not_a_leaf' })

    const backlog = await new CreateTask(uow, fixedClock(), seqIds()).run({ ...human, title: 'b' })
    await expect(
      new ClaimTask(uow, fixedClock()).run({ ...agentA, taskId: backlog.id })
    ).rejects.toMatchObject({ code: 'invalid_request' })

    const canceled = await new CreateTask(uow, fixedClock(), seqIds()).run({ ...human, title: 'z' })
    await new UpdateStatus(uow, fixedClock()).run({
      ...human,
      taskId: canceled.id,
      to: 'canceled',
      reason: 'drop',
    })
    await expect(
      new ClaimTask(uow, fixedClock()).run({ ...agentA, taskId: canceled.id })
    ).rejects.toMatchObject({ code: 'canceled_terminal' })

    await expect(
      new ClaimTask(uow, fixedClock()).run({ ...human, taskId: split.created[0]!.id })
    ).rejects.toMatchObject({ code: 'invalid_request' }) // human bootstrap w/o tokenId cannot claim
    await db.destroy()
  })

  it('release/heartbeat require the current claim', async () => {
    const { db, uow, task } = await setup()
    await expect(
      new ReleaseClaim(uow, fixedClock()).run({ ...agentA, taskId: task.id })
    ).rejects.toMatchObject({
      code: 'stale_lease',
    })
    const claim = await new ClaimTask(uow, fixedClock()).run({ ...agentA, taskId: task.id })

    await expect(
      new Heartbeat(uow, fixedClock()).run({
        ...agentB,
        taskId: task.id,
        lease_token: claim.lease_token,
      })
    ).rejects.toMatchObject({ code: 'stale_lease' })
    await expect(
      new Heartbeat(uow, fixedClock()).run({
        ...agentA,
        taskId: task.id,
        lease_token: `${task.id}:99`,
      })
    ).rejects.toMatchObject({ code: 'stale_lease' })

    const alive = await new Heartbeat(uow, fixedClock()).run({
      ...agentA,
      taskId: task.id,
      lease_token: claim.lease_token,
    })
    expect(alive.last_heartbeat_at).toBe('2026-05-05T05:05:05.000Z')

    // B cannot release A's claim; A can
    await expect(
      new ReleaseClaim(uow, fixedClock()).run({ ...agentB, taskId: task.id })
    ).rejects.toMatchObject({
      code: 'stale_lease',
    })
    const released = await new ReleaseClaim(uow, fixedClock()).run({ ...agentA, taskId: task.id })
    expect(released.claim_token_id).toBeNull()
    await db.destroy()
  })
})

// Spec §11.1: model-based claim/release interleavings.
describe('claim/release/status interleavings (model-based, spec §6.4.3/4)', () => {
  it('no stale lease ever accepted; generation and holder always match the model', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.constantFrom(
            'claimA',
            'claimB',
            'releaseHolder',
            'statusWithOldToken',
            'statusWithLiveToken'
          ),
          { maxLength: 15 }
        ),
        async (ops) => {
          const { db, uow, task } = await setup()
          // ora-14 M-7b: destroy even on assertion failure — a leaking in-memory db per
          // shrunk run starves the property of runs.
          try {
            const claimants: Record<'A' | 'B', ActorContext> = { A: agentA, B: agentB }
            const claimUc = new ClaimTask(uow, fixedClock())
            const releaseUc = new ReleaseClaim(uow, fixedClock())
            const statusUc = new UpdateStatus(uow, fixedClock())

            let holder: 'A' | 'B' | null = null
            let generation = 0
            let liveToken = ''
            let oldToken = ''

            for (const op of ops) {
              if (op === 'claimA' || op === 'claimB') {
                const who = op === 'claimA' ? ('A' as const) : ('B' as const)
                if (holder === null) {
                  const res = await claimUc.run({ ...claimants[who], taskId: task.id })
                  generation += 1
                  expect(res.generation).toBe(generation)
                  expect(res.lease_token).toBe(formatLeaseToken(task.id, generation))
                  if (liveToken) oldToken = liveToken
                  holder = who
                  liveToken = res.lease_token
                } else {
                  const loser = who === 'A' ? 'B' : 'A'
                  await expect(
                    claimUc.run({ ...claimants[loser], taskId: task.id })
                  ).rejects.toMatchObject({ code: 'already_claimed' })
                }
              } else if (op === 'releaseHolder') {
                if (holder === null) {
                  await expect(releaseUc.run({ ...agentA, taskId: task.id })).rejects.toMatchObject(
                    {
                      code: 'stale_lease',
                    }
                  )
                } else {
                  await releaseUc.run({ ...claimants[holder], taskId: task.id })
                  oldToken = liveToken
                  liveToken = ''
                  holder = null
                  generation += 1
                }
              } else if (op === 'statusWithOldToken') {
                if (holder !== null && oldToken) {
                  await expect(
                    statusUc.run({
                      ...claimants[holder],
                      taskId: task.id,
                      to: 'in_progress',
                      reason: 'zombie',
                      lease_token: oldToken,
                    })
                  ).rejects.toMatchObject({ code: 'stale_lease' })
                } else if (holder === null) {
                  if (oldToken) {
                    // ora-14 M-4 (Dev-1 pin): on an UNCLAIMED task a PRESENTED old token is
                    // rejected as a zombie (claimed:false) — it must never morph into the
                    // tokenless human op that an ABSENT lease permits (D-c).
                    await expect(
                      statusUc.run({
                        ...human,
                        taskId: task.id,
                        to: 'in_progress',
                        reason: 'zombie',
                        lease_token: oldToken,
                      })
                    ).rejects.toMatchObject({ code: 'stale_lease', details: { claimed: false } })
                  } else {
                    await statusUc.run({
                      ...human,
                      taskId: task.id,
                      to: 'in_progress',
                      reason: 'by hand',
                    })
                  }
                }
              } else {
                // statusWithLiveToken
                if (holder !== null) {
                  await statusUc.run({
                    ...claimants[holder],
                    taskId: task.id,
                    to: 'in_progress',
                    reason: 'progress',
                    lease_token: liveToken,
                  })
                } else {
                  await statusUc.run({
                    ...human,
                    taskId: task.id,
                    to: 'in_progress',
                    reason: 'by hand',
                  })
                }
              }
            }

            const final = await new SqliteTaskRepo(db).findById(task.id)
            expect(final?.claim_generation).toBe(generation)
            expect(final?.claim_token_id !== null).toBe(holder !== null)
          } finally {
            await db.destroy()
          }
        }
      ),
      { numRuns: 40 }
    )
  })
})
```

- [ ] **Step 10.3: Implement `src/application/usecases/claim-task.ts`:**

```ts
import { formatLeaseToken } from '#root/domain/claim'
import { DomainError } from '#root/domain/errors'
import type { TaskStatus } from '#root/domain/task'
import type { ActorContext, Clock, UnitOfWork } from '#root/application/ports'

export interface ClaimTaskInput extends ActorContext {
  taskId: string
}

export interface ClaimResult {
  lease_token: string
  generation: number
}

export class ClaimTask {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock
  ) {}

  async run(input: ClaimTaskInput): Promise<ClaimResult> {
    const now = this.clock.now().toISOString()
    if (!input.tokenId) {
      throw new DomainError('invalid_request', 'claiming requires an authenticated token')
    }
    return this.uow.withTransaction(async (repos) => {
      const task = await repos.tasks.findById(input.taskId)
      if (!task) throw new DomainError('not_found', `task ${input.taskId} not found`)
      if (task.status === 'canceled') {
        throw new DomainError('canceled_terminal', `task ${input.taskId} is canceled`)
      }
      if (task.status !== 'todo' && task.status !== 'in_progress') {
        throw new DomainError('invalid_request', `task in status '${task.status}' is not claimable`)
      }
      // Invariant 1 / D6: leaf-claim
      if (await repos.tasks.hasChildren(input.taskId)) {
        throw new DomainError('not_a_leaf', 'work happens on leaves; claim a child instead')
      }

      const alreadyClaimed = async (): Promise<DomainError> => {
        // ora-14 M-1: FRESH re-read — after a lost CAS the current row, not the first read's
        // claim_token_id, is the truth about who holds the claim today.
        const fresh = await repos.tasks.findById(input.taskId)
        const holder = fresh?.claim_token_id
          ? await repos.actors.findActorByTokenId(fresh.claim_token_id)
          : null
        return new DomainError(
          'already_claimed',
          `task is claimed by ${holder?.display_name ?? 'another actor'}`,
          {
            holder_handle: holder?.handle ?? null,
            holder_display_name: holder?.display_name ?? null,
          }
        )
      }

      if (task.claim_token_id) throw await alreadyClaimed()

      const newStatus: TaskStatus = task.status === 'todo' ? 'in_progress' : task.status
      const result = await repos.tasks.tryClaim(
        task.id,
        input.tokenId,
        input.actor.id,
        newStatus,
        now
      )
      if (!result) throw await alreadyClaimed() // lost a race between check and CAS

      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'claim_acquired',
        entity_type: 'task',
        entity_id: task.id,
        after: { generation: result.generation },
        reason: 'claim acquired',
        created_at: now,
      })
      return {
        lease_token: formatLeaseToken(task.id, result.generation),
        generation: result.generation,
      }
    })
  }
}
```

- [ ] **Step 10.4: Implement `src/application/usecases/release-claim.ts`:**

```ts
import type { TaskRecord } from '#root/domain/task'
import { DomainError } from '#root/domain/errors'
import type { ActorContext, Clock, UnitOfWork } from '#root/application/ports'

export interface ReleaseClaimInput extends ActorContext {
  taskId: string
}

// Three auth models in the claim family (deliberate asymmetry, ora-14 M-3): claim = exclusivity
// CAS (first writer wins); update-status/heartbeat = capability (lease_token string: taskId +
// generation); release = identity (tokenId === claim_token_id) — release has no lease_token field.
export class ReleaseClaim {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock
  ) {}

  async run(input: ReleaseClaimInput): Promise<TaskRecord> {
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      const task = await repos.tasks.findById(input.taskId)
      if (!task) throw new DomainError('not_found', `task ${input.taskId} not found`)
      if (!input.tokenId || task.claim_token_id !== input.tokenId) {
        throw new DomainError('stale_lease', 'only the active claim holder can release', {
          claimed: task.claim_token_id !== null,
        })
      }
      await repos.tasks.clearClaim(input.taskId, now)
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'claim_released',
        entity_type: 'task',
        entity_id: input.taskId,
        reason: 'claim released',
        created_at: now,
      })
      return (await repos.tasks.findById(input.taskId)) as TaskRecord
    })
  }
}
```

- [ ] **Step 10.5: Implement `src/application/usecases/heartbeat.ts`:**

```ts
import type { TaskRecord } from '#root/domain/task'
import { parseLeaseToken } from '#root/domain/claim'
import { DomainError } from '#root/domain/errors'
import type { ActorContext, Clock, UnitOfWork } from '#root/application/ports'

export interface HeartbeatInput extends ActorContext {
  taskId: string
  lease_token: string
}

/** Liveness record only — no keepalive enforcement in v1 (spec §3, §12). */
export class Heartbeat {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock
  ) {}

  async run(input: HeartbeatInput): Promise<TaskRecord> {
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      const task = await repos.tasks.findById(input.taskId)
      if (!task) throw new DomainError('not_found', `task ${input.taskId} not found`)
      const ref = parseLeaseToken(input.lease_token)
      const current =
        task.claim_token_id !== null &&
        input.tokenId === task.claim_token_id &&
        ref !== null &&
        ref.taskId === input.taskId &&
        ref.generation === task.claim_generation
      if (!current) {
        throw new DomainError('stale_lease', 'heartbeat requires the current lease', {
          claimed: task.claim_token_id !== null,
        })
      }
      await repos.tasks.setHeartbeat(input.taskId, now)
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'heartbeat',
        entity_type: 'task',
        entity_id: input.taskId,
        reason: 'liveness recorded',
        created_at: now,
      })
      return (await repos.tasks.findById(input.taskId)) as TaskRecord
    })
  }
}
```

- [ ] **Step 10.6: Verify Tasks 8–10 green together** (splits/status tests referenced `ClaimTask`; everything resolves now):

```bash
pnpm test && pnpm lint && pnpm typecheck
```

Expected: all tests pass. If a Task 8/9 test fails, fix **the test file or the use-case per the spec decision record in the plan header** — never weaken an invariant.

- [ ] **Step 10.7: Commit.**

```bash
git add -A && git commit -m "feat(usecases): ClaimTask/Release/Heartbeat with fencing + model-based interleaving tests"
```

---

### Task 11: Use-cases — AddBlock, RemoveBlock (invariant 7, cycle detection)

**Files:**

- Create: `src/application/usecases/add-block.ts`, `src/application/usecases/remove-block.ts`
- Test: `src/application/usecases/add-block.test.ts`

REST orientation (locks the direction): `PUT /tasks/{id}/blocks/{blockerId}` ⇒ **`blockerId` blocks `id`**.

- [ ] **Step 11.1: Write failing test** `src/application/usecases/add-block.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { CreateTask } from '#root/application/usecases/create-task'
import { AddBlock } from '#root/application/usecases/add-block'
import { RemoveBlock } from '#root/application/usecases/remove-block'
import { GetContext } from '#root/application/usecases/get-context'
import { buildUow, fixedClock, human, seqIds } from '#root/application/usecases/create-task.test'
import { SqliteAuditRepo } from '#root/infra/sqlite/audit-repo'

describe('AddBlock / RemoveBlock (spec §6.3)', () => {
  it('adds an edge, surfaces it in context, and audits it', async () => {
    const { db, uow } = await buildUow()
    const create = new CreateTask(uow, fixedClock(), seqIds())
    const blocker = await create.run({ ...human, title: 'blocker', status: 'todo' })
    const blocked = await create.run({ ...human, title: 'blocked', status: 'todo' })

    await new AddBlock(uow, fixedClock()).run({
      ...human,
      taskId: blocked.id,
      blocker_id: blocker.id,
    })
    const ctx = await new GetContext(
      (await import('#root/infra/sqlite/task-repo')).SqliteTaskRepo, // type anchor removed in final; see impl note
      blocked.id
    ).peek(blocked.id)
    void ctx

    const audit = await new SqliteAuditRepo(db).search({
      entity_type: 'task',
      entity_id: blocked.id,
      limit: 10,
    })
    expect(audit.some((a) => a.action === 'block_added')).toBe(true)
    await db.destroy()
  })

  it('rejects self-block and cycles with dependency_cycle', async () => {
    const { db, uow } = await buildUow()
    const create = new CreateTask(uow, fixedClock(), seqIds())
    const a = await create.run({ ...human, title: 'a' })
    const b = await create.run({ ...human, title: 'b' })
    const add = new AddBlock(uow, fixedClock())

    await expect(add.run({ ...human, taskId: a.id, blocker_id: a.id })).rejects.toMatchObject({
      code: 'invalid_request',
    })
    await add.run({ ...human, taskId: b.id, blocker_id: a.id }) // a blocks b
    await expect(add.run({ ...human, taskId: a.id, blocker_id: b.id })).rejects.toMatchObject({
      code: 'dependency_cycle',
    })
    await db.destroy()
  })

  it('remove is idempotent; unknown tasks are not_found', async () => {
    const { db, uow } = await buildUow()
    const create = new CreateTask(uow, fixedClock(), seqIds())
    const a = await create.run({ ...human, title: 'a' })
    const b = await create.run({ ...human, title: 'b' })
    await new AddBlock(uow, fixedClock()).run({ ...human, taskId: b.id, blocker_id: a.id })
    const rm = new RemoveBlock(uow, fixedClock())
    await rm.run({ ...human, taskId: b.id, blocker_id: a.id })
    await rm.run({ ...human, taskId: b.id, blocker_id: a.id }) // idempotent
    await expect(
      new AddBlock(uow, fixedClock()).run({ ...human, taskId: 't_ghost', blocker_id: a.id })
    ).rejects.toMatchObject({ code: 'not_found' })
    await db.destroy()
  })
})
```

**Implementer note:** the `GetContext(...)` block in the first test is scaffolding noise — delete it and the `void ctx` line; Task 12's own test file covers context assertions. Keep only the create/add/audit assertions.

- [ ] **Step 11.2: Implement `src/application/usecases/add-block.ts`:**

```ts
import { DomainError } from '#root/domain/errors'
import type { ActorContext, Clock, UnitOfWork } from '#root/application/ports'

export interface AddBlockInput extends ActorContext {
  /** the blocked task */
  taskId: string
  /** the blocker */
  blocker_id: string
}

export class AddBlock {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock
  ) {}

  async run(input: AddBlockInput): Promise<void> {
    const now = this.clock.now().toISOString()
    if (input.taskId === input.blocker_id) {
      throw new DomainError('invalid_request', 'a task cannot block itself')
    }
    return this.uow.withTransaction(async (repos) => {
      const blocked = await repos.tasks.findById(input.taskId)
      if (!blocked) throw new DomainError('not_found', `task ${input.taskId} not found`)
      const blocker = await repos.tasks.findById(input.blocker_id)
      if (!blocker) throw new DomainError('not_found', `blocker ${input.blocker_id} not found`)
      if (await repos.deps.wouldCycle(input.blocker_id, input.taskId)) {
        throw new DomainError(
          'dependency_cycle',
          `adding ${input.blocker_id} -> ${input.taskId} would create a cycle`
        )
      }
      await repos.deps.add(input.blocker_id, input.taskId)
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'block_added',
        entity_type: 'task',
        entity_id: input.taskId,
        after: { blocker_id: input.blocker_id, blocked_id: input.taskId },
        reason: 'dependency added',
        created_at: now,
      })
    })
  }
}
```

- [ ] **Step 11.3: Implement `src/application/usecases/remove-block.ts`:**

```ts
import { DomainError } from '#root/domain/errors'
import type { ActorContext, Clock, UnitOfWork } from '#root/application/ports'

export interface RemoveBlockInput extends ActorContext {
  taskId: string
  blocker_id: string
}

export class RemoveBlock {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock
  ) {}

  async run(input: RemoveBlockInput): Promise<void> {
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      const blocked = await repos.tasks.findById(input.taskId)
      if (!blocked) throw new DomainError('not_found', `task ${input.taskId} not found`)
      await repos.deps.remove(input.blocker_id, input.taskId)
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'block_removed',
        entity_type: 'task',
        entity_id: input.taskId,
        after: { blocker_id: input.blocker_id, blocked_id: input.taskId },
        reason: 'dependency removed',
        created_at: now,
      })
    })
  }
}
```

- [ ] **Step 11.4: Verify green, hygiene, commit.**

```bash
pnpm test src/application/usecases/add-block.test.ts && git add -A && git commit -m "feat(usecases): AddBlock/RemoveBlock with cycle rejection"
```

---

### Task 12: Queries — GetNext (ready work) and GetContext (one-call bundle)

**Files:**

- Create: `src/application/usecases/get-next.ts`, `src/application/usecases/get-context.ts`
- Test: `src/application/usecases/queries.test.ts`

- [ ] **Step 12.1: Write failing test** `src/application/usecases/queries.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { CreateTask } from '#root/application/usecases/create-task'
import { ClaimTask } from '#root/application/usecases/claim-task'
import { GetNext } from '#root/application/usecases/get-next'
import { GetContext } from '#root/application/usecases/get-context'
import { buildUow, fixedClock, human, seqIds } from '#root/application/usecases/create-task.test'
import { SqliteTaskRepo } from '#root/infra/sqlite/task-repo'
import { SqliteDependencyRepo } from '#root/infra/sqlite/dependency-repo'
import { SqliteLabelRepo } from '#root/infra/sqlite/label-repo'
import { seedActor, seedToken } from '#root/testing/fixtures'
import { AddBlock } from '#root/application/usecases/add-block'
import type { ActorContext } from '#root/application/ports'

const agent: ActorContext = {
  actor: { id: 'a_agent', kind: 'agent', handle: 'hermes-1', display_name: 'Hermes' },
  tokenId: 'tok_agent',
}

const setup = async () => {
  const { db, uow } = await buildUow()
  await seedActor(db, 'a_agent', 'agent', 'hermes-1')
  await seedToken(db, 'tok_agent', 'a_agent')
  const repos = {
    tasks: new SqliteTaskRepo(db),
    deps: new SqliteDependencyRepo(db),
    labels: new SqliteLabelRepo(db),
  }
  return { db, uow, repos }
}

describe('GetNext (spec §7.2 ready-work query)', () => {
  it('returns only ready leaves, ordered by position, label-filterable, limit respected', async () => {
    const { db, uow, repos } = await setup()
    const create = new CreateTask(uow, fixedClock(), seqIds())
    // oracle ruling A: spec §6.3 has NO parent gate — a todo leaf under a live todo
    // parent IS ready. Parent created first so positions are deterministic:
    // roots p=1, a=2, b=3, c=4(backlog); p1 = position 1 under p. Ready order: [p1, a, b].
    const parent = await create.run({ ...human, title: 'p', status: 'todo' })
    const a = await create.run({ ...human, title: 'a', status: 'todo', labels: ['infra'] })
    const b = await create.run({ ...human, title: 'b', status: 'todo', labels: ['ui'] })
    const backlog = await create.run({ ...human, title: 'c' })
    const p1 = await create.run({ ...human, title: 'p1', parent_id: parent.id, status: 'todo' })

    const next = new GetNext(repos.tasks)
    expect((await next.run({})).map((t) => t.task.id)).toEqual([p1.id, a.id, b.id])
    expect((await next.run({ label: 'ui' })).map((t) => t.task.id)).toEqual([b.id])
    expect((await next.run({ limit: 1 })).map((t) => t.task.id)).toEqual([p1.id])

    // claiming removes it from ready
    await new ClaimTask(uow, fixedClock()).run({ ...agent, taskId: a.id })
    expect((await next.run({})).map((t) => t.task.id)).toEqual([p1.id, b.id])
    void backlog
    void parent
    await db.destroy()
  })
})

describe('GetContext (spec §7.2 one-call bundle)', () => {
  it('bundles task + ancestors + unmet blockers + labels, with Plan B/C seams empty', async () => {
    const { db, uow, repos } = await setup()
    const create = new CreateTask(uow, fixedClock(), seqIds())
    const root = await create.run({ ...human, title: 'root', acceptance_criteria: 'ROOT-AC' })
    const mid = await create.run({ ...human, title: 'mid', parent_id: root.id, status: 'todo' })
    const leaf = await create.run({
      ...human,
      title: 'leaf',
      parent_id: mid.id,
      status: 'todo',
      labels: ['infra'],
      acceptance_criteria: 'LEAF-AC',
    })
    const blocker = await create.run({ ...human, title: 'blocker', status: 'in_progress' })
    await new AddBlock(uow, fixedClock()).run({ ...human, taskId: leaf.id, blocker_id: blocker.id })

    const bundle = await new GetContext(repos.tasks, repos.deps, repos.labels).run({
      taskId: leaf.id,
    })
    expect(bundle.task.acceptance_criteria).toBe('LEAF-AC')
    expect(bundle.ancestors.map((a) => a.title)).toEqual(['root', 'mid'])
    expect(bundle.ancestors[0]?.acceptance_criteria).toBe('ROOT-AC')
    expect(bundle.blockers.map((b) => b.id)).toEqual([blocker.id])
    expect(bundle.labels.map((l) => l.name)).toEqual(['infra'])
    expect(bundle.unmet_blockers).toBe(1)
    // seams (spec §7.2 mentions these fields; populated by Plan B/C):
    expect(bundle.open_questions).toEqual([])
    expect(bundle.links).toEqual([])
    expect(bundle.attachments).toEqual([])
    await db.destroy()
  })

  it('unknown task → not_found', async () => {
    const { db, repos } = await setup()
    await expect(
      new GetContext(repos.tasks, repos.deps, repos.labels).run({ taskId: 't_ghost' })
    ).rejects.toMatchObject({ code: 'not_found' })
    await db.destroy()
  })
})
```

- [ ] **Step 12.2: Implement `src/application/usecases/get-next.ts`:**

```ts
import { isTaskReady } from '#root/domain/ready'
import type { TaskRepo, TaskWithCounts } from '#root/application/ports'

export interface GetNextInput {
  label?: string
  limit?: number
}

export class GetNext {
  constructor(private readonly tasks: TaskRepo) {}

  /**
   * The SQL in `listReady` is a coarse pre-filter; the domain predicate
   * (`domain/ready.ts`) is the authoritative gate (spec §6.3/§9: invariants live in the domain).
   */
  async run(input: GetNextInput): Promise<TaskWithCounts[]> {
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 100)
    const rows = await this.tasks.listReady({ label: input.label, limit })
    return rows.filter((r) =>
      isTaskReady({
        status: r.task.status,
        blocked_flag: r.task.blocked_flag,
        child_count: r.child_count,
        claim_holder: r.task.claim_token_id !== null,
        unmet_blockers: r.unmet_blockers,
      })
    )
  }
}
```

- [ ] **Step 12.3: Implement `src/application/usecases/get-context.ts`:**

```ts
import type { TaskRecord, TaskStatus } from '#root/domain/task'
import { DomainError } from '#root/domain/errors'
import type {
  BlockerRow,
  DependencyRepo,
  LabelRow,
  LabelRepo,
  TaskRepo,
} from '#root/application/ports'

export interface ContextAncestor {
  id: string
  title: string
  status: TaskStatus
  acceptance_criteria: string
}

export interface TaskContextBundle {
  task: TaskRecord
  child_count: number
  unmet_blockers: number
  ancestors: ContextAncestor[]
  blockers: BlockerRow[]
  labels: LabelRow[]
  /** seams — populated in Plan B (threads) / later plans; shape fixed by spec §7.2 */
  open_questions: unknown[]
  links: unknown[]
  attachments: unknown[]
}

export class GetContext {
  constructor(
    private readonly tasks: TaskRepo,
    private readonly deps: DependencyRepo,
    private readonly labels: LabelRepo
  ) {}

  async run(input: { taskId: string }): Promise<TaskContextBundle> {
    const withCounts = await this.tasks.findWithCounts(input.taskId)
    if (!withCounts) throw new DomainError('not_found', `task ${input.taskId} not found`)
    const ancestors = await this.tasks.ancestors(input.taskId)
    const blockers = await this.deps.unmetBlockers(input.taskId)
    const labels = await this.labels.labelsFor(input.taskId)
    return {
      task: withCounts.task,
      child_count: withCounts.child_count,
      unmet_blockers: withCounts.unmet_blockers,
      ancestors: ancestors.map((a) => ({
        id: a.id,
        title: a.title,
        status: a.status,
        acceptance_criteria: a.acceptance_criteria,
      })),
      blockers,
      labels,
      open_questions: [],
      links: [],
      attachments: [],
    }
  }
}
```

- [ ] **Step 12.4: Verify green, hygiene, commit.**

```bash
pnpm test && pnpm lint && pnpm typecheck
git add -A && git commit -m "feat(usecases): GetNext ready-work and GetContext context bundle"
```

---

### Task 13: REST foundation — deps composition, auth, problem+json, idempotency hooks, bootstrap admin, entrypoint

**Files:**

- Modify: `src/domain/errors.ts` (add `unauthenticated` → 401)
- Modify: `src/application/ports.ts` (add `ActorRepo.findTokenById`)
- Modify: `src/infra/sqlite/actor-repo.ts` (implement it)
- Create: `src/main/deps.ts`, `src/main/bootstrap.ts`
- Create: `src/adapters/rest/auth.ts`, `src/adapters/rest/problem.ts`, `src/adapters/rest/idempotency.ts`
- Create: `src/adapters/rest/routes/audit.ts`
- Create: `src/adapters/rest/app.ts` (move `buildApp` here: `git mv src/app.ts src/adapters/rest/app.ts` is **not** used — the Task-1 seed file gets rewritten; delete `src/app.ts`)
- Create: `src/index.ts`, `src/testing/test-app.ts`
- Create: `src/application/usecases/manage-actors.ts`, `src/application/usecases/manage-policy.ts`
- Test: `src/application/usecases/manage-actors.test.ts`, `src/adapters/rest/auth.test.ts`, `src/adapters/rest/idempotency.test.ts`, `src/main/bootstrap.test.ts`
- Modify: `src/app.test.ts` → delete; ping assertion moves into `src/adapters/rest/app.test.ts`

- [ ] **Step 13.1: Extend errors and ports.** In `src/domain/errors.ts`: add `| 'unauthenticated'` to `DomainErrorCode`, `unauthenticated: 401,` to the map. In `src/application/ports.ts` inside `ActorRepo` add:

```ts
  findTokenById(id: string): Promise<TokenRow | null>
```

In `src/infra/sqlite/actor-repo.ts` implement:

```ts
  async findTokenById(id: string): Promise<TokenRow | null> {
    const r = await this.db.selectFrom('tokens').selectAll().where('id', '=', id).executeTakeFirst()
    if (!r) return null
    return {
      id: r.id,
      actor_id: r.actor_id,
      label: r.label,
      created_at: r.created_at,
      last_used_at: r.last_used_at,
      revoked_at: r.revoked_at,
    }
  }
```

- [ ] **Step 13.2: Write failing manage-actors/policy test** `src/application/usecases/manage-actors.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { CreateActor, CreateToken, RevokeToken } from '#root/application/usecases/manage-actors'
import { GetPolicy, SetPolicy } from '#root/application/usecases/manage-policy'
import { buildUow, fixedClock, human, seqIds } from '#root/application/usecases/create-task.test'
import { SqliteActorRepo } from '#root/infra/sqlite/actor-repo'

describe('actor & token management', () => {
  it('creates agent, issues token shown once, auth lookup finds it, revoke kills it', async () => {
    const { db, uow } = await buildUow()
    const create = new CreateActor(uow, fixedClock(), seqIds())
    const agent = await create.run({
      ...human,
      kind: 'agent',
      handle: 'hermes-1',
      display_name: 'Hermes',
      description: 'coding agent',
    })
    expect(agent.kind).toBe('agent')
    await expect(
      create.run({ ...human, kind: 'agent', handle: 'hermes-1', display_name: 'dup' })
    ).rejects.toMatchObject({ code: 'handle_taken' })

    const issued = await new CreateToken(uow, fixedClock(), seqIds()).run({
      ...human,
      actor_id: agent.id,
      label: 'ci',
    })
    expect(issued.raw_token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(issued.token.id).toMatch(/^tok_seq/)

    const actors = new SqliteActorRepo(db)
    const hit = await actors.findActiveTokenByHash(
      (await import('#root/infra/token-hash')).hashToken(issued.raw_token)
    )
    expect(hit?.actor.handle).toBe('hermes-1')

    await new RevokeToken(uow, fixedClock()).run({ ...human, token_id: issued.token.id })
    expect(await actors.findActiveTokenByHash('whatever')).toBeNull()
    await expect(
      new RevokeToken(uow, fixedClock()).run({ ...human, token_id: 'tok_ghost' })
    ).rejects.toMatchObject({ code: 'not_found' })
    await db.destroy()
  })

  it('policy allowlist: only review_gate on|off', async () => {
    const { db, uow } = await buildUow()
    const get = new GetPolicy(uow)
    expect(await get.run({ key: 'review_gate' })).toBe('on')
    await new SetPolicy(uow, fixedClock()).run({ ...human, key: 'review_gate', value: 'off' })
    expect(await get.run({ key: 'review_gate' })).toBe('off')
    await expect(
      new SetPolicy(uow, fixedClock()).run({ ...human, key: 'evil', value: 'x' })
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(
      new SetPolicy(uow, fixedClock()).run({ ...human, key: 'review_gate', value: 'maybe' })
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await db.destroy()
  })
})
```

- [ ] **Step 13.3: Implement `src/application/usecases/manage-actors.ts`:**

```ts
import type { ActorKind } from '#root/domain/task'
import { DomainError } from '#root/domain/errors'
import { generateRawToken, hashToken } from '#root/infra/token-hash'
import type {
  ActorContext,
  ActorRow,
  Clock,
  IdGen,
  TokenRow,
  UnitOfWork,
} from '#root/application/ports'

export interface CreateActorInput extends ActorContext {
  kind: ActorKind
  handle: string
  display_name: string
  description?: string
}

export class CreateActor {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGen
  ) {}

  async run(input: CreateActorInput): Promise<ActorRow> {
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      if (await repos.actors.findByHandle(input.handle)) {
        throw new DomainError('handle_taken', `handle '${input.handle}' already exists`)
      }
      const actor = await repos.actors.create({
        id: this.ids.newId('a'),
        kind: input.kind,
        handle: input.handle,
        display_name: input.display_name,
        description: input.description ?? '',
        created_at: now,
      })
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'actor_created',
        entity_type: 'actor',
        entity_id: actor.id,
        after: { kind: actor.kind, handle: actor.handle },
        reason: 'actor created',
        created_at: now,
      })
      return actor
    })
  }
}

export interface CreateTokenInput extends ActorContext {
  actor_id: string
  label: string
}

export interface IssuedToken {
  raw_token: string
  token: TokenRow
}

export class CreateToken {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGen
  ) {}

  /** Raw token is returned exactly once; only its SHA-256 is stored (spec §5). */
  async run(input: CreateTokenInput): Promise<IssuedToken> {
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      const actor = await repos.actors.findById(input.actor_id)
      if (!actor) throw new DomainError('not_found', `actor ${input.actor_id} not found`)
      const raw = generateRawToken()
      const id = this.ids.newId('tok')
      await repos.actors.insertToken({
        id,
        actor_id: input.actor_id,
        token_hash: hashToken(raw),
        label: input.label,
        created_at: now,
      })
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'token_created',
        entity_type: 'actor',
        entity_id: input.actor_id,
        after: { token_id: id, label: input.label },
        reason: 'token issued',
        created_at: now,
      })
      const token = (await repos.actors.findTokenById(id)) as TokenRow
      return { raw_token: raw, token }
    })
  }
}

export interface RevokeTokenInput extends ActorContext {
  token_id: string
}

export class RevokeToken {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock
  ) {}

  async run(input: RevokeTokenInput): Promise<void> {
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      const token = await repos.actors.findTokenById(input.token_id)
      if (!token) throw new DomainError('not_found', `token ${input.token_id} not found`)
      await repos.actors.revokeToken(input.token_id, now)
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'token_revoked',
        entity_type: 'actor',
        entity_id: token.actor_id,
        after: { token_id: input.token_id },
        reason: 'token revoked',
        created_at: now,
      })
    })
  }
}
```

- [ ] **Step 13.4: Implement `src/application/usecases/manage-policy.ts`:**

```ts
import { DomainError } from '#root/domain/errors'
import type { ActorContext, Clock, UnitOfWork } from '#root/application/ports'

const POLICY_ALLOWLIST: Record<string, readonly string[]> = {
  review_gate: ['on', 'off'],
}

export class GetPolicy {
  constructor(private readonly uow: UnitOfWork) {}

  async run(input: { key: string }): Promise<string | null> {
    if (!(input.key in POLICY_ALLOWLIST)) {
      throw new DomainError('not_found', `unknown policy key '${input.key}'`)
    }
    return this.uow.withTransaction(async (repos) => repos.actors.getPolicy(input.key))
  }
}

export interface SetPolicyInput extends ActorContext {
  key: string
  value: string
}

export class SetPolicy {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock
  ) {}

  async run(input: SetPolicyInput): Promise<void> {
    const allowed = POLICY_ALLOWLIST[input.key]
    if (!allowed || !allowed.includes(input.value)) {
      throw new DomainError(
        'invalid_request',
        `policy '${input.key}' does not accept value '${input.value}'`
      )
    }
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      await repos.actors.setPolicy(input.key, input.value)
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'policy_set',
        entity_type: 'policy',
        entity_id: input.key,
        after: { value: input.value },
        reason: 'policy updated',
        created_at: now,
      })
    })
  }
}
```

- [ ] **Step 13.5: Implement `src/main/deps.ts`:**

```ts
import type { Kysely } from 'kysely'
import type { Config } from '#root/main/config'
import type { DB } from '#root/infra/sqlite/schema'
import { SystemClock } from '#root/infra/clock'
import { RandomIdGen } from '#root/infra/ids'
import { SqliteActorRepo } from '#root/infra/sqlite/actor-repo'
import { SqliteAuditRepo } from '#root/infra/sqlite/audit-repo'
import { SqliteDependencyRepo } from '#root/infra/sqlite/dependency-repo'
import { SqliteIdempotencyRepo } from '#root/infra/sqlite/idempotency-repo'
import { SqliteLabelRepo } from '#root/infra/sqlite/label-repo'
import { SqliteTaskRepo } from '#root/infra/sqlite/task-repo'
import { SqliteUnitOfWork } from '#root/infra/sqlite/uow'
import { AddBlock } from '#root/application/usecases/add-block'
import { ClaimTask } from '#root/application/usecases/claim-task'
import { CreateTask } from '#root/application/usecases/create-task'
import { GetContext } from '#root/application/usecases/get-context'
import { GetNext } from '#root/application/usecases/get-next'
import { Heartbeat } from '#root/application/usecases/heartbeat'
import { CreateActor, CreateToken, RevokeToken } from '#root/application/usecases/manage-actors'
import { GetPolicy, SetPolicy } from '#root/application/usecases/manage-policy'
import { ReleaseClaim } from '#root/application/usecases/release-claim'
import { RemoveBlock } from '#root/application/usecases/remove-block'
import { SplitTask } from '#root/application/usecases/split-task'
import { UpdateStatus } from '#root/application/usecases/update-status'
import { UpdateTask } from '#root/application/usecases/update-task'

export interface AppDeps {
  config: Config
  db: Kysely<DB>
  clock: SystemClock
  ids: RandomIdGen
  uow: SqliteUnitOfWork
  // root-connection repos for auth/queries/idempotency (outside use-case txs)
  actorsRoot: SqliteActorRepo
  idemRoot: SqliteIdempotencyRepo
  tasksRoot: SqliteTaskRepo
  depsRoot: SqliteDependencyRepo
  labelsRoot: SqliteLabelRepo
  auditRoot: SqliteAuditRepo
  useCases: {
    createTask: CreateTask
    updateTask: UpdateTask
    updateStatus: UpdateStatus
    splitTask: SplitTask
    claimTask: ClaimTask
    releaseClaim: ReleaseClaim
    heartbeat: Heartbeat
    addBlock: AddBlock
    removeBlock: RemoveBlock
    getNext: GetNext
    getContext: GetContext
    createActor: CreateActor
    createToken: CreateToken
    revokeToken: RevokeToken
    getPolicy: GetPolicy
    setPolicy: SetPolicy
  }
}

export const makeDepsFromDb = (db: Kysely<DB>, config: Config): AppDeps => {
  const clock = new SystemClock()
  const ids = new RandomIdGen()
  const uow = new SqliteUnitOfWork(db)
  return {
    config,
    db,
    clock,
    ids,
    uow,
    actorsRoot: new SqliteActorRepo(db),
    idemRoot: new SqliteIdempotencyRepo(db),
    tasksRoot: new SqliteTaskRepo(db),
    depsRoot: new SqliteDependencyRepo(db),
    labelsRoot: new SqliteLabelRepo(db),
    auditRoot: new SqliteAuditRepo(db),
    useCases: {
      createTask: new CreateTask(uow, clock, ids),
      updateTask: new UpdateTask(uow, clock),
      updateStatus: new UpdateStatus(uow, clock),
      splitTask: new SplitTask(uow, clock, ids),
      claimTask: new ClaimTask(uow, clock),
      releaseClaim: new ReleaseClaim(uow, clock),
      heartbeat: new Heartbeat(uow, clock),
      addBlock: new AddBlock(uow, clock),
      removeBlock: new RemoveBlock(uow, clock),
      getNext: new GetNext(new SqliteTaskRepo(db)),
      getContext: new GetContext(
        new SqliteTaskRepo(db),
        new SqliteDependencyRepo(db),
        new SqliteLabelRepo(db)
      ),
      createActor: new CreateActor(uow, clock, ids),
      createToken: new CreateToken(uow, clock, ids),
      revokeToken: new RevokeToken(uow, clock),
      getPolicy: new GetPolicy(uow),
      setPolicy: new SetPolicy(uow, clock),
    },
  }
}
```

- [ ] **Step 13.6: Write failing bootstrap test** `src/main/bootstrap.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { loadConfig } from '#root/main/config'
import { makeDepsFromDb, type AppDeps } from '#root/main/deps'
import { ensureBootstrapAdmin } from '#root/main/bootstrap'
import { hashToken } from '#root/infra/token-hash'
import { freshDb } from '#root/testing/fixtures'

const LONG = 'x'.repeat(48)

describe('bootstrap admin', () => {
  it('does nothing without a token', async () => {
    const db = await freshDb()
    const deps: AppDeps = makeDepsFromDb(db, loadConfig({}))
    await ensureBootstrapAdmin(deps)
    expect(await deps.actorsRoot.findByHandle('bootstrap')).toBeNull()
    await db.destroy()
  })

  it('ensures a human admin + token, idempotently', async () => {
    const db = await freshDb()
    const deps = makeDepsFromDb(db, loadConfig({ NS_BOOTSTRAP_TOKEN: LONG }))
    await ensureBootstrapAdmin(deps)
    await ensureBootstrapAdmin(deps) // no duplicate/throw
    const hit = await deps.actorsRoot.findActiveTokenByHash(hashToken(LONG))
    expect(hit?.actor.handle).toBe('bootstrap')
    expect(hit?.actor.kind).toBe('human')
    await db.destroy()
  })
})
```

- [ ] **Step 13.7: Implement `src/main/bootstrap.ts`:**

```ts
import type { AppDeps } from '#root/main/deps'
import { hashToken } from '#root/infra/token-hash'

/** Creates the first human + bearer token from env so an admin can log in and manage actors (spec D-h). Bootstrap init is not audited. */
export const ensureBootstrapAdmin = async (deps: AppDeps): Promise<void> => {
  const raw = deps.config.bootstrapToken
  if (!raw) return
  const now = deps.clock.now().toISOString()
  const hash = hashToken(raw)
  // fresh-process fast path: an ACTIVE token already matches the env
  if (await deps.actorsRoot.findActiveTokenByHash(hash)) return
  if (!(await deps.actorsRoot.findById('a_bootstrap'))) {
    await deps.actorsRoot.create({
      id: 'a_bootstrap',
      kind: 'human',
      handle: 'bootstrap',
      display_name: 'Bootstrap Admin',
      description: 'created from NS_BOOTSTRAP_TOKEN',
      created_at: now,
    })
  }
  // env-as-truth: NS_BOOTSTRAP_TOKEN defines the active bootstrap token on EVERY boot,
  // so UPSERT the row onto it (a plain insert crashes boot on tokens.id/tokens.token_hash
  // after RevokeToken or after rotating the env). Revoking the bootstrap token is
  // therefore only durable across restarts by ALSO removing NS_BOOTSTRAP_TOKEN from env.
  await deps.db
    .insertInto('tokens')
    .values({
      id: 'tok_bootstrap',
      actor_id: 'a_bootstrap',
      token_hash: hash,
      label: 'bootstrap',
      created_at: now,
    })
    .onConflict((oc) =>
      oc.column('id').doUpdateSet({ token_hash: hash, created_at: now, revoked_at: null })
    )
    .execute()
}
```

> **Amendment (Task 13 quality review, blocker):** the token write is an UPSERT, not an
> insert — NS_BOOTSTRAP_TOKEN is the source of truth, and a plain `insertToken` bricks the
> next boot (PK on `tok_bootstrap` / UNIQUE on `token_hash`) after a revoke or an env rotation.

- [ ] **Step 13.8: Implement `src/adapters/rest/problem.ts`:**

```ts
import type { FastifyError, FastifyInstance } from 'fastify'
import { isDomainError } from '#root/domain/errors'

export interface ProblemBody {
  type: string
  title: string
  status: number
  code: string
  detail: string
}

// RFC 9457 with stable machine code (spec §11)
const problem = (status: number, code: string, detail: string): ProblemBody => ({
  type: `https://nightshift.local/errors/${code}`,
  title: code.replaceAll('_', ' '),
  status,
  code,
  detail,
})

export const sendProblem = (
  reply: { code(n: number): { type(t: string): { send(b: unknown): unknown } } },
  status: number,
  code: string,
  detail: string
): unknown =>
  reply
    .code(status)
    .type('application/problem+json')
    .send(problem(status, code, detail))

export const registerProblemHandlers = (app: FastifyInstance): void => {
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (isDomainError(error)) {
      return reply
        .code(error.status)
        .type('application/problem+json')
        .send({ ...(error.details ?? {}), ...problem(error.status, error.code, error.message) })
    }
    if ((error as FastifyError & { validation?: unknown }).validation) {
      return sendProblem(reply, 400, 'invalid_request', error.message)
    }
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500
    if (status === 400) return sendProblem(reply, 400, 'invalid_request', error.message)
    app.log.error(error)
    return sendProblem(
      reply,
      status === 401 ? 401 : 500,
      status === 401 ? 'unauthenticated' : 'internal_error',
      status === 401 ? error.message : 'internal error'
    )
  })

  app.setNotFoundHandler((_request, reply) => {
    sendProblem(reply, 404, 'not_found', 'route not found')
  })
}
```

- [ ] **Step 13.9: Implement `src/adapters/rest/auth.ts`:**

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import type { ActorRef } from '#root/application/ports'
import { hashToken } from '#root/infra/token-hash'
import { DomainError } from '#root/domain/errors'

declare module 'fastify' {
  interface FastifyRequest {
    actorRef: ActorRef | null
    tokenId: string | null
    idemKey: string | null
  }
}

export const PUBLIC_PATHS = new Set(['/ping', '/openapi.yaml'])

export const requireHuman = (_request: FastifyRequest, _reply: FastifyReply): void => {
  if (!_request.actorRef || _request.actorRef.kind !== 'human') {
    throw new DomainError('forbidden', 'this endpoint requires a human actor (spec D-h)')
  }
}

export const actorCtx = (request: FastifyRequest): { actor: ActorRef; tokenId: string | null } => {
  if (!request.actorRef) throw new DomainError('unauthenticated', 'authentication required')
  return { actor: request.actorRef, tokenId: request.tokenId }
}

export const registerAuth = (app: FastifyInstance, deps: AppDeps): void => {
  app.decorateRequest('actorRef', null)
  app.decorateRequest('tokenId', null)
  app.decorateRequest('idemKey', null)

  app.addHook('onRequest', async (request) => {
    const path = request.url.split('?')[0] as string
    if (PUBLIC_PATHS.has(path)) return
    const header = request.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      throw new DomainError(
        'unauthenticated',
        'missing bearer token (Plan E adds human cookie sessions)'
      )
    }
    const hit = await deps.actorsRoot.findActiveTokenByHash(
      hashToken(header.slice('Bearer '.length))
    )
    if (!hit) throw new DomainError('unauthenticated', 'invalid or revoked token')
    request.actorRef = {
      id: hit.actor.id,
      kind: hit.actor.kind,
      handle: hit.actor.handle,
      display_name: hit.actor.display_name,
    }
    request.tokenId = hit.token.id
    await deps.actorsRoot.touchToken(hit.token.id, deps.clock.now().toISOString())
  })
}
```

- [ ] **Step 13.10: Implement `src/adapters/rest/idempotency.ts`** (decision D-j):

```ts
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import { DomainError } from '#root/domain/errors'

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])

export const registerIdempotency = (app: FastifyInstance, deps: AppDeps): void => {
  app.addHook('onRequest', async (request, reply) => {
    if (!MUTATING.has(request.method) || !request.actorRef) return
    const key = request.headers['idempotency-key']
    if (typeof key !== 'string' || key.length === 0 || key.length > 200) return

    const outcome = await deps.idemRoot.reserve({
      actor_id: request.actorRef.id,
      idem_key: key,
      request_method: request.method,
      request_path: request.url.split('?')[0] as string,
      created_at: deps.clock.now().toISOString(),
    })
    if (outcome.state === 'complete') {
      // replay the stored response verbatim; content-type pinned so the string
      // payload is not downgraded to text/plain by content sniffing — and pinned
      // honestly: a stored 4xx problem+json replays as problem+json, not json
      return reply
        .code(outcome.status)
        .header(
          'content-type',
          outcome.status >= 400 ? 'application/problem+json' : 'application/json'
        )
        .send(outcome.body)
    }
    if (outcome.state === 'in_flight') {
      throw new DomainError(
        'idempotency_in_flight',
        'a request with this Idempotency-Key is in flight'
      )
    }
    request.idemKey = key
  })

  app.addHook('onSend', async (request, reply, payload) => {
    if (!request.idemKey || !request.actorRef) return payload
    const idem = { actor: request.actorRef.id, key: request.idemKey }
    if (reply.statusCode >= 500) {
      await deps.idemRoot.remove(idem.actor, idem.key) // 5xx must be retryable (D-j)
    } else if (typeof payload === 'string') {
      await deps.idemRoot.complete(idem.actor, idem.key, reply.statusCode, payload)
    } else if (Buffer.isBuffer(payload)) {
      await deps.idemRoot.complete(idem.actor, idem.key, reply.statusCode, payload.toString('utf8'))
    }
    return payload
  })
}
```

- [ ] **Step 13.11: Implement `src/adapters/rest/routes/audit.ts`** ("nothing hidden": any authenticated actor may read the audit log, spec §5/§6.7):

```ts
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'

export const registerAuditRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  app.get(
    '/audit',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            entity_type: { type: 'string' },
            entity_id: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
          },
        },
      },
    },
    async (request) => {
      const q = request.query as { entity_type?: string; entity_id?: string; limit: number }
      return deps.auditRoot.search({
        entity_type: q.entity_type,
        entity_id: q.entity_id,
        limit: q.limit,
      })
    }
  )
}
```

- [ ] **Step 13.12: Rewrite `src/adapters/rest/app.ts` and create the entrypoint + test harness.** Delete `src/app.ts` and `src/app.test.ts`.

`src/adapters/rest/app.ts`:

```ts
import Fastify, { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import { registerProblemHandlers } from '#root/adapters/rest/problem'
import { registerAuth } from '#root/adapters/rest/auth'
import { registerIdempotency } from '#root/adapters/rest/idempotency'
import { registerAuditRoutes } from '#root/adapters/rest/routes/audit'

export interface BuildAppOptions {
  logger?: boolean
}

export const buildApp = (deps: AppDeps, opts: BuildAppOptions = {}): FastifyInstance => {
  const server: FastifyInstance = Fastify({ logger: opts.logger ?? false })

  registerProblemHandlers(server)
  server.get('/ping', async () => {
    return { pong: 'it worked!' }
  })

  // hook order matters: auth resolves the actor, then idempotency reserves per-actor keys
  registerAuth(server, deps)
  registerIdempotency(server, deps)

  registerAuditRoutes(server, deps)

  return server
}
```

`src/index.ts` (agent-test graceful-shutdown pattern):

```ts
import { loadConfig } from '#root/main/config'
import { makeDepsFromDb } from '#root/main/deps'
import { ensureBootstrapAdmin } from '#root/main/bootstrap'
import { makeDb } from '#root/infra/sqlite/db'
import { migrateToLatest } from '#root/infra/sqlite/migrations'
import { buildApp } from '#root/adapters/rest/app'

const config = loadConfig()

const start = async (): Promise<void> => {
  const db = makeDb(config.dbPath)
  await migrateToLatest(db)
  const deps = makeDepsFromDb(db, config)
  await ensureBootstrapAdmin(deps)
  const server = buildApp(deps, { logger: true })

  try {
    await server.listen({ port: config.port, host: '0.0.0.0' })
  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }

  const shutdown = async (): Promise<void> => {
    server.log.info('Graceful shutdown signal received')
    await server.close()
    await db.destroy()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
}

void start()
```

`src/testing/test-app.ts`:

```ts
import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { loadConfig } from '#root/main/config'
import { makeDepsFromDb } from '#root/main/deps'
import { makeDb } from '#root/infra/sqlite/db'
import { migrateToLatest } from '#root/infra/sqlite/migrations'
import { hashToken } from '#root/infra/token-hash'
import { buildApp } from '#root/adapters/rest/app'

export interface TestApp {
  app: FastifyInstance
  adminToken: string
  close(): Promise<void>
}

export const makeTestApp = async (): Promise<TestApp> => {
  const db = makeDb(':memory:')
  await migrateToLatest(db)
  const deps = makeDepsFromDb(db, loadConfig({ NS_DB_PATH: ':memory:' }))
  const adminToken = randomBytes(32).toString('base64url')
  const now = new Date().toISOString()
  await db
    .insertInto('actors')
    .values({
      id: 'a_nils',
      kind: 'human',
      handle: 'nils',
      display_name: 'Nils',
      description: '',
      created_at: now,
    })
    .execute()
  await db
    .insertInto('tokens')
    .values({
      id: 'tok_nils',
      actor_id: 'a_nils',
      token_hash: hashToken(adminToken),
      label: 'test',
      created_at: now,
      last_used_at: null,
      revoked_at: null,
    })
    .execute()
  const app = buildApp(deps)
  await app.ready()
  return {
    app,
    adminToken,
    close: async () => {
      await app.close()
      await db.destroy()
    },
  }
}
```

`src/adapters/rest/app.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { makeTestApp } from '#root/testing/test-app'

describe('app', () => {
  it('answers ping without auth', async () => {
    const t = await makeTestApp()
    const res = await t.app.inject({ method: 'GET', url: '/ping' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ pong: 'it worked!' })
    await t.close()
  })

  it('serves audit with bearer auth', async () => {
    const t = await makeTestApp()
    const anon = await t.app.inject({ method: 'GET', url: '/audit' })
    expect(anon.statusCode).toBe(401)
    expect(anon.headers['content-type']).toContain('application/problem+json')
    expect(anon.json().code).toBe('unauthenticated')

    const ok = await t.app.inject({
      method: 'GET',
      url: '/audit',
      headers: { authorization: `Bearer ${t.adminToken}` },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual([])
    await t.close()
  })
})
```

- [ ] **Step 13.13: Write failing auth + idempotency middleware tests.**

`src/adapters/rest/auth.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { makeTestApp } from '#root/testing/test-app'
import { hashToken } from '#root/infra/token-hash'

describe('auth', () => {
  it('rejects missing, malformed, and unknown tokens with problem+json 401', async () => {
    const t = await makeTestApp()
    for (const headers of [
      undefined,
      { authorization: 'Basic dXNlcjpwYXNz' },
      { authorization: 'Bearer nope' },
    ]) {
      const res = await t.app.inject({ method: 'GET', url: '/audit', headers })
      expect(res.statusCode).toBe(401)
      expect(res.json().code).toBe('unauthenticated')
    }
    await t.close()
  })

  it('records token last-used on auth', async () => {
    const t = await makeTestApp()
    await t.app.inject({
      method: 'GET',
      url: '/audit',
      headers: { authorization: `Bearer ${t.adminToken}` },
    })
    // audit the touch indirectly: revoke via DB then re-auth fails
    const db = (t as unknown as { app: unknown }) && null
    void db
    const before = await t.app.inject({
      method: 'GET',
      url: '/audit',
      headers: { authorization: `Bearer ${t.adminToken}` },
    })
    expect(before.statusCode).toBe(200)
    // direct check through the raw handle:
    const { SqliteActorRepo } = await import('#root/infra/sqlite/actor-repo')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new SqliteActorRepo((t as any).__db ?? (null as never))
    if (repo) {
      const tok = await repo.findActiveTokenByHash(hashToken(t.adminToken))
      expect(tok?.token.last_used_at).not.toBeNull()
    }
    await t.close()
  })
})
```

**Implementer note:** the last-used assertion needs the db handle — extend `TestApp` with `deps: AppDeps` (add `deps` to `makeTestApp`'s return, type `AppDeps`), then the test becomes:

```ts
const tok = await t.deps.actorsRoot.findActiveTokenByHash(hashToken(t.adminToken))
expect(tok?.token.last_used_at).not.toBeNull()
```

and delete the `SqliteActorRepo` scaffolding lines from the final file.

`src/adapters/rest/idempotency.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { makeTestApp } from '#root/testing/test-app'

describe('Idempotency-Key middleware (spec §7.3)', () => {
  const setup = async () => {
    const t = await makeTestApp()
    t.app.post('/idem-echo', async () => ({ ok: true, stamp: Math.random() }))
    return t
  }

  it('replays the stored response for a repeated key', async () => {
    const t = await setup()
    const headers = { authorization: `Bearer ${t.adminToken}`, 'idempotency-key': 'k-1' }
    const first = await t.app.inject({ method: 'POST', url: '/idem-echo', headers })
    const second = await t.app.inject({ method: 'POST', url: '/idem-echo', headers })
    expect(second.statusCode).toBe(first.statusCode)
    expect(second.body).toBe(first.body) // byte-identical replay
    await t.close()
  })

  it('different keys are independent; no key = no dedupe', async () => {
    const t = await setup()
    const base = { authorization: `Bearer ${t.adminToken}` }
    const a = await t.app.inject({
      method: 'POST',
      url: '/idem-echo',
      headers: { ...base, 'idempotency-key': 'k-a' },
    })
    const b = await t.app.inject({
      method: 'POST',
      url: '/idem-echo',
      headers: { ...base, 'idempotency-key': 'k-b' },
    })
    expect(a.body).not.toBe(b.body)
    await t.close()
  })

  it('in-flight duplicate is rejected 409 idempotency_in_flight', async () => {
    const t = await setup()
    await t.deps.idemRoot.reserve({
      actor_id: 'a_nils',
      idem_key: 'k-busy',
      request_method: 'POST',
      request_path: '/idem-echo',
      created_at: new Date().toISOString(),
    })
    const res = await t.app.inject({
      method: 'POST',
      url: '/idem-echo',
      headers: { authorization: `Bearer ${t.adminToken}`, 'idempotency-key': 'k-busy' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('idempotency_in_flight')
    await t.close()
  })

  it('5xx deletes the reservation so retries re-execute (D-j)', async () => {
    const t = await setup()
    t.app.post('/idem-boom', async () => {
      throw new Error('boom')
    })
    const headers = { authorization: `Bearer ${t.adminToken}`, 'idempotency-key': 'k-boom' }
    const first = await t.app.inject({ method: 'POST', url: '/idem-boom', headers })
    expect(first.statusCode).toBe(500)
    const outcome = await t.deps.idemRoot.reserve({
      actor_id: 'a_nils',
      idem_key: 'k-boom',
      request_method: 'POST',
      request_path: '/idem-boom',
      created_at: new Date().toISOString(),
    })
    expect(outcome).toEqual({ state: 'reserved' }) // free again
    await t.close()
  })
})
```

(`TestApp` must expose `deps` per the note above.)

- [ ] **Step 13.14: Verify green + full suite, hygiene, commit.**

```bash
pnpm test && pnpm lint && pnpm typecheck
git add -A && git commit -m "feat(rest): deps composition, bearer auth, problem+json, idempotency hooks, bootstrap admin"
```

---

### Task 14: Task & claim routes + API integration tests (spec §7.2, §7.4 agent loop, §11.2)

**Files:**

- Create: `src/adapters/rest/dto.ts`, `src/adapters/rest/routes/tasks.ts`
- Modify: `src/adapters/rest/app.ts` (register task routes)
- Test: `src/adapters/rest/routes/tasks.test.ts`

- [ ] **Step 14.1: Create `src/adapters/rest/dto.ts`** (public JSON shape; claim internals exposed deliberately — "nothing hidden", spec §5):

```ts
import type { TaskWithCounts } from '#root/application/ports'

export interface TaskDto {
  id: string
  parent_id: string | null
  title: string
  description: string
  acceptance_criteria: string
  status: string
  blocked_flag: boolean
  assignee_id: string | null
  position: number
  created_by: string
  created_at: string
  updated_at: string
  claim_token_id: string | null
  claim_generation: number
  last_heartbeat_at: string | null
  child_count: number
  unmet_blockers: number
}

export const toTaskDto = (row: TaskWithCounts): TaskDto => ({
  ...row.task,
  status: row.task.status,
  child_count: row.child_count,
  unmet_blockers: row.unmet_blockers,
})
```

- [ ] **Step 14.2: Implement `src/adapters/rest/routes/tasks.ts`:**

```ts
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import type { TaskPatch } from '#root/application/ports'
import type { SplitChildDraft } from '#root/application/usecases/split-task'
import type { TaskStatus } from '#root/domain/task'
import { actorCtx } from '#root/adapters/rest/auth'
import { toTaskDto } from '#root/adapters/rest/dto'
import { DomainError } from '#root/domain/errors'
import { TASK_STATUSES } from '#root/domain/task'

const statusEnum = { type: 'string', enum: TASK_STATUSES } as const

// M-2 (Task 7 review): the route schema, NOT the use-case, owns title length
// validation — minLength/maxLength on every title entry point below.
interface CreateTaskBody {
  title: string
  description?: string
  acceptance_criteria?: string
  parent_id?: string
  status?: TaskStatus
  labels?: string[]
}

export const registerTaskRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  app.post(
    '/tasks',
    {
      schema: {
        body: {
          type: 'object',
          required: ['title'],
          additionalProperties: false,
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 300 },
            description: { type: 'string' },
            acceptance_criteria: { type: 'string' },
            parent_id: { type: 'string' },
            status: statusEnum,
            labels: { type: 'array', items: { type: 'string', minLength: 1 } },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as CreateTaskBody
      const task = await deps.useCases.createTask.run({ ...actorCtx(request), ...body })
      const withCounts = (await deps.tasksRoot.findWithCounts(task.id))!
      return reply.code(201).send(toTaskDto(withCounts))
    }
  )

  app.get('/tasks', async () => (await deps.tasksRoot.listAllWithCounts()).map(toTaskDto))

  app.get(
    '/tasks/next',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (request) => {
      const q = request.query as { label?: string; limit?: number }
      return (await deps.useCases.getNext.run({ label: q.label, limit: q.limit })).map(toTaskDto)
    }
  )

  app.get('/tasks/:id', async (request) => {
    const { id } = request.params as { id: string }
    const row = await deps.tasksRoot.findWithCounts(id)
    if (!row) throw new DomainError('not_found', `task ${id} not found`)
    return toTaskDto(row)
  })

  // The context bundle's shape is fixed by spec §7.2 (get-context.ts), so it passes
  // through as the use-case composed it; flat task JSON everywhere else goes toTaskDto.
  app.get('/tasks/:id/context', async (request) => {
    const { id } = request.params as { id: string }
    return deps.useCases.getContext.run({ taskId: id })
  })

  app.patch(
    '/tasks/:id',
    {
      schema: {
        body: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 300 },
            description: { type: 'string' },
            acceptance_criteria: { type: 'string' },
            blocked_flag: { type: 'boolean' },
            assignee_id: { type: ['string', 'null'] },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string }
      const { actor, tokenId } = actorCtx(request)
      await deps.useCases.updateTask.run({
        actor,
        tokenId,
        taskId: id,
        patch: request.body as TaskPatch,
      })
      return toTaskDto((await deps.tasksRoot.findWithCounts(id))!)
    }
  )

  app.patch(
    '/tasks/:id/status',
    {
      schema: {
        body: {
          type: 'object',
          required: ['status', 'reason'],
          additionalProperties: false,
          properties: {
            status: statusEnum,
            reason: { type: 'string', minLength: 1 },
            lease_token: { type: 'string' },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string }
      const body = request.body as { status: TaskStatus; reason: string; lease_token?: string }
      const task = await deps.useCases.updateStatus.run({
        ...actorCtx(request),
        taskId: id,
        to: body.status,
        reason: body.reason,
        lease_token: body.lease_token,
      })
      return toTaskDto((await deps.tasksRoot.findWithCounts(task.id))!)
    }
  )

  // SplitTaskResult's shape ({parent, created}) is pinned by spec §7.4 step 4 and the
  // integration test below; like the context bundle it passes through un-DTO'd.
  app.post(
    '/tasks/:id/split',
    {
      schema: {
        body: {
          type: 'object',
          required: ['children'],
          additionalProperties: false,
          properties: {
            children: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                required: ['title'],
                additionalProperties: false,
                properties: {
                  title: { type: 'string', minLength: 1, maxLength: 300 },
                  description: { type: 'string' },
                  acceptance_criteria: { type: 'string' },
                  status: statusEnum,
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const { children } = request.body as { children: SplitChildDraft[] }
      const result = await deps.useCases.splitTask.run({
        ...actorCtx(request),
        taskId: id,
        children,
      })
      return reply.code(201).send(result)
    }
  )

  app.post('/tasks/:id/claim', async (request) => {
    const { id } = request.params as { id: string }
    return deps.useCases.claimTask.run({ ...actorCtx(request), taskId: id })
  })

  app.post('/tasks/:id/release', async (request) => {
    const { id } = request.params as { id: string }
    const task = await deps.useCases.releaseClaim.run({ ...actorCtx(request), taskId: id })
    return toTaskDto((await deps.tasksRoot.findWithCounts(task.id))!)
  })

  app.post(
    '/tasks/:id/heartbeat',
    {
      schema: {
        body: {
          type: 'object',
          required: ['lease_token'],
          additionalProperties: false,
          properties: { lease_token: { type: 'string' } },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string }
      const { lease_token } = request.body as { lease_token: string }
      const task = await deps.useCases.heartbeat.run({
        ...actorCtx(request),
        taskId: id,
        lease_token,
      })
      return toTaskDto((await deps.tasksRoot.findWithCounts(task.id))!)
    }
  )
}
```

**Implementer note:** the `Parameters<…> infer` trick in the POST /tasks body typing is optional cleverness — replace it with an explicit `interface CreateTaskBody { title: string; description?: string; acceptance_criteria?: string; parent_id?: string; status?: TaskStatus; labels?: string[] }` and cast. The `await import` in GET /tasks/:id should become a top-level import in the final file.

- [ ] **Step 14.3: Register in `buildApp`** (after `registerAuditRoutes`):

```ts
import { registerTaskRoutes } from '#root/adapters/rest/routes/tasks'
// …
registerTaskRoutes(server, deps)
```

- [ ] **Step 14.4: Write the API integration test** `src/adapters/rest/routes/tasks.test.ts` — the §7.4 loop with real codes, on ephemeral SQLite:

```ts
import { describe, expect, it } from 'vitest'
import { makeTestApp, type TestApp } from '#root/testing/test-app'
import { randomBytes } from 'node:crypto'
import { hashToken } from '#root/infra/token-hash'

const bearer = (t: TestApp): Record<string, string> => ({ authorization: `Bearer ${t.adminToken}` })

const newAgent = async (t: TestApp, handle: string): Promise<string> => {
  const raw = randomBytes(32).toString('base64url')
  const now = new Date().toISOString()
  const id = `a_${handle}`
  await t.deps.db
    .insertInto('actors')
    .values({
      id,
      kind: 'agent',
      handle,
      display_name: handle,
      description: '',
      created_at: now,
    })
    .execute()
  await t.deps.db
    .insertInto('tokens')
    .values({
      id: `tok_${handle}`,
      actor_id: id,
      token_hash: hashToken(raw),
      label: 'test',
      created_at: now,
      last_used_at: null,
      revoked_at: null,
    })
    .execute()
  return raw
}

const asAgent = (raw: string): Record<string, string> => ({ authorization: `Bearer ${raw}` })

describe('agent loop over HTTP (spec §7.4, §11.2)', () => {
  it('file → race → split → claim → review → done, with every rejection code', async () => {
    const t = await makeTestApp()

    // 1. human files task
    const filed = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: bearer(t),
      payload: {
        title: 'Add rate limiter',
        acceptance_criteria: 'AC: 429s',
        status: 'todo',
        labels: ['infra'],
      },
    })
    expect(filed.statusCode).toBe(201)
    const task = filed.json()
    expect(task.status).toBe('todo')

    // 2. two agents race to claim — exactly one wins
    const tokenA = await newAgent(t, 'hermes-a')
    const tokenB = await newAgent(t, 'hermes-b')
    const [ra, rb] = await Promise.all([
      t.app.inject({ method: 'POST', url: `/tasks/${task.id}/claim`, headers: asAgent(tokenA) }),
      t.app.inject({ method: 'POST', url: `/tasks/${task.id}/claim`, headers: asAgent(tokenB) }),
    ])
    const winner = ra.statusCode === 200 ? ra : rb
    const loser = ra.statusCode === 200 ? rb : ra
    expect(winner.statusCode).toBe(200)
    expect(loser.statusCode).toBe(409)
    expect(loser.json().code).toBe('already_claimed')
    expect(loser.json().holder_handle).toMatch(/^hermes-/)
    const lease = winner.json().lease_token as string

    // 3. context bundle
    const ctx = await t.app.inject({
      method: 'GET',
      url: `/tasks/${task.id}/context`,
      headers: bearer(t),
    })
    expect(ctx.json().task.acceptance_criteria).toBe('AC: 429s')

    // heartbeat
    const hb = await t.app.inject({
      method: 'POST',
      url: `/tasks/${task.id}/heartbeat`,
      headers: asAgent(ra.statusCode === 200 ? tokenA : tokenB),
      payload: { lease_token: lease },
    })
    expect(hb.statusCode).toBe(200)
    expect(hb.json().last_heartbeat_at).not.toBeNull()

    // 4. split releases the claim; old lease is dead
    const split = await t.app.inject({
      method: 'POST',
      url: `/tasks/${task.id}/split`,
      headers: bearer(t),
      payload: {
        children: [
          { title: 'redis window', status: 'todo' },
          { title: '429 body', status: 'todo' },
        ],
      },
    })
    expect(split.statusCode).toBe(201)
    const [c1, c2] = split.json().created
    const afterSplit = (
      await t.app.inject({ method: 'GET', url: `/tasks/${task.id}`, headers: bearer(t) })
    ).json()
    expect(afterSplit.claim_token_id).toBeNull()
    expect(afterSplit.child_count).toBe(2)

    const stale = await t.app.inject({
      method: 'PATCH',
      url: `/tasks/${c1.id}/status`,
      headers: asAgent(ra.statusCode === 200 ? tokenA : tokenB),
      payload: { status: 'in_review', reason: 'zombie', lease_token: lease },
    })
    expect(stale.statusCode).toBe(412)
    expect(stale.json().code).toBe('stale_lease')
    // (pin addition: shipped-code sync from Task 14 spec review)
    // full problem shape through the route (Task 13 pin: details spread FIRST, so
    // `claimed` survives; app.test.ts only proves this on a probe route)
    expect(stale.headers['content-type']).toContain('application/problem+json')
    expect(stale.json().claimed).toBe(false) // claim was already released by the split
    expect(stale.json().type).toBe('https://nightshift.local/errors/stale_lease')
    expect(stale.json().title).toBe('stale lease')
    expect(stale.json().status).toBe(412)

    // parent with children is not claimable
    const notLeaf = await t.app.inject({
      method: 'POST',
      url: `/tasks/${task.id}/claim`,
      headers: asAgent(tokenB),
    })
    expect(notLeaf.statusCode).toBe(409)
    expect(notLeaf.json().code).toBe('not_a_leaf')

    // 5. both agents claim children, open PRs, move to review with their own leases
    for (const [child, tok] of [
      [c1, tokenA],
      [c2, tokenB],
    ] as const) {
      const claim = await t.app.inject({
        method: 'POST',
        url: `/tasks/${child.id}/claim`,
        headers: asAgent(tok),
      })
      expect(claim.statusCode).toBe(200)
      // without the lease token: 412
      const noLease = await t.app.inject({
        method: 'PATCH',
        url: `/tasks/${child.id}/status`,
        headers: asAgent(tok),
        payload: { status: 'in_review', reason: 'pr up' },
      })
      expect(noLease.statusCode).toBe(412)
      // (pin addition: shipped-code sync from Task 14 spec review)
      expect(noLease.json().claimed).toBe(true) // still-claimed sibling of the stale case
      const review = await t.app.inject({
        method: 'PATCH',
        url: `/tasks/${child.id}/status`,
        headers: asAgent(tok),
        payload: { status: 'in_review', reason: 'pr up', lease_token: claim.json().lease_token },
      })
      expect(review.statusCode).toBe(200)
      expect(review.json().claim_token_id).toBeNull() // released on review (D-c)

      // agents may not close (invariant 5)
      const closeByAgent = await t.app.inject({
        method: 'PATCH',
        url: `/tasks/${child.id}/status`,
        headers: asAgent(tok),
        payload: { status: 'done', reason: 'self-merge' },
      })
      expect(closeByAgent.statusCode).toBe(403)
      expect(closeByAgent.json().code).toBe('agent_close_forbidden')
    }

    // parent cannot be done while children are open
    const parentDoneEarly = await t.app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}/status`,
      headers: bearer(t),
      payload: { status: 'done', reason: 'eager' },
    })
    expect(parentDoneEarly.statusCode).toBe(409)
    expect(parentDoneEarly.json().code).toBe('open_descendants')

    // 6. human closes both children, then parent
    for (const child of [c1, c2]) {
      const done = await t.app.inject({
        method: 'PATCH',
        url: `/tasks/${child.id}/status`,
        headers: bearer(t),
        payload: { status: 'done', reason: 'ship it' },
      })
      expect(done.statusCode).toBe(200)
    }
    const parentDone = await t.app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}/status`,
      headers: bearer(t),
      payload: { status: 'done', reason: 'all leaves done' },
    })
    expect(parentDone.statusCode).toBe(200)

    // 7. the audit log reconstructs the story; board rollup is computable
    const audit = (
      await t.app.inject({
        method: 'GET',
        url: `/audit?entity_id=${task.id}&limit=100`,
        headers: bearer(t),
      })
    ).json()
    const actions = audit.map((a: { action: string }) => a.action)
    expect(actions).toEqual(
      expect.arrayContaining([
        'task_created',
        'claim_acquired',
        'claim_released',
        'task_split',
        'status_changed',
      ])
    )
    expect(audit.some((a: { reason: string }) => a.reason === 'claim released by split')).toBe(true)

    const board = (await t.app.inject({ method: 'GET', url: '/tasks', headers: bearer(t) })).json()
    const parent = board.find((x: { id: string }) => x.id === task.id)
    expect(parent.child_count).toBe(2)

    // ready-work query now empty for that label
    const next = (
      await t.app.inject({ method: 'GET', url: '/tasks/next?label=infra', headers: bearer(t) })
    ).json()
    expect(next).toEqual([])

    await t.close()
  })

  it('validation and idempotency at the API level', async () => {
    const t = await makeTestApp()
    const bad = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: bearer(t),
      payload: {},
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('invalid_request')

    // (pin addition: shipped-code sync from Task 14 spec review — M-2 / AJV route-schema validation)
    // M-2 pin: the ROUTE schema, not the use-case, owns title length validation —
    // empty and over-long titles die at AJV (the use-case deliberately does not check)
    const emptyTitle = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: bearer(t),
      payload: { title: '' },
    })
    expect(emptyTitle.statusCode).toBe(400)
    expect(emptyTitle.json().code).toBe('invalid_request')
    const longTitle = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: bearer(t),
      payload: { title: 'x'.repeat(301) },
    })
    expect(longTitle.statusCode).toBe(400)
    expect(longTitle.json().code).toBe('invalid_request')

    // pin: unknown status is an AJV 400 problem, never the use-case's invalid_request
    const badStatus = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: bearer(t),
      payload: { title: 'ok', status: 'banana' },
    })
    expect(badStatus.statusCode).toBe(400)
    expect(badStatus.json().code).toBe('invalid_request')
    expect(badStatus.json().detail).not.toContain("unknown status 'banana'")
    const badStatusPatch = await t.app.inject({
      method: 'PATCH',
      url: '/tasks/t_nope/status',
      headers: bearer(t),
      payload: { status: 'banana', reason: 'x' },
    })
    expect(badStatusPatch.statusCode).toBe(400)
    expect(badStatusPatch.json().code).toBe('invalid_request')
    expect(badStatusPatch.json().detail).not.toContain("unknown status 'banana'")

    const headers = { ...bearer(t), 'idempotency-key': 'file-1' }
    const a = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers,
      payload: { title: 'dup-safe' },
    })
    const b = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers,
      payload: { title: 'dup-safe' },
    })
    expect(a.body).toBe(b.body) // replay — no double-file (spec §7.3)

    await t.close()
  })

  // (coverage-rule addition: shipped-code sync from Task 14 spec review)
  // The §7.4 loop leaves these two handlers untouched (it never PATCHes content or
  // releases manually); the new-file coverage rule demands they be exercised.
  it('content patch and manual release work over HTTP', async () => {
    const t = await makeTestApp()
    const filed = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: bearer(t),
      payload: { title: 'patchable', acceptance_criteria: 'old', status: 'todo' },
    })
    expect(filed.statusCode).toBe(201)
    const id = filed.json().id

    const patched = await t.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      headers: bearer(t),
      payload: { title: 'patched', acceptance_criteria: 'new', blocked_flag: true },
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().title).toBe('patched')
    expect(patched.json().acceptance_criteria).toBe('new')
    expect(patched.json().blocked_flag).toBe(true)
    expect(patched.json().child_count).toBe(0) // DTO, not raw record

    // M-2 again on the PATCH side: empty title dies at the route schema
    const emptyPatch = await t.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}`,
      headers: bearer(t),
      payload: { title: '' },
    })
    expect(emptyPatch.statusCode).toBe(400)
    expect(emptyPatch.json().code).toBe('invalid_request')

    const token = await newAgent(t, 'release-bot')
    const claim = await t.app.inject({
      method: 'POST',
      url: `/tasks/${id}/claim`,
      headers: asAgent(token),
    })
    expect(claim.statusCode).toBe(200)
    const released = await t.app.inject({
      method: 'POST',
      url: `/tasks/${id}/release`,
      headers: asAgent(token),
    })
    expect(released.statusCode).toBe(200)
    expect(released.json().claim_token_id).toBeNull()

    // route-composed DomainError (not a use-case throw) still maps to problem+json
    const ghost = await t.app.inject({
      method: 'GET',
      url: '/tasks/t_ghost',
      headers: bearer(t),
    })
    expect(ghost.statusCode).toBe(404)
    expect(ghost.json().code).toBe('not_found')

    await t.close()
  })
})
```

(`TestApp` already exposes `deps` per Task 13's note; if not yet added, add it now.)

- [ ] **Step 14.5: Verify green + suite, hygiene, commit.**

```bash
pnpm test && pnpm lint && pnpm typecheck
git add -A && git commit -m "feat(rest): task/claim/split/status routes with §7.4 integration coverage"
```

---

### Task 15: Dependency & label routes

**Files:**

- Modify: `src/application/ports.ts` + `src/infra/sqlite/label-repo.ts` (add `getById`)
- Create: `src/application/usecases/labels.ts`, `src/adapters/rest/routes/dependencies.ts`, `src/adapters/rest/routes/labels.ts`
- Modify: `src/adapters/rest/app.ts` (register both)
- Test: `src/adapters/rest/routes/deps-labels.test.ts`

- [ ] **Step 15.1: Extend `LabelRepo`.** In `src/application/ports.ts` add to `interface LabelRepo`: `getById(id: string): Promise<LabelRow | null>`. In `src/infra/sqlite/label-repo.ts`:

```ts
  async getById(id: string): Promise<LabelRow | null> {
    const r = await this.db.selectFrom('labels').selectAll().where('id', '=', id).executeTakeFirst()
    return (r as LabelRow | undefined) ?? null
  }
```

- [ ] **Step 15.2: Implement `src/application/usecases/labels.ts`:**

Shipped delta (Task 15 sync): the block's `import type` list also named `LabelRepo`
and `TaskRepo`, which no code in the block uses — `@typescript-eslint/no-unused-vars`
(lint gate) errored on both, so the shipped import is the narrowed list below.

```ts
import { DomainError } from '#root/domain/errors'
import type { ActorContext, Clock, IdGen, LabelRow, UnitOfWork } from '#root/application/ports'

export interface CreateLabelInput extends ActorContext {
  name: string
  color?: string
}

export class CreateLabel {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGen
  ) {}

  /** Create-or-get by name (labels have no other identity). */
  async run(input: CreateLabelInput): Promise<LabelRow> {
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) =>
      repos.labels.ensure({
        id: this.ids.newId('l'),
        name: input.name,
        color: input.color ?? '#888888',
        created_at: now,
      })
    )
  }
}

export interface AttachLabelInput extends ActorContext {
  taskId: string
  labelId: string
}

export class AttachLabel {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock
  ) {}

  async run(input: AttachLabelInput): Promise<void> {
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      if (!(await repos.tasks.findById(input.taskId))) {
        throw new DomainError('not_found', `task ${input.taskId} not found`)
      }
      if (!(await repos.labels.getById(input.labelId))) {
        throw new DomainError('not_found', `label ${input.labelId} not found`)
      }
      await repos.labels.attach(input.taskId, input.labelId)
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'label_attached',
        entity_type: 'task',
        entity_id: input.taskId,
        after: { label_id: input.labelId },
        reason: 'label attached',
        created_at: now,
      })
    })
  }
}

export class DetachLabel {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock
  ) {}

  async run(input: AttachLabelInput): Promise<void> {
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      if (!(await repos.tasks.findById(input.taskId))) {
        throw new DomainError('not_found', `task ${input.taskId} not found`)
      }
      await repos.labels.detach(input.taskId, input.labelId)
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'label_detached',
        entity_type: 'task',
        entity_id: input.taskId,
        after: { label_id: input.labelId },
        reason: 'label detached',
        created_at: now,
      })
    })
  }
}
```

Add to `AppDeps['useCases']` (Task 13 file) and `makeDepsFromDb`: `createLabel`, `attachLabel`, `detachLabel`.

- [ ] **Step 15.3: Implement the two route modules.**

`src/adapters/rest/routes/dependencies.ts` (orientation locked: `PUT /tasks/{id}/blocks/{blockerId}` ⇒ blockerId blocks the task):

```ts
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import { actorCtx } from '#root/adapters/rest/auth'

export const registerDependencyRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  app.put('/tasks/:id/blocks/:blockerId', async (request, reply) => {
    const { id, blockerId } = request.params as { id: string; blockerId: string }
    await deps.useCases.addBlock.run({ ...actorCtx(request), taskId: id, blocker_id: blockerId })
    return reply.code(204).send()
  })

  app.delete('/tasks/:id/blocks/:blockerId', async (request, reply) => {
    const { id, blockerId } = request.params as { id: string; blockerId: string }
    await deps.useCases.removeBlock.run({ ...actorCtx(request), taskId: id, blocker_id: blockerId })
    return reply.code(204).send()
  })
}
```

`src/adapters/rest/routes/labels.ts`:

Shipped deltas (Task 15 sync): the block registered POST `/labels` as a 2-arg call
with the async handler embedded in the options object — invalid syntax (`'{' expected`,
no overload matches); shipped as the 3-arg schema'd registration matching `tasks.ts`.
The handler also awaits the use-case before `send`, and spreads the trusted auth
context LAST (Task 14 quality-review defense; the body schema is `additionalProperties:false`).

```ts
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import { actorCtx } from '#root/adapters/rest/auth'

export const registerLabelRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  app.get('/labels', async () => deps.labelsRoot.list())

  // plan block wrote this as a 2-arg call with the async handler embedded in the
  // options object (non-compiling); shipped as the 3-arg schema'd registration,
  // matching tasks.ts (Task 14 sync).
  app.post(
    '/labels',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 60 },
            color: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { name: string; color?: string }
      // Task 14 review defense: trusted auth context spread LAST, after the
      // schema-validated body (additionalProperties:false already fences it).
      const label = await deps.useCases.createLabel.run({ ...body, ...actorCtx(request) })
      return reply.code(201).send(label)
    }
  )

  app.put('/tasks/:id/labels/:labelId', async (request, reply) => {
    const { id, labelId } = request.params as { id: string; labelId: string }
    await deps.useCases.attachLabel.run({ ...actorCtx(request), taskId: id, labelId })
    return reply.code(204).send()
  })

  app.delete('/tasks/:id/labels/:labelId', async (request, reply) => {
    const { id, labelId } = request.params as { id: string; labelId: string }
    await deps.useCases.detachLabel.run({ ...actorCtx(request), taskId: id, labelId })
    return reply.code(204).send()
  })
}
```

Register both in `buildApp` (after `registerTaskRoutes`).

- [ ] **Step 15.4: Write API test** `src/adapters/rest/routes/deps-labels.test.ts`:

Shipped delta (Task 15 sync): a third test was added covering what the block left
open — 204 + Idempotency-Key replay on a real route (D-j), GET/POST `/labels`
happy-path + rejection, and the not_found/invalid_request paths the block omitted.
Note: fastify's default ajv (`removeAdditional`) strips unknown body props rather
than rejecting, so the POST `/labels` 400 pin is the missing required `name`.

```ts
import { describe, expect, it } from 'vitest'
import { makeTestApp, type TestApp } from '#root/testing/test-app'

const bearer = (t: TestApp): Record<string, string> => ({ authorization: `Bearer ${t.adminToken}` })

const mkTask = async (t: TestApp, title: string): Promise<string> =>
  (
    await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: bearer(t),
      payload: { title, status: 'todo' },
    })
  ).json().id as string

describe('dependency + label routes', () => {
  it('blocks: add, cycle rejection via API, ready-work exclusion, remove re-readies', async () => {
    const t = await makeTestApp()
    const blocker = await mkTask(t, 'blocker')
    const blocked = await mkTask(t, 'blocked')

    const before = (
      await t.app.inject({ method: 'GET', url: '/tasks/next', headers: bearer(t) })
    ).json()
    expect(before.map((x: { id: string }) => x.id)).toContain(blocked)

    const ok = await t.app.inject({
      method: 'PUT',
      url: `/tasks/${blocked}/blocks/${blocker}`,
      headers: bearer(t),
    })
    expect(ok.statusCode).toBe(204)

    const dup = await t.app.inject({
      method: 'PUT',
      url: `/tasks/${blocked}/blocks/${blocker}`,
      headers: bearer(t),
    })
    expect(dup.statusCode).toBe(204) // idempotent PUT

    const gone = (
      await t.app.inject({ method: 'GET', url: '/tasks/next', headers: bearer(t) })
    ).json()
    expect(gone.map((x: { id: string }) => x.id)).not.toContain(blocked)

    const cycle = await t.app.inject({
      method: 'PUT',
      url: `/tasks/${blocker}/blocks/${blocked}`,
      headers: bearer(t),
    })
    expect(cycle.statusCode).toBe(409)
    expect(cycle.json().code).toBe('dependency_cycle')

    const self = await t.app.inject({
      method: 'PUT',
      url: `/tasks/${blocker}/blocks/${blocker}`,
      headers: bearer(t),
    })
    expect(self.statusCode).toBe(400)

    const unknown = await t.app.inject({
      method: 'PUT',
      url: `/tasks/${blocked}/blocks/t_ghost`,
      headers: bearer(t),
    })
    expect(unknown.statusCode).toBe(404)

    const rm = await t.app.inject({
      method: 'DELETE',
      url: `/tasks/${blocked}/blocks/${blocker}`,
      headers: bearer(t),
    })
    expect(rm.statusCode).toBe(204)
    const readyAgain = (
      await t.app.inject({ method: 'GET', url: '/tasks/next', headers: bearer(t) })
    ).json()
    expect(readyAgain.map((x: { id: string }) => x.id)).toContain(blocked)
    await t.close()
  })

  it('labels: create, attach, appears in context, detach', async () => {
    const t = await makeTestApp()
    const task = await mkTask(t, 'labelled')
    const label = (
      await t.app.inject({
        method: 'POST',
        url: '/labels',
        headers: bearer(t),
        payload: { name: 'infra' },
      })
    ).json()
    expect(label.name).toBe('infra')

    const att = await t.app.inject({
      method: 'PUT',
      url: `/tasks/${task}/labels/${label.id}`,
      headers: bearer(t),
    })
    expect(att.statusCode).toBe(204)

    const ctx = (
      await t.app.inject({ method: 'GET', url: `/tasks/${task}/context`, headers: bearer(t) })
    ).json()
    expect(ctx.labels.map((l: { name: string }) => l.name)).toEqual(['infra'])

    const missing = await t.app.inject({
      method: 'PUT',
      url: `/tasks/${task}/labels/l_ghost`,
      headers: bearer(t),
    })
    expect(missing.statusCode).toBe(404)

    const det = await t.app.inject({
      method: 'DELETE',
      url: `/tasks/${task}/labels/${label.id}`,
      headers: bearer(t),
    })
    expect(det.statusCode).toBe(204)
    const after = (
      await t.app.inject({ method: 'GET', url: `/tasks/${task}/context`, headers: bearer(t) })
    ).json()
    expect(after.labels).toEqual([])
    await t.close()
  })

  // Coverage the plan block left open (Task 15 brief): 204+Idempotency-Key replay on
  // a real route, GET/POST /labels happy + rejection, not_found on the task-side paths.
  it('204 replays via Idempotency-Key; remaining routes and 404/400 shapes', async () => {
    const t = await makeTestApp()
    const blocker = await mkTask(t, 'idem-blocker')
    const blocked = await mkTask(t, 'idem-blocked')

    const idemHeaders = { ...bearer(t), 'idempotency-key': 'k-block' }
    const first = await t.app.inject({
      method: 'PUT',
      url: `/tasks/${blocked}/blocks/${blocker}`,
      headers: idemHeaders,
    })
    expect(first.statusCode).toBe(204)
    const replay = await t.app.inject({
      method: 'PUT',
      url: `/tasks/${blocked}/blocks/${blocker}`,
      headers: idemHeaders,
    })
    expect(replay.statusCode).toBe(204) // key completed, not stranded in flight (D-j)
    expect(replay.body).toBe('') // 204 replays carry no body

    const created = await t.app.inject({
      method: 'POST',
      url: '/labels',
      headers: bearer(t),
      payload: { name: 'ops', color: '#ff8800' },
    })
    expect(created.statusCode).toBe(201)
    const labelId = created.json().id as string

    const listed = (
      await t.app.inject({ method: 'GET', url: '/labels', headers: bearer(t) })
    ).json()
    expect(listed.map((l: { name: string }) => l.name)).toEqual(['ops'])
    expect(listed[0].color).toBe('#ff8800')

    const unauth = await t.app.inject({ method: 'GET', url: '/labels' })
    expect(unauth.statusCode).toBe(401)
    expect(unauth.headers['content-type']).toContain('application/problem+json')
    expect(unauth.json().code).toBe('unauthenticated')

    // fastify's default ajv strips unknown props (removeAdditional), so the 400
    // pin is the missing required 'name', not an unknown key
    const bad = await t.app.inject({
      method: 'POST',
      url: '/labels',
      headers: bearer(t),
      payload: { color: '#ffffff', extra: true },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('invalid_request')

    const putGhostTask = await t.app.inject({
      method: 'PUT',
      url: `/tasks/t_ghost/labels/${labelId}`,
      headers: bearer(t),
    })
    expect(putGhostTask.statusCode).toBe(404)
    expect(putGhostTask.json().code).toBe('not_found')

    const delGhostTask = await t.app.inject({
      method: 'DELETE',
      url: `/tasks/t_ghost/labels/${labelId}`,
      headers: bearer(t),
    })
    expect(delGhostTask.statusCode).toBe(404)
    expect(delGhostTask.json().code).toBe('not_found')

    const delBlockGhostTask = await t.app.inject({
      method: 'DELETE',
      url: `/tasks/t_ghost/blocks/${blocker}`,
      headers: bearer(t),
    })
    expect(delBlockGhostTask.statusCode).toBe(404)
    expect(delBlockGhostTask.json().code).toBe('not_found')

    const detached = await t.app.inject({
      method: 'DELETE',
      url: `/tasks/${blocked}/labels/l_ghost`,
      headers: bearer(t),
    })
    expect(detached.statusCode).toBe(204) // detach is idempotent; task-side owns the 404
    await t.close()
  })
})
```

- [ ] **Step 15.5: Verify green + suite, hygiene, commit.**

```bash
pnpm test && pnpm lint && pnpm typecheck
git add -A && git commit -m "feat(rest): dependency and label routes"
```

---

### Task 16: Admin routes — actors, tokens, policy (human-only, decision D-h)

**Files:**

- Create: `src/adapters/rest/routes/admin.ts`
- Modify: `src/adapters/rest/app.ts` (register)
- Test: `src/adapters/rest/routes/admin.test.ts`

- [ ] **Step 16.1: Implement `src/adapters/rest/routes/admin.ts`:**

```ts
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import { actorCtx, requireHuman } from '#root/adapters/rest/auth'
import type { ActorKind } from '#root/domain/task'

export const registerAdminRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  app.get('/admin/actors', { preHandler: [requireHuman] }, async () => deps.actorsRoot.list())

  app.post('/admin/actors', {
    preHandler: [requireHuman],
    schema: {
      body: {
        type: 'object',
        required: ['kind', 'handle', 'display_name'],
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['human', 'agent'] },
          handle: { type: 'string', minLength: 1, maxLength: 60 },
          display_name: { type: 'string', minLength: 1, maxLength: 120 },
          description: { type: 'string' },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { kind: ActorKind; handle: string; display_name: string; description?: string }
      return reply.code(201).send(deps.useCases.createActor.run({ ...actorCtx(request), ...body }))
    },
  })

  app.post('/admin/actors/:id/tokens', {
    preHandler: [requireHuman],
    schema: {
      body: {
        type: 'object',
        required: ['label'],
        additionalProperties: false,
        properties: { label: { type: 'string', minLength: 1, maxLength: 60 } },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const { label } = request.body as { label: string }
      const issued = await deps.useCases.createToken.run({ ...actorCtx(request), actor_id: id, label })
      // raw_token shown exactly once (spec §5); never derivable from storage afterwards
      return reply.code(201).send({
        token_id: issued.token.id,
        actor_id: issued.token.actor_id,
        label: issued.token.label,
        created_at: issued.token.created_at,
        raw_token: issued.raw_token,
      })
    },
  })

  app.post('/admin/tokens/:id/revoke', { preHandler: [requireHuman] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    await deps.useCases.revokeToken.run({ ...actorCtx(request), token_id: id })
    return reply.code(204).send()
  })

  app.get('/admin/policy/:key', { preHandler: [requireHuman] }, async (request) => {
    const { key } = request.params as { key: string }
    return { key, value: await deps.useCases.getPolicy.run({ key }) }
  })

  app.put('/admin/policy/:key', {
    preHandler: [requireHuman],
    schema: {
      body: {
        type: 'object',
        required: ['value'],
        additionalProperties: false,
        properties: { value: { type: 'string', enum: ['on', 'off'] } },
      },
    },
    async (request) => {
      const { key } = request.params as { key: string }
      const { value } = request.body as { value: string }
      await deps.useCases.setPolicy.run({ ...actorCtx(request), key, value })
      return { key, value }
    },
  })
}
```

- [ ] **Step 16.2: Write test** `src/adapters/rest/routes/admin.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { makeTestApp, type TestApp } from '#root/testing/test-app'

const bearer = (t: TestApp): Record<string, string> => ({ authorization: `Bearer ${t.adminToken}` })

describe('admin routes (human-only, D-h)', () => {
  it('agent tokens are rejected from every /admin path', async () => {
    const t = await makeTestApp()
    const agent = (
      await t.app.inject({
        method: 'POST',
        url: '/admin/actors',
        headers: bearer(t),
        payload: { kind: 'agent', handle: 'hermes-1', display_name: 'Hermes' },
      })
    ).json()
    const issued = (
      await t.app.inject({
        method: 'POST',
        url: `/admin/actors/${agent.id}/tokens`,
        headers: bearer(t),
        payload: { label: 'ci' },
      })
    ).json()
    expect(issued.raw_token).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const forBidden = await t.app.inject({
      method: 'GET',
      url: '/admin/actors',
      headers: { authorization: `Bearer ${issued.raw_token}` },
    })
    expect(forBidden.statusCode).toBe(403)
    expect(forBidden.json().code).toBe('forbidden')
    await t.close()
  })

  it('issued token authenticates agent API calls; revocation kills it (401)', async () => {
    const t = await makeTestApp()
    const agent = (
      await t.app.inject({
        method: 'POST',
        url: '/admin/actors',
        headers: bearer(t),
        payload: { kind: 'agent', handle: 'hermes-1', display_name: 'Hermes' },
      })
    ).json()
    const issued = (
      await t.app.inject({
        method: 'POST',
        url: `/admin/actors/${agent.id}/tokens`,
        headers: bearer(t),
        payload: { label: 'ci' },
      })
    ).json()
    const agentHeaders = { authorization: `Bearer ${issued.raw_token}` }

    const task = (
      await t.app.inject({
        method: 'POST',
        url: '/tasks',
        headers: bearer(t),
        payload: { title: 'x', status: 'todo' },
      })
    ).json()
    const claim = await t.app.inject({
      method: 'POST',
      url: `/tasks/${task.id}/claim`,
      headers: agentHeaders,
    })
    expect(claim.statusCode).toBe(200)

    const revoke = await t.app.inject({
      method: 'POST',
      url: `/admin/tokens/${issued.token_id}/revoke`,
      headers: bearer(t),
    })
    expect(revoke.statusCode).toBe(204)

    const after = await t.app.inject({
      method: 'GET',
      url: '/audit',
      headers: agentHeaders,
    })
    expect(after.statusCode).toBe(401)
    expect(after.json().code).toBe('unauthenticated')

    // audit recorded who issued/revoked which token (per-actor audit, spec §5)
    const audit = (
      await t.app.inject({
        method: 'GET',
        url: '/audit?entity_type=actor&limit=50',
        headers: bearer(t),
      })
    ).json()
    expect(audit.some((a: { action: string }) => a.action === 'token_created')).toBe(true)
    expect(audit.some((a: { action: string }) => a.action === 'token_revoked')).toBe(true)
    await t.close()
  })

  it('duplicate handle → 409 handle_taken; policy flip changes agent close behavior end-to-end', async () => {
    const t = await makeTestApp()
    const dup = await t.app.inject({
      method: 'POST',
      url: '/admin/actors',
      headers: bearer(t),
      payload: { kind: 'human', handle: 'nils', display_name: 'Other' },
    })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().code).toBe('handle_taken')

    const agent = (
      await t.app.inject({
        method: 'POST',
        url: '/admin/actors',
        headers: bearer(t),
        payload: { kind: 'agent', handle: 'hermes-2', display_name: 'H2' },
      })
    ).json()
    const issued = (
      await t.app.inject({
        method: 'POST',
        url: `/admin/actors/${agent.id}/tokens`,
        headers: bearer(t),
        payload: { label: 'l' },
      })
    ).json()
    const agentHeaders = { authorization: `Bearer ${issued.raw_token}` }
    const task = (
      await t.app.inject({
        method: 'POST',
        url: '/tasks',
        headers: bearer(t),
        payload: { title: 'closey', status: 'todo' },
      })
    ).json()

    const denied = await t.app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}/status`,
      headers: agentHeaders,
      payload: { status: 'done', reason: 'gate' },
    })
    expect(denied.statusCode).toBe(403)

    const off = await t.app.inject({
      method: 'PUT',
      url: '/admin/policy/review_gate',
      headers: bearer(t),
      payload: { value: 'off' },
    })
    expect(off.statusCode).toBe(200)
    const allowed = await t.app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}/status`,
      headers: agentHeaders,
      payload: { status: 'done', reason: 'gate off' },
    })
    expect(allowed.statusCode).toBe(200)

    const badPolicy = await t.app.inject({
      method: 'PUT',
      url: '/admin/policy/review_gate',
      headers: bearer(t),
      payload: { value: 'maybe' },
    })
    expect(badPolicy.statusCode).toBe(400)
    const unknownKey = await t.app.inject({
      method: 'GET',
      url: '/admin/policy/nope',
      headers: bearer(t),
    })
    expect(unknownKey.statusCode).toBe(404)
    await t.close()
  })
})
```

- [ ] **Step 16.3: Verify green + suite, hygiene, commit.**

```bash
pnpm test && pnpm lint && pnpm typecheck
git add -A && git commit -m "feat(rest): admin routes for actors, tokens, policy (human-only)"
```

---

### Task 17: OpenAPI 3.1 contract — committed spec, public serve, drift test (decision D-k)

**Files:**

- Create: `openapi/openapi.yaml`
- Modify: `src/adapters/rest/app.ts` (serve the spec)
- Test: `src/adapters/rest/openapi-contract.test.ts`

- [ ] **Step 17.1: Create `openapi/openapi.yaml`** (this file _is_ the product contract — spec §7.1; any API change = committed diff here):

```yaml
openapi: 3.1.0
info:
  title: nightshift
  version: 0.1.0
  description: >-
    Self-hosted task board where humans and AI agents are first-class actors.
    Plan A surface: tasks, tree/split, dependencies, claims with fencing tokens,
    audit, actor/token/policy administration. Threads/inbox/events arrive in later plans.
servers:
  - url: /
security:
  - bearerAuth: []
tags:
  - name: meta
  - name: tasks
  - name: labels
  - name: audit
  - name: admin
paths:
  /ping:
    get:
      tags: [meta]
      security: []
      operationId: ping
      responses:
        '200':
          description: liveness
          content:
            application/json:
              schema: { type: object, properties: { pong: { type: string } } }
  /openapi.yaml:
    get:
      tags: [meta]
      security: []
      operationId: getSpec
      responses:
        '200':
          description: This contract
          content:
            application/yaml:
              schema: { type: string }
  /tasks:
    get:
      tags: [tasks]
      operationId: listTasks
      responses:
        '200':
          description: every task with rollup counts
          content:
            application/json:
              schema: { type: array, items: { $ref: '#/components/schemas/Task' } }
    post:
      tags: [tasks]
      operationId: createTask
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [title]
              additionalProperties: false
              properties:
                title: { type: string, minLength: 1, maxLength: 300 }
                description: { type: string }
                acceptance_criteria: { type: string }
                parent_id: { type: string }
                status: { $ref: '#/components/schemas/TaskStatus' }
                labels: { type: array, items: { type: string } }
      responses:
        '201':
          description: created
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Task' }
        default: { $ref: '#/components/responses/Problem' }
  /tasks/next:
    get:
      tags: [tasks]
      operationId: getNextTasks
      parameters:
        - { name: label, in: query, schema: { type: string } }
        - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 100 } }
      responses:
        '200':
          description: ready leaves (spec §6.3)
          content:
            application/json:
              schema: { type: array, items: { $ref: '#/components/schemas/Task' } }
        default: { $ref: '#/components/responses/Problem' }
  /tasks/{id}:
    parameters: [{ $ref: '#/components/parameters/TaskId' }]
    get:
      tags: [tasks]
      operationId: getTask
      responses:
        '200':
          description: task
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Task' }
        default: { $ref: '#/components/responses/Problem' }
    patch:
      tags: [tasks]
      operationId: patchTask
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              minProperties: 1
              additionalProperties: false
              properties:
                title: { type: string, minLength: 1, maxLength: 300 }
                description: { type: string }
                acceptance_criteria: { type: string }
                blocked_flag: { type: boolean }
                assignee_id: { type: ['string', 'null'] }
      responses:
        '200':
          description: updated
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Task' }
        default: { $ref: '#/components/responses/Problem' }
  /tasks/{id}/context:
    parameters: [{ $ref: '#/components/parameters/TaskId' }]
    get:
      tags: [tasks]
      operationId: getTaskContext
      responses:
        '200':
          description: one-call context bundle (spec §7.2); question/link/attachment arrays empty in Plan A
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ContextBundle' }
        default: { $ref: '#/components/responses/Problem' }
  /tasks/{id}/status:
    parameters: [{ $ref: '#/components/parameters/TaskId' }]
    patch:
      tags: [tasks]
      operationId: changeStatus
      description: requires the current lease_token while the task is claimed (invariant 3)
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [status, reason]
              additionalProperties: false
              properties:
                status: { $ref: '#/components/schemas/TaskStatus' }
                reason: { type: string, minLength: 1 }
                lease_token: { type: string }
      responses:
        '200':
          description: new task state
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Task' }
        default: { $ref: '#/components/responses/Problem' }
  /tasks/{id}/split:
    parameters: [{ $ref: '#/components/parameters/TaskId' }]
    post:
      tags: [tasks]
      operationId: splitTask
      description: atomic; releases any active claim and bumps the fencing generation (spec §6.2)
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [children]
              additionalProperties: false
              properties:
                children:
                  type: array
                  minItems: 1
                  items:
                    type: object
                    required: [title]
                    additionalProperties: false
                    properties:
                      title: { type: string, minLength: 1, maxLength: 300 }
                      description: { type: string }
                      acceptance_criteria: { type: string }
                      status: { $ref: '#/components/schemas/TaskStatus' }
      responses:
        '201':
          description: children created
          content:
            application/json:
              schema:
                type: object
                properties:
                  parent: { $ref: '#/components/schemas/Task' }
                  created: { type: array, items: { $ref: '#/components/schemas/Task' } }
        default: { $ref: '#/components/responses/Problem' }
  /tasks/{id}/claim:
    parameters: [{ $ref: '#/components/parameters/TaskId' }]
    post:
      tags: [tasks]
      operationId: claimTask
      description: atomic compare-and-swap; 409 already_claimed carries the holder's public identity
      responses:
        '200':
          description: claimed
          content:
            application/json:
              schema:
                type: object
                properties:
                  lease_token: { type: string }
                  generation: { type: integer }
        default: { $ref: '#/components/responses/Problem' }
  /tasks/{id}/release:
    parameters: [{ $ref: '#/components/parameters/TaskId' }]
    post:
      tags: [tasks]
      operationId: releaseTask
      responses:
        '200':
          description: released
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Task' }
        default: { $ref: '#/components/responses/Problem' }
  /tasks/{id}/heartbeat:
    parameters: [{ $ref: '#/components/parameters/TaskId' }]
    post:
      tags: [tasks]
      operationId: heartbeatTask
      description: liveness record only; keepalive enforcement is deferred (spec §12)
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [lease_token]
              additionalProperties: false
              properties: { lease_token: { type: string } }
      responses:
        '200':
          description: liveness recorded
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Task' }
        default: { $ref: '#/components/responses/Problem' }
  /tasks/{id}/blocks/{blockerId}:
    parameters:
      - { $ref: '#/components/parameters/TaskId' }
      - { name: blockerId, in: path, required: true, schema: { type: string } }
    put:
      tags: [tasks]
      operationId: addBlock
      description: blockerId blocks the task; 409 dependency_cycle on cycles
      responses:
        '204': { description: edge present }
        default: { $ref: '#/components/responses/Problem' }
    delete:
      tags: [tasks]
      operationId: removeBlock
      responses:
        '204': { description: edge absent }
        default: { $ref: '#/components/responses/Problem' }
  /tasks/{id}/labels/{labelId}:
    parameters:
      - { $ref: '#/components/parameters/TaskId' }
      - { name: labelId, in: path, required: true, schema: { type: string } }
    put:
      tags: [labels]
      operationId: attachLabel
      responses:
        '204': { description: attached }
        default: { $ref: '#/components/responses/Problem' }
    delete:
      tags: [labels]
      operationId: detachLabel
      responses:
        '204': { description: detached }
        default: { $ref: '#/components/responses/Problem' }
  /labels:
    get:
      tags: [labels]
      operationId: listLabels
      responses:
        '200':
          description: all labels
          content:
            application/json:
              schema: { type: array, items: { $ref: '#/components/schemas/Label' } }
    post:
      tags: [labels]
      operationId: createLabel
      description: create-or-get by name
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name]
              additionalProperties: false
              properties:
                { name: { type: string, minLength: 1, maxLength: 60 }, color: { type: string } }
      responses:
        '201':
          description: label
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Label' }
        default: { $ref: '#/components/responses/Problem' }
  /audit:
    get:
      tags: [audit]
      operationId: searchAudit
      description: append-only activity log; every authenticated actor may read everything
      parameters:
        - { name: entity_type, in: query, schema: { type: string } }
        - { name: entity_id, in: query, schema: { type: string } }
        - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 500 } }
      responses:
        '200':
          description: newest first
          content:
            application/json:
              schema: { type: array, items: { $ref: '#/components/schemas/AuditEntry' } }
        default: { $ref: '#/components/responses/Problem' }
  /admin/actors:
    get:
      tags: [admin]
      operationId: listActors
      responses:
        '200':
          description: all actors
          content:
            application/json:
              schema: { type: array, items: { $ref: '#/components/schemas/Actor' } }
        default: { $ref: '#/components/responses/Problem' }
    post:
      tags: [admin]
      operationId: createActor
      responses:
        '201':
          description: created
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Actor' }
        default: { $ref: '#/components/responses/Problem' }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [kind, handle, display_name]
              additionalProperties: false
              properties:
                kind: { type: string, enum: [human, agent] }
                handle: { type: string, minLength: 1, maxLength: 60 }
                display_name: { type: string, minLength: 1, maxLength: 120 }
                description: { type: string }
  /admin/actors/{id}/tokens:
    parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
    post:
      tags: [admin]
      operationId: createToken
      description: raw_token shown exactly once; stored SHA-256 only (spec §5)
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [label]
              additionalProperties: false
              properties: { label: { type: string, minLength: 1, maxLength: 60 } }
      responses:
        '201':
          description: issued
          content:
            application/json:
              schema:
                type: object
                properties:
                  token_id: { type: string }
                  actor_id: { type: string }
                  label: { type: string }
                  created_at: { type: string }
                  raw_token: { type: string }
        default: { $ref: '#/components/responses/Problem' }
  /admin/tokens/{id}/revoke:
    parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
    post:
      tags: [admin]
      operationId: revokeToken
      responses:
        '204': { description: revoked }
        default: { $ref: '#/components/responses/Problem' }
  /admin/policy/{key}:
    parameters: [{ name: key, in: path, required: true, schema: { type: string } }]
    get:
      tags: [admin]
      operationId: getPolicy
      responses:
        '200':
          description: policy value (allowlisted keys)
          content:
            application/json:
              schema:
                type: object
                properties: { key: { type: string }, value: { type: ['string', 'null'] } }
        default: { $ref: '#/components/responses/Problem' }
    put:
      tags: [admin]
      operationId: setPolicy
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [value]
              additionalProperties: false
              properties: { value: { type: string, enum: ['on', 'off'] } }
      responses:
        '200':
          description: stored
          content:
            application/json:
              schema:
                type: object
                properties: { key: { type: string }, value: { type: string } }
        default: { $ref: '#/components/responses/Problem' }
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      description: agent tokens (and bootstrap admin) in Plan A; human cookie sessions arrive with OIDC in Plan E
  parameters:
    TaskId:
      name: id
      in: path
      required: true
      schema: { type: string }
  responses:
    Problem:
      description: domain rejection — stable machine code, branch on it (spec §11)
      content:
        application/problem+json:
          schema: { $ref: '#/components/schemas/Problem' }
  schemas:
    TaskStatus:
      type: string
      enum: [backlog, todo, in_progress, in_review, done, canceled]
    Task:
      type: object
      properties:
        id: { type: string }
        parent_id: { type: ['string', 'null'] }
        title: { type: string }
        description: { type: string }
        acceptance_criteria: { type: string }
        status: { $ref: '#/components/schemas/TaskStatus' }
        blocked_flag: { type: boolean }
        assignee_id: { type: ['string', 'null'] }
        position: { type: number }
        created_by: { type: string }
        created_at: { type: string }
        updated_at: { type: string }
        claim_token_id: { type: ['string', 'null'] }
        claim_generation: { type: integer }
        last_heartbeat_at: { type: ['string', 'null'] }
        child_count: { type: integer }
        unmet_blockers: { type: integer }
    ContextBundle:
      type: object
      properties:
        task: { $ref: '#/components/schemas/Task' }
        ancestors:
          {
            type: array,
            items:
              {
                type: object,
                properties:
                  {
                    id: { type: string },
                    title: { type: string },
                    status: { $ref: '#/components/schemas/TaskStatus' },
                    acceptance_criteria: { type: string },
                  },
              },
          }
        blockers:
          {
            type: array,
            items:
              {
                type: object,
                properties:
                  {
                    id: { type: string },
                    title: { type: string },
                    status: { $ref: '#/components/schemas/TaskStatus' },
                  },
              },
          }
        labels: { type: array, items: { $ref: '#/components/schemas/Label' } }
        open_questions: { type: array }
        links: { type: array }
        attachments: { type: array }
    Label:
      type: object
      properties:
        id: { type: string }
        name: { type: string }
        color: { type: string }
        created_at: { type: string }
    Actor:
      type: object
      properties:
        id: { type: string }
        kind: { type: string, enum: [human, agent] }
        handle: { type: string }
        display_name: { type: string }
        description: { type: string }
        created_at: { type: string }
    AuditEntry:
      type: object
      properties:
        id: { type: integer }
        actor_id: { type: ['string', 'null'] }
        token_id: { type: ['string', 'null'] }
        action: { type: string }
        entity_type: { type: string }
        entity_id: { type: string }
        before: {}
        after: {}
        reason: { type: ['string', 'null'] }
        created_at: { type: string }
    Problem:
      type: object
      description: RFC 9457; `already_claimed` additionally carries holder_handle/holder_display_name
      required: [type, title, status, code]
      properties:
        type: { type: string }
        title: { type: string }
        status: { type: integer }
        code:
          type: string
          enum:
            [
              not_found,
              forbidden,
              unauthenticated,
              invalid_request,
              internal_error,
              handle_taken,
              already_claimed,
              not_a_leaf,
              open_descendants,
              canceled_terminal,
              stale_lease,
              dependency_cycle,
              agent_close_forbidden,
              open_questions,
              threads_on_parent,
              idempotency_in_flight,
            ]
        detail: { type: string }
```

- [ ] **Step 17.2: Serve the spec** — in `buildApp`, directly after the `/ping` route (path is already in `PUBLIC_PATHS`):

```ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
// …
server.get('/openapi.yaml', async (_request, reply) => {
  const spec = await readFile(join(process.cwd(), 'openapi', 'openapi.yaml'), 'utf8')
  return reply.type('application/yaml').send(spec)
})
```

- [ ] **Step 17.3: Write the contract test** `src/adapters/rest/openapi-contract.test.ts`:

```ts
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import type { FastifyInstance } from 'fastify'
import { makeTestApp } from '#root/testing/test-app'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const SKIP_NODE_KEYS = new Set(['meta', 'cors', 'preflight', 'wildcard', 'HEAD', 'version', '...'])

interface SpecPathItem {
  [method: string]: unknown
}

const specKeys = (spec: { paths: Record<string, SpecPathItem> }): string[] => {
  const keys: string[] = []
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      if (item[method.toLowerCase()]) keys.push(`${method} ${path}`)
    }
  }
  return keys.sort()
}

interface RouteNode {
  [key: string]: unknown
}

const routeKeys = (app: FastifyInstance): string[] => {
  const keys = new Set<string>()
  const json = app.printRoutes({ commonPrefix: false, output: 'json' }) as unknown as {
    tree: RouteNode
  }
  const walk = (node: RouteNode, prefix: string): void => {
    for (const [key, child] of Object.entries(node)) {
      if (SKIP_NODE_KEYS.has(key)) continue
      if (METHODS.includes(key)) {
        keys.add(`${key} ${prefix.replace(/:([^/]+)/g, '{$1}')}`)
        continue
      }
      if (child && typeof child === 'object') {
        walk(child as RouteNode, key === '' ? prefix : `${prefix}/${key}`)
      }
    }
  }
  walk(json.tree, '')
  return [...keys].sort()
}

describe('OpenAPI contract (spec §7.1: committed spec = product contract)', () => {
  it('serves the spec at /openapi.yaml', async () => {
    const t = await makeTestApp()
    const res = await t.app.inject({ method: 'GET', url: '/openapi.yaml' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/yaml')
    await t.close()
  })

  it('no drift: every documented path+method is served, every served route is documented', async () => {
    const spec = parse(await readFile('openapi/openapi.yaml', 'utf8')) as {
      openapi: string
      paths: Record<string, SpecPathItem>
    }
    expect(spec.openapi).toBe('3.1.0')

    const t = await makeTestApp()
    const served = routeKeys(t.app)
    const documented = specKeys(spec)
    await t.close()

    expect(documented).toEqual(served)
  })
})
```

- [ ] **Step 17.4: Verify green + suite, hygiene, commit.**

```bash
pnpm test && pnpm lint && pnpm typecheck
git add -A && git commit -m "feat(api): OpenAPI 3.1 contract, served spec, drift test"
```

---

### Task 18: Acceptance scenario (spec §14, agent-side) + final gate

**Files:**

- Test: `src/adapters/rest/scenarios.test.ts`

- [ ] **Step 18.1: Write the acceptance test** `src/adapters/rest/scenarios.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { makeTestApp, type TestApp } from '#root/testing/test-app'

const bearer = (t: TestApp, token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
})

const createActor = async (t: TestApp, kind: 'human' | 'agent', handle: string): Promise<string> =>
  (
    await t.app.inject({
      method: 'POST',
      url: '/admin/actors',
      headers: bearer(t, t.adminToken),
      payload: { kind, handle, display_name: handle },
    })
  ).json().id as string

const issueToken = async (t: TestApp, actorId: string): Promise<string> =>
  (
    await t.app.inject({
      method: 'POST',
      url: `/admin/actors/${actorId}/tokens`,
      headers: bearer(t, t.adminToken),
      payload: { label: 'acceptance' },
    })
  ).json().raw_token as string

describe('acceptance (spec §14 — agent side; human OIDC login and threads arrive in Plans B/E)', () => {
  it('full multi-actor story: file, race, split, parallel work, review gate, audit story', async () => {
    const t = await makeTestApp()
    const nils = bearer(t, t.adminToken) // bootstrap human

    // §14.1 — admin enables a second human + creates agent hermes-1 (two tokens = two sessions)
    const anaId = await createActor(t, 'human', 'ana')
    expect(anaId).toMatch(/^a_seq/)
    const anaToken = await issueToken(t, anaId)
    const hermes = await createActor(t, 'agent', 'hermes-1')
    const sess1 = await issueToken(t, hermes)
    const sess2 = await issueToken(t, hermes)

    // §14.2 — human files task with AC → todo (spec.md upload is Plan B)
    const task = (
      await t.app.inject({
        method: 'POST',
        url: '/tasks',
        headers: nils,
        payload: {
          title: 'Rate limiter',
          description: 'protect /api',
          acceptance_criteria: '429 under load',
          status: 'todo',
        },
      })
    ).json()

    // §14.3 — two concurrent sessions race: exactly one wins
    const [r1, r2] = await Promise.all([
      t.app.inject({ method: 'POST', url: `/tasks/${task.id}/claim`, headers: bearer(t, sess1) }),
      t.app.inject({ method: 'POST', url: `/tasks/${task.id}/claim`, headers: bearer(t, sess2) }),
    ])
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 409])
    const winner = r1.statusCode === 200 ? r1 : r2
    const loser = r1.statusCode === 200 ? r2 : r1
    expect(loser.json().code).toBe('already_claimed')
    expect(loser.json().holder_handle).toBe('hermes-1')

    // §14.4 — winner splits into 2 children; claim auto-released; claims a child
    const split = (
      await t.app.inject({
        method: 'POST',
        url: `/tasks/${task.id}/split`,
        headers: bearer(t, sess1),
        payload: {
          children: [
            { title: 'redis window', acceptance_criteria: 'sliding', status: 'todo' },
            { title: '429 payload', acceptance_criteria: 'RFC', status: 'todo' },
          ],
        },
      })
    ).json()
    const parentAfter = (
      await t.app.inject({ method: 'GET', url: `/tasks/${task.id}`, headers: nils })
    ).json()
    expect(parentAfter.claim_token_id).toBeNull()
    const c1 = split.created[0].id as string
    const c2 = split.created[1].id as string
    expect(
      (await t.app.inject({ method: 'POST', url: `/tasks/${c1}/claim`, headers: bearer(t, sess1) }))
        .statusCode
    ).toBe(200)

    // §14.5 — question gate seam: no threads exist in Plan A, so review proceeds (gate wired in B)

    // §14.6 — second session claims the sibling; both reach in_review; humans close
    expect(
      (await t.app.inject({ method: 'POST', url: `/tasks/${c2}/claim`, headers: bearer(t, sess2) }))
        .statusCode
    ).toBe(200)
    for (const [child, tok] of [
      [c1, sess1],
      [c2, sess2],
    ] as const) {
      const claim = await t.app.inject({
        method: 'POST',
        url: `/tasks/${child}/claim`,
        headers: bearer(t, tok),
      })
      // first claim above may already hold it; only c1 double-claims — handle both outcomes:
      if (claim.statusCode === 409) continue
      const review = await t.app.inject({
        method: 'PATCH',
        url: `/tasks/${child}/status`,
        headers: bearer(t, tok),
        payload: { status: 'in_review', reason: 'PR ready', lease_token: claim.json().lease_token },
      })
      expect(review.statusCode).toBe(200)
    }
    // c1 review (holder is sess1 from §14.4 claim):
    const c1Claim = (
      await t.app.inject({ method: 'GET', url: `/tasks/${c1}`, headers: nils })
    ).json()
    if (c1Claim.status !== 'in_review') {
      // re-claim was impossible (already claimed) — drive review with the live lease:
      const lease = `${c1}:${c1Claim.claim_generation}`
      const review = await t.app.inject({
        method: 'PATCH',
        url: `/tasks/${c1}/status`,
        headers: bearer(t, sess1),
        payload: { status: 'in_review', reason: 'PR ready', lease_token: lease },
      })
      expect(review.statusCode).toBe(200)
    }

    // agents still cannot close:
    expect(
      (
        await t.app.inject({
          method: 'PATCH',
          url: `/tasks/${c1}/status`,
          headers: bearer(t, sess1),
          payload: { status: 'done', reason: 'nope' },
        })
      ).json().code
    ).toBe('agent_close_forbidden')

    for (const child of [c1, c2]) {
      expect(
        (
          await t.app.inject({
            method: 'PATCH',
            url: `/tasks/${child}/status`,
            headers: bearer(t, anaToken),
            payload: { status: 'done', reason: 'reviewed, LGTM' },
          })
        ).statusCode
      ).toBe(200)
    }
    expect(
      (
        await t.app.inject({
          method: 'PATCH',
          url: `/tasks/${task.id}/status`,
          headers: nils,
          payload: { status: 'done', reason: 'all leaves done' },
        })
      ).statusCode
    ).toBe(200)

    // §14.7 — audit reconstructs the story; rollups visible; nothing hidden (ana sees nils' actions)
    const audit = (
      await t.app.inject({ method: 'GET', url: `/audit?limit=200`, headers: bearer(t, anaToken) })
    ).json()
    const story = audit.map((a: { action: string }) => a.action)
    expect(story).toEqual(
      expect.arrayContaining([
        'actor_created',
        'token_created',
        'task_created',
        'claim_acquired',
        'already_claimed'.replace('already_claimed', 'claim_acquired'),
      ])
    )
    expect(story.filter((a: string) => a === 'claim_acquired').length).toBeGreaterThanOrEqual(3)
    expect(story).toContain('task_split')
    expect(story.filter((a: string) => a === 'status_changed').length).toBeGreaterThanOrEqual(5)

    const board = (
      await t.app.inject({ method: 'GET', url: '/tasks', headers: bearer(t, anaToken) })
    ).json()
    const parent = board.find((x: { id: string }) => x.id === task.id)
    expect(parent.status).toBe('done')
    expect(parent.child_count).toBe(2)
    expect(
      board
        .filter((x: { parent_id: string | null }) => x.parent_id === task.id)
        .every((x: { status: string }) => x.status === 'done')
    ).toBe(true)
    expect(
      (
        await t.app.inject({ method: 'GET', url: '/tasks/next', headers: bearer(t, anaToken) })
      ).json()
    ).toEqual([])

    await t.close()
  })
})
```

**Implementer note:** the `already_claimed'.replace(...)` line is obfuscated noise — in the final file write `expect(story).toEqual(expect.arrayContaining(['actor_created', 'token_created', 'task_created', 'claim_acquired', 'claim_released', 'task_split', 'status_changed']))`. Also simplify the c1/c2 review dance: after the split, **release nothing** — sess1 still holds the child claims made in §14.4/§14.6, and each session patches `in_review` with its own live lease exactly once; drop the `if (claim.statusCode === 409) continue` fallback by claiming c1 in §14.4 and c2 in §14.6 only, then in_review each with that claim's returned `lease_token`. The final file must have zero branches on `claim.statusCode`.

- [ ] **Step 18.2: Final gate.**

```bash
pnpm test
pnpm test:coverage   # global ≥85%, domain 100% — add tests to close gaps, never lower domain thresholds
pnpm lint && pnpm typecheck
pnpm build && node -e "console.log('build ok')"
```

Expected: all green.

- [ ] **Step 18.3: Commit.**

```bash
git add -A && git commit -m "test(acceptance): spec §14 agent-side end-to-end story"
```

---

## Self-review (run 2026-09-06 against the spec)

**1. Spec coverage** — Plan A scope, requirement → implementing task:

| Spec                                                                    | Where                                                                              |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| §5 actors, roles, hashed one-time tokens, per-actor audit               | T2 (codes), T13 (auth/bootstrap), T16 (admin)                                      |
| §6.1 task fields incl. separate `acceptance_criteria`, soft-cancel-only | T2, T3 (schema), T9 (`canceled_terminal`)                                          |
| §6.2 split atomicity, claim auto-release, fencing generation bump       | T8 (+ test asserts old lease dead)                                                 |
| §6.3 blocks + cycle detection + `ready()`                               | T5 (cycle CTE), T11, T12, T15                                                      |
| §6.4 invariants 1–5, 7                                                  | T10 (1,3,4), T9 (2,5), structural (7); #6 seam wired in T9, behavior in Plan B     |
| §6.7 audit append-only + activity search + machine reasons              | T3 (no update/delete paths), T4, T13 (route)                                       |
| §7.1 contract-first                                                     | T17                                                                                |
| §7.2 endpoints (non-Plan-B subset)                                      | T14 (tasks/claim/…), T15, T16                                                      |
| §7.3 idempotency incl. replay + crash-retry                             | T6, T13 (middleware), T14 (replay test)                                            |
| §7.4 loop                                                               | T14 integration test                                                               |
| §10 security (bearer, SHA-256 at rest, last-used, no bypass paths)      | T13; rate-limit hook deferred (noted in header)                                    |
| §11 errors RFC 9457 + all stable codes                                  | T2 codes, T13 handler, T14/T15/T16 assert each code                                |
| §11 tests 1–3 (domain/property, API integration, contract)              | T2/T10, T14/T18, T17; test 4 (MCP parity) is Plan D, test 5 (Playwright) is Plan E |
| §14 acceptance agent-side                                               | T18; OIDC-login half is Plan E                                                     |

**2. Placeholder scan:** every code step contains complete code; the three "implementer note" blocks mark deliberate scaffolding-in-test-drafts with their final form spelled out — no TBDs, no "similar to Task N".

**3. Type consistency:** cross-checked signatures — `tryClaim(taskId, tokenId, claimantActorId, status, updated_at)`, `clearClaim(taskId, updated_at)`, `wouldCycle(blockerId, blockedId)`, `ClaimResult.lease_token/generation`, `SplitTaskResult{parent, created}`, `AppDeps.useCases` keys used identically in routes (T14–T16) as defined in T13; `kysely/migration` import used for all migration symbols (T3), plain `kysely` elsewhere.

---

**Plan complete.** 18 tasks, each TDD-red-green-committed; end state is the curl-testable agent core the spec's §14 story runs against.
