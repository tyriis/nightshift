# Plan C: Event Feed & Webhook Delivery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship spec §6.8/§9's async surface: a restart-monotonic `GET /events?cursor=` feed over the audit spine, an admin-registered HMAC-signed webhook delivery loop (best-effort, at-least-once, backoff), FTS5 task search behind a repo port (no UI), and the `claim_conflict` inbox kind whose prerequisite (runner wake paths) this plan builds.

**Architecture:** The append-only `audit_log` IS the event outbox (D-aa): every use-case already appends its audit row inside its own transaction, so "outbox row in-tx, delivery after commit" holds by construction. The feed is a tail read (`id > cursor`, ascending); webhook delivery is an interval-driven infra loop holding a per-webhook checkpoint (`delivered_cursor`), doing all network I/O strictly outside transactions. `claim_conflict` rides a second transaction in `ClaimTask` (the loser copy D-r deferred until wake paths existed).

**Tech Stack:** TypeScript ESM, fastify 5.12.3, Kysely 0.29.5 + better-sqlite3 13.0.3 (FTS5 compiled in), vitest 4, node:crypto (HMAC), global fetch + `AbortSignal.timeout`.

---

## Status & provenance

- Branch: `feature/plan-c-events-webhooks` off `main` @ `2eb0e7c` (PR #3 merge commit). **No pushes** — merges and PRs are @tyriis's (binding).
- Ticket: tyriis/nightshift#4. Inputs: spec `docs/superpowers/specs/2026-09-05-nightshift-design.md` (§6.8, §7.2, §9, §11, §12); Plan B record `docs/superpowers/plans/2026-09-11-nightshift-plan-b-threads-questions.md`; Plan A record.
- Baseline gate (recorded by the planner 2026-09-08 at `2eb0e7c` = the PR #3 merge): **374 tests / 55 files; Stmts 99.71 / Branch 97.91 / Funcs 100 / Lines 99.89**; lint / typecheck / build clean. The uncovered set is exactly Plan B's documented arms (`task-repo.ts:151-164`, `thread-repo.ts:96/132`, `rate-limit.ts:35`, `auth.ts:47`, `migrations.ts:193`). This is the local evidence for the issue-#4 backlog item "first `pnpm test:coverage` CI step green post-Plan-B-merge" — CI itself becomes observable only after @tyriis pushes (we do not push).

- Baseline gate **confirmed green at execution start (2026-09-08)**: same 374/55, same coverage figures, lint/typecheck/build clean.

### Inherited binding rulings (Plans A+B — obey; violation = task failure)

- **Error taxonomy is one map**: any new DomainErrorCode goes into `src/domain/errors.ts` `DOMAIN_ERROR_STATUS` **and** the yaml `Problem.code` enum in the SAME commit (drift test `openapi-contract.test.ts:107-110` pins `domain ∪ adapter`). Adapter codes go in `ADAPTER_ERROR_CODES` (`problem.ts:16`). `DomainError.details` ride the FLAT envelope — `code`+detail fields pinned, never nested.
- **Audit is append-only, never purged** (v1). Machine reason strings `claim released by split` / `claim released on review` / `meta-note on parent (spec §6.2)` are grep-pinned — **never reword**. Every NEW reason string introduced here is pinned forward by a test in the same task.
- `PUBLIC_PATHS` stays exactly `{/ping, /openapi.yaml}` (auth.ts:16). `/events` and `/admin/webhooks*` are authenticated surfaces.
- Admin routes use the **async** `requireHuman` (sync-void preHandler deadlocks fastify 5's hook iterator — R4). `actorCtx` spreads **LAST** in every body-merge.
- **UoW is FIFO and NON-REENTRANT**: never touch the root db from inside `withTransaction` (silent deadlock — uow.ts:38-42). **Never hold a transaction open across network I/O.**
- **Hook order** `auth → idempotency → rate-limit` (app.ts:47-50): replays short-circuit before the limiter. New routes inherit; do not add onRequest hooks.
- **Time seam (T14 standard)**: throttle/retry DECISIONS on real elapsed time use raw `Date.now` with an in-code seam comment; RECORDED timestamps use the `Clock` port (`deps.clock`). Choose per site deliberately, comment it.
- **Ghost-task standard**: a typo'd id 404s, never masquerades as empty (precedent: threads/attachments/links list routes; `D-r` never-403-no-existence-leak for owned subresources).
- `removeAdditional` status quo: fastify silently STRIPS unknown body keys (probe-verified, Plan B Task 7 amendment) — new routes PIN that parity (extra key → 201); flipping to 400-on-extras is a queued human decision, NOT a Plan C task.
- Untouched: `ready()` (Ruling A), single-statement claim CAS with generation fencing, D-o invariant-6 semantics, D-s content-addressed store, D-q mention grammar. No second sources of truth.
- `src/application/` stays free of `node:crypto` EXCEPT the sanctioned pure-util `token-hash` import (manage-actors precedent). HMAC lives in infra.
- Coverage thresholds **unchanged** (global ≥85, `src/domain/**` 100); `pnpm test:coverage` green at every commit. No new runtime dependencies.
- Conventions: `pnpm test <file>` red/green, `pnpm test && pnpm lint && pnpm typecheck` before commit; `LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "<subject>"`, conventional, **subject ≤ 72 chars**; ISO-8601 UTC timestamps; tests colocated `*.test.ts`; env tests via `makeTestApp(overrides)`; temp paths via `os.tmpdir()`; tests never read `.env`/secret paths; no fake RED — honest declarations for unreachable arms.

### Plan ⇄ shipped byte-sync protocol (same as Plans A+B)

The code blocks below are the planned text. If shipped code lands byte-different from a block (review repair, lint normalization, API correction), the implementer appends a `> **Amendment (Task N, <who/what>):** …` blockquote to that task's section in THIS file, quoting what changed (with `git show <hash>` for review repairs) and re-labels the block `sync = shipped form` once identical. Never leave the plan silently describing code that does not exist. A commit cannot quote its own hash — amendments land in the child fix commit. A pin that passes first-run says so: "there is no RED phase to claim and none is claimed."

---

## Decision records (Plan C — D-aa … D-gg)

**D-aa — The audit log IS the outbox; cursor = `audit_log.id`.** Spec §9 names both "in-proc event bus + outbox table"; the ticket orders one recorded choice. Chosen: **no event bus, no event/outbox table** — the feed reads `audit_log` directly (`tail(after, limit)`, ascending; `watermark()` = `max(id)`). Why: every mutation already appends its audit row inside its own transaction (25 call sites), which IS the outbox pattern's in-tx guarantee; a parallel event table would be a second source of truth for "what happened" and drift exactly like the audit the event mirror would shadow. `audit_log.id` is `integer primary key autoincrement` — monotonic across restarts because the table is append-only and never purged (spec §6.7); cursor semantics hold by ruling, not accident (Plan B cut-list, L19: "`audit_log.id` stays the natural future cursor"). §9 naming drift is stated: the "DeliveryQueue port" of §9 materializes as the infra loop class + `WebhookRepo` checkpoint methods, not an application-visible enqueue port — use-cases never enqueue; the commit IS the enqueue. Honest clause (D-v lineage): single-process, in-memory timer — honest for the single-container model (§9).

**D-bb — Delivery: per-webhook checkpoint, all events, at-least-once, exponential backoff.** One `webhooks` row per callback carrying its own `delivered_cursor`/`attempts`/`next_attempt_at` (the checkpoint lives ON the webhook row; a separate deliveries ledger would be the second source D-aa rejects). The loop tails past each due webhook and POSTs **one event per request** with the spec §6.8 envelope, literally `{event, task_id, cursor}` — no extra fields without an amendment. `task_id = entity_id` iff `entity_type='task'`, else `null`. **No filtering**: every audit row is an event to every webhook — assignment-scoped fan-out is a runner-side judgment (a false wake costs one poll; a missed wake costs work); a per-webhook event allowlist is deferred until a real consumer wants it. HMAC-SHA256 of the exact bytes POSTed → `X-Nightshift-Signature: sha256=<hex>` + `X-Nightshift-Timestamp`. ACK = any 2xx; failure ⇒ checkpoint stays, `attempts += 1`, `next_attempt_at = now + min(maxBackoff, 1000·2^attempts)` (T14 side: raw `Date.now`). Checkpoint advances per-ACK ⇒ **at-least-once**; duplicates ride on the cursor's idempotency. A **new webhook's checkpoint anchors at the audit watermark INCLUDING its own `webhook_created` row** (a registering runner is woken for what happens NEXT — never for its own registration); **rotation re-anchors identically** (a rotating runner re-registers; no backlog flood, no self-notify). `advance` (per-ACK) moves the checkpoint and clears the backoff counter; `reanchor` additionally un-parks `next_attempt_at`. Batch cap 50 events/webhook/tick; backlog drains across ticks. Re-entrancy guard on `tick()`.

**D-cc — `claim_conflict` inbox kind: INCLUDED.** D-r deferred it verbatim: "An async copy adds nothing until runner wake paths exist (C)" — webhooks ARE that path; spec §6.8 lists the kind. Three vocabulary surfaces move in ONE commit (D-r lesson): domain `INBOX_ITEM_KINDS`, the DDL CHECK (SQLite cannot ALTER a CHECK ⇒ full table rebuild in migration `2026-09-12_inbox_claim_conflict`), and the yaml `InboxItem.kind` enum. Emission: `ClaimTask` catches its own `already_claimed` and writes the loser copy in a **second transaction** (the first rolled back; rethrowing unchanged keeps the 409 contract byte-exact). Skip when `details.holder_handle === actor.handle` (a holder re-claiming its own task must not spam its inbox). NOT audited — a rejection is not a workspace mutation (D-r doctrine: the causing action is audited; read-state and rejections are not).

**D-dd — `/events` BURNS the per-actor rate-limit budget.** No new mechanism: it reaches the rate-limit hook with a non-null `actorRef` like any GET (D-v's burn rule), and tailing at 120 req/min per actor is ample for poll loops (webhooks are the push path — that's the division of labor). Pin: `makeTestApp({NS_RATE_LIMIT_PER_MIN:'2'})`, third `/events` → 429 `rate_limited`.

**D-ee — SSE wrapper: SLICED OUT.** Spec §6.8 defers it literally ("SSE wrapper later") and §12 lists "SSE feed wrapper" among deferred items; v1 consumers are agents (webhooks + cursor tail) and the Plan E UI, which polls. `long-poll/SSE can ride the same audit spine additively later (a waiter on watermark changes) — slicing it now costs nothing anyone has asked for.

**D-ff — Webhook secrets: generated, plaintext at rest, shown exactly once.** An HMAC signing key must be re-readable by the delivery loop — unlike bearer tokens it CANNOT be stored hashed (the D-s token doctrine flips here, stated as the deliberate exception it is). Same 32-byte base64url strength as agent tokens. Exposure surface is engineered to zero: `WebhookRepo` read methods SELECT every column except `secret` (the record type never carries it); only `listDue()` (the loop's private read path) and the create/rotate responses ever emit it. Audit rows for webhook mutations never include the secret. Human-only admin surface (`requireHuman`) reconciles spec's "admin registers" with D-h precedent; the bootstrap token counts.

**D-gg — FTS5: external-content index over `tasks`, repo-port read only.** Spec §9: "built now, no UI yet"; §12 defers the search UI. `task_fts` external-content (`content='tasks'`, `content_rowid='rowid'` — `tasks` keeps its implicit rowid; the TEXT pk is not a rowid alias) + three triggers mirroring insert/update/delete + `rebuild` in the migration populates from existing rows. Read is `TaskSearchRepo.search(query, limit)` on a root-only repo (`bm25` ranking flipped to higher-is-better, `snippet()` on title); malformed FTS syntax maps to `DomainError('invalid_request')`. NO route, NO yaml — registering a route without a contract entry fails the drift test, and the contract has nothing to expose until §12 lifts.

---

## Explicitly sliced out (stated, with reasons)

- **SSE wrapper** — D-ee.
- **Per-webhook event filtering / assignee-scoped fan-out** — D-bb; the spec payload has no consumer for it yet.
- **PATCH `/admin/webhooks/:id`** — YAGNI; delete+recreate (or rotate) covers change-of-url; checkpoint loss is harmless under best-effort.
- **Search UI / `/search` route / search yaml** — spec §12 defers the UI; D-gg keeps the read port-only.
- **`removeAdditional` 400-on-extras flip** — queued HUMAN decision (Plan B Task 7 amendment blast-radius); new routes pin the strip-parity status quo instead.
- **Delivery backlog cap / dead-lettering** — audit is never purged, so a long-dead webhook just backoff-caps at `maxBackoff`; deleting the webhook is the kill switch. A dead-letter table is a second ledger D-bb rejects.
- **`claim_conflict` on split-released claims** — §6.8's kind is the CLAIM-RACE loser copy; split already releases with the grep-pinned audit string. No new wake semantics invented here.

### Backlog disposition (issue #4 → this plan)

| Backlog item                                                                                       | Where                                                                                                           |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| First `pnpm test:coverage` CI step green post-Plan-B-merge                                         | Task 1 (local gate record on merged main; CI itself is only observable after @tyriis pushes — noted, not ours)  |
| `routes/admin.ts:27` re-lists `['human','agent']` → derive from domain const (`8ebab6b` precedent) | Task 16 (introduces `ACTOR_KINDS` const tuple — `ActorKind` is today a bare union with no tuple to derive from) |
| `routes/links.ts` value+type import merge                                                          | Task 16                                                                                                         |
| Platform decision `removeAdditional`                                                               | NOT folded — stays a queued human decision (see sliced-out list); parity pinned in Task 9                       |

---

## File structure

**New files:**

| Path                                                                              | Responsibility                                                                                             |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/adapters/rest/routes/events.ts`                                              | `GET /events` — cursor tail over the audit spine (D-aa/D-dd)                                               |
| `src/adapters/rest/routes/webhooks.ts`                                            | `/admin/webhooks*` human-only CRUD + rotate (D-ff)                                                         |
| `src/application/usecases/manage-webhooks.ts`                                     | CreateWebhook / DeleteWebhook / RotateWebhookSecret (D-bb/D-ff)                                            |
| `src/infra/sqlite/webhook-repo.ts`                                                | `SqliteWebhookRepo implements WebhookRepo` — secret never leaves the read path except via `listDue` (D-ff) |
| `src/infra/sqlite/search-repo.ts`                                                 | `SqliteSearchRepo implements TaskSearchRepo` — FTS5 match, bm25, snippet (D-gg)                            |
| `src/infra/webhooks/delivery-loop.ts`                                             | `WebhookDeliveryLoop` — interval drain, HMAC sign, checkpoint/backoff (D-bb)                               |
| colocated `*.test.ts` for each, plus `src/adapters/rest/scenarios-events.test.ts` |                                                                                                            |

**Modified files:** `src/domain/discussion.ts` (+`claim_conflict`), `src/domain/task.ts` (`ACTOR_KINDS` tuple, Task 16), `src/application/ports.ts` (`AuditRepo.tail/watermark`, `WebhookRepo`, `TaskSearchRepo`, `Repos.webhooks`), `src/infra/sqlite/{migrations,schema,uow,audit-repo}.ts`, `src/application/usecases/claim-task.ts` (D-cc emission), `src/main/{config,deps}.ts`, `src/index.ts` (loop start/stop), `src/adapters/rest/app.ts` (two registrations), `src/adapters/rest/routes/{admin,links}.ts` (Task 16), `src/testing/test-app.ts` (loop off by default), `openapi/openapi.yaml` (`/events`, `/admin/webhooks*`, `Event`/`Webhook`/`WebhookWithSecret` schemas, `InboxItem.kind` enum), `src/infra/sqlite/migrations.test.ts`, `src/main/config.test.ts` (or its existing test), `src/infra/token-hash.ts`.

---

## Execution protocol (from Plans A+B, binding)

- Fresh implementer subagent per task, **strict serial order** (Tasks 2–5 and 9–13 all touch `ports.ts`/`migrations.ts`/`deps.ts`/`app.ts` — no parallel lanes on shared wiring). TDD per steps; independent spec-review + quality-review BEFORE the next task starts; fix rounds re-verified by the same reviewer; amendments per the byte-sync protocol.
- Commit per task with `LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "<subject>"` (subjects below, all ≤72 chars). **No pushes.**
- Never-lower bar: `pnpm test:coverage` green every commit; machine strings byte-exact; `PUBLIC_PATHS` membership unchanged; `actorCtx` last; no new runtime deps.
- Final: record coverage line + test count in the header's Baseline/final gate (Task 17).

---

## Task 1: Baseline gate confirmation (backlog: first coverage-step check)

The planner ran the full gate at `2eb0e7c` on 2026-09-08 and recorded it under Status & provenance; this task is the execution-time confirmation.

**Files:**

- Modify: `docs/superpowers/plans/2026-09-08-nightshift-plan-c-events-webhooks.md` (append the confirmation line under the recorded baseline)

- [ ] **Step 1: Re-run the full gate**

Run: `pnpm test:coverage && pnpm lint && pnpm typecheck && pnpm build`
Expected: green, matching the recorded baseline line (same test/file counts and coverage figures — the branch adds only this doc).

- [ ] **Step 2: Record the confirmation**

Append `Confirmed green at execution start (<date>).` under the Baseline gate line. If any step is RED, STOP — the plan is blocked on main; report and wait.

- [ ] **Step 3: Commit**

```bash
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git add docs/superpowers/plans/2026-09-08-nightshift-plan-c-events-webhooks.md && LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "docs(plan): confirm plan C baseline gate green"
```

---

## Task 2: `claim_conflict` inbox vocabulary — domain + DDL + contract in one commit (D-cc)

Three vocabulary surfaces move together (D-r lesson; the drift test catches only the yaml half, the migrations test catches the DDL half, the domain test catches the TS half — this task turns all three from "excluded" to "included"). SQLite cannot ALTER a CHECK, so the table is rebuilt in place.

**Files:**

- Modify: `src/domain/discussion.ts:24-25`
- Modify: `src/infra/sqlite/migrations.ts` (append migration key AFTER `'2026-09-11_discussion'` — Kysely sorts keys lexically, so the name MUST be later than `2026-09-11`)
- Modify: `src/infra/sqlite/migrations.test.ts:162-168`
- Modify: `openapi/openapi.yaml:919-931` (InboxItem schema)
- Test: any domain test pinning `INBOX_ITEM_KINDS` (grep first: `rg "INBOX_ITEM_KINDS" src --glob '*.test.ts'`)

- [ ] **Step 1: Flip the DDL pin to RED-first**

In `src/infra/sqlite/migrations.test.ts`, replace the block at :162-168:

```ts
// inbox: kind vocabulary — claim_conflict deliberately NOT in the vocabulary (D-r)
await sql`insert into inbox_items (id, actor_id, kind, task_id, read, created_at)
                values ('ib_1','a_x','assigned','t_x',0,'2026-01-01')`.execute(db)
await expect(
  sql`insert into inbox_items (id, actor_id, kind, task_id, read, created_at)
            values ('ib_2','a_x','claim_conflict','t_x',0,'2026-01-01')`.execute(db)
).rejects.toThrow(/CHECK|check/i)
```

with:

```ts
// inbox: kind vocabulary — claim_conflict IN the vocabulary since Plan C (D-cc
// extends D-r's set once wake paths exist); the fourth bogus kind stays rejected
await sql`insert into inbox_items (id, actor_id, kind, task_id, read, created_at)
                values ('ib_1','a_x','assigned','t_x',0,'2026-01-01')`.execute(db)
await sql`insert into inbox_items (id, actor_id, kind, task_id, read, created_at)
                values ('ib_cc','a_x','claim_conflict','t_x',0,'2026-01-01')`.execute(db)
await expect(
  sql`insert into inbox_items (id, actor_id, kind, task_id, read, created_at)
            values ('ib_2','a_x','bogus_kind','t_x',0,'2026-01-01')`.execute(db)
).rejects.toThrow(/CHECK|check/i)
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/infra/sqlite/migrations.test.ts`
Expected: FAIL — the `claim_conflict` insert throws CHECK (rejection not yet extended).

- [ ] **Step 3: Append the migration**

In `src/infra/sqlite/migrations.ts`, after the `'2026-09-11_discussion'` entry (same `migrations` map), append:

```ts
  '2026-09-12_inbox_claim_conflict': {
    up: async (db: Kysely<DB>) => {
      // D-cc: claim_conflict joins the inbox vocabulary (D-r deferred it until runner
      // wake paths exist — webhooks ship that path in this plan). SQLite cannot ALTER
      // a CHECK, so the table is rebuilt in place: identical columns, extended set,
      // then the data rides across in one statement. Column list is explicit (never
      // select *) so a future column addition fails this copy LOUDLY.
      await sql`create table inbox_items_v2 (
        id text primary key,
        actor_id text not null references actors(id),
        kind text not null check (kind in ('assigned','mentioned','question_assigned','claim_conflict')),
        task_id text not null references tasks(id),
        thread_id text references threads(id),
        read integer not null default 0 check (read in (0,1)),
        created_at text not null
      )`.execute(db)
      await sql`insert into inbox_items_v2
                  select id, actor_id, kind, task_id, thread_id, read, created_at from inbox_items`.execute(db)
      await sql`drop table inbox_items`.execute(db)
      await sql`alter table inbox_items_v2 rename to inbox_items`.execute(db)
      // re-create the (actor, read) index dropped with the old table — same name, same
      // definition as the discussion migration's EXPLAIN-verified pin
      await sql`create index inbox_actor_idx on inbox_items (actor_id, read)`.execute(db)
    },
  },
```

**Honest-unreachable declaration:** the `insert…select` data-carry of the rebuild cannot run against pre-existing rows in CI (every test db migrates fresh; the migration map is module-private so no step-up probe exists). On CI the copy moves 0 rows. It earns its keep at the first homelab deploy (Plan F smoke). The insert-select is one reviewed statement; the vocabulary half IS fully pinned by Step 1. No fake RED is claimed for the data path.

- [ ] **Step 4: Extend the domain vocabulary**

`src/domain/discussion.ts` — replace :24-25:

```ts
// Decision D-r built the first three; D-cc (Plan C) adds claim_conflict now that the
// runner wake paths (webhooks) exist — D-r's deferral condition ("until runner wake
// paths exist") is discharged, not overridden. DDL CHECK + yaml enum moved in the
// same commit; the (now-stale, fixed-here) "deferred (D-s)" comment typo of Plan B
// pointed at the filestore decision — the deferral was always D-r's.
export const INBOX_ITEM_KINDS = [
  'assigned',
  'mentioned',
  'question_assigned',
  'claim_conflict',
] as const
```

- [ ] **Step 5: Move the yaml surface in the same commit's working tree**

`openapi/openapi.yaml` InboxItem schema (:919-931) becomes:

```yaml
InboxItem:
  type: object
  description: >-
    inbox entry (ports.ts InboxItemRecord); kind vocabulary mirrors domain
    INBOX_ITEM_KINDS (D-r, extended by D-cc in Plan C: claim_conflict rides the
    webhook wake path)
  properties:
    id: { type: 'string' }
    actor_id: { type: 'string' }
    kind: { type: string, enum: [assigned, mentioned, question_assigned, claim_conflict] }
    task_id: { type: 'string' }
    thread_id: { type: ['string', 'null'] }
    read: { type: boolean }
    created_at: { type: 'string' }
```

(Keep the file's existing quote style — the surrounding schema uses unquoted `"string"`-free forms only inside `type:` unions; match what is on disk, do not churn quotes.)

- [ ] **Step 6: Run everything the vocabulary touches**

Run: `pnpm test src/infra/sqlite/migrations.test.ts src/adapters/rest/openapi-contract.test.ts && pnpm test && pnpm lint && pnpm typecheck`
Expected: all green (domain tuple extension is type-compatible everywhere — no exhaustive switch exists over InboxKind; if `pnpm test` finds a pin expecting the 3-tuple, update its expectation to the 4-tuple and say so here).

- [ ] **Step 7: Commit (one commit — the three surfaces must not split)**

```bash
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -am "feat(inbox): admit claim_conflict across all three surfaces"
```

> **Amendment (Task 2, 4-tuple pin + printWidth normalizations):** Three byte-sync notes. (1) Step 6 pre-authorized this one: `src/domain/discussion.test.ts` pinned the 3-tuple (`expect(INBOX_ITEM_KINDS).toEqual(['assigned', 'mentioned', 'question_assigned'])`) — the expectation moved to the 4-tuple `['assigned', 'mentioned', 'question_assigned', 'claim_conflict']` in this same commit; prettier wraps the call across lines (printWidth 100). (2) The Step 5 block showed quoted `type: 'string'` property lines; the shipped yaml is unquoted (`{ type: string }`) per that step's own keep-disk-style parenthetical and prettier's yaml `singleQuote: false` — only the quote characters differ, structure is as planned. (3) The Step 3 `insert…select` line exceeds printWidth, so prettier hugs its argument: the statement ships as ``…read, created_at from inbox_items`.execute(`↵`db`↵`)` — the SQL text itself is byte-identical to the planned block. Block sync = shipped form.

---

## Task 3: AuditRepo `tail` + `watermark` — the event spine reads (D-aa)

**Files:**

- Modify: `src/application/ports.ts:46-49`
- Modify: `src/infra/sqlite/audit-repo.ts`
- Test: `src/infra/sqlite/audit-repo.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/infra/sqlite/audit-repo.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { makeDb } from '#root/infra/sqlite/db'
import { migrateToLatest } from '#root/infra/sqlite/migrations'
import { SqliteAuditRepo } from '#root/infra/sqlite/audit-repo'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const entry = (n: number) => ({
  actor_id: 'a_x',
  token_id: null,
  action: `action_${n}`,
  entity_type: 'task',
  entity_id: 't_1',
  after: { n },
  reason: `reason ${n}`,
  created_at: '2026-01-01T00:00:00.000Z',
})

describe('audit spine reads (D-aa)', () => {
  it('tail returns rows after the cursor, ASCENDING; watermark is max(id)', async () => {
    const db = makeDb(':memory:')
    await migrateToLatest(db)
    const audit = new SqliteAuditRepo(db)
    expect(await audit.tail(0, 10)).toEqual([])
    expect(await audit.watermark()).toBe(0)
    for (const n of [1, 2, 3]) await audit.append(entry(n))
    const rows = await audit.tail(1, 10)
    expect(rows.map((r) => r.id)).toEqual([2, 3]) // ASCENDING — the cursor advances forward
    expect(await audit.tail(3, 10)).toEqual([]) // caught up ⇒ empty
    expect(await audit.tail(1, 1)).toHaveLength(1) // limit respected, oldest-first slice
    expect(await audit.watermark()).toBe(3)
    await db.destroy()
  })

  it('tail excludes payloads by design of the ROUTE, not the repo: repo carries before/after', async () => {
    const db = makeDb(':memory:')
    await migrateToLatest(db)
    const audit = new SqliteAuditRepo(db)
    await audit.append(entry(1))
    const [row] = await audit.tail(0, 10)
    expect(row?.after).toEqual({ n: 1 }) // strip lives in routes/events.ts (D-aa)
    await db.destroy()
  })

  it('cursor survives reopen on a file db (restart-monotonicity, spec §6.8)', async () => {
    // the claim of §6.8 is restart survival — an :memory: db cannot show it.
    // File db in a temp dir (os.tmpdir per binding), reopen, tail past the old cursor.
    const dir = mkdtempSync(join(tmpdir(), 'ns-audit-reopen-'))
    const path = join(dir, 'restart.db')
    const db1 = makeDb(path)
    await migrateToLatest(db1)
    const audit1 = new SqliteAuditRepo(db1)
    for (const n of [1, 2]) await audit1.append(entry(n))
    const last = await audit1.watermark()
    await db1.destroy()
    const db2 = makeDb(path)
    const audit2 = new SqliteAuditRepo(db2)
    await expect(audit2.tail(last, 10)).resolves.toEqual([]) // nothing lost
    await audit2.append(entry(3))
    expect((await audit2.tail(last, 10)).map((r) => r.action)).toEqual(['action_3']) // continues forward
    await db2.destroy()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/infra/sqlite/audit-repo.test.ts`
Expected: FAIL — `tail`/`watermark` do not exist (TS compile error counts as RED here).

- [ ] **Step 3: Extend the port**

`src/application/ports.ts:46-49` — replace the `AuditRepo` interface:

```ts
export interface AuditRepo {
  append(entry: AuditEntryDraft): Promise<void>
  search(q: { entity_type?: string; entity_id?: string; limit: number }): Promise<AuditRow[]>
  /** Event-feed read (D-aa): rows with id > after, ASCENDING by id — the cursor advances forward. */
  tail(after: number, limit: number): Promise<AuditRow[]>
  /** Highest committed audit id (0 on empty) — the watermark a webhook checkpoint anchors to (D-bb). */
  watermark(): Promise<number>
}
```

- [ ] **Step 4: Implement**

`src/infra/sqlite/audit-repo.ts` — replace the whole file:

```ts
import { sql, type Kysely } from 'kysely'
import type { AuditEntryDraft, AuditRepo, AuditRow } from '#root/application/ports'
import type { AuditLogTable, DB } from '#root/infra/sqlite/schema'

type Row = Omit<AuditLogTable, 'id'> & { id: number }

const parseJson = (raw: string | null): unknown => (raw === null ? null : JSON.parse(raw))

// one mapping, shared by search and tail — no drift between the two read paths
const toRow = (r: Row): AuditRow => ({
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
})

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
    return rows.map(toRow)
  }

  async tail(after: number, limit: number): Promise<AuditRow[]> {
    // D-aa: ASCENDING — the event cursor moves forward; `search`'s desc is the
    // activity-tab view and stays untouched (two orders, two intents, one table)
    const rows = await this.db
      .selectFrom('audit_log')
      .selectAll()
      .where('id', '>', after)
      .orderBy('id', 'asc')
      .limit(limit)
      .execute()
    return rows.map(toRow)
  }

  async watermark(): Promise<number> {
    const r = await sql<{ m: number | null }>`select max(id) as m from audit_log`.execute(this.db)
    return r.rows[0]?.m ?? 0
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm test src/infra/sqlite/audit-repo.test.ts && pnpm test && pnpm lint && pnpm typecheck`
Expected: green (search's mapping refactor is behavior-identical — the existing audit pins prove it).

- [ ] **Step 6: Commit**

```bash
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -am "feat(audit): tail cursor and watermark reads on the event spine"
```

> **Amendment (Task 3, test file already existed — appended, not created):** Three byte-sync notes on Step 1. (1) "Create `src/infra/sqlite/audit-repo.test.ts`" is stale: the file has existed since `7965522` (extended by `4b2f731`) and carries four `SqliteAuditRepo` search tests — precisely the pins that discharge this task's "search stays behavior-identical" obligation. Writing the block wholesale would have deleted that proof, so the block landed as an **appended** second `describe('audit spine reads (D-aa)')`; the existing 4 tests are untouched and stayed green at every step. (2) The block's module-level `entry(n)` collides with the file's existing module-level `entry(entityId, action = 'task_created')`; the new helper ships as `spineEntry(n)` — body byte-identical, three call sites renamed. (3) Import merge: the block's `describe/expect/it` and `SqliteAuditRepo` imports deduplicate against the file's existing ones, its `makeDb`/`migrateToLatest`/`mkdtempSync`/`tmpdir`/`join` imports were added, and the file's existing `freshDb` import is retained for the preserved tests. Honest RED: vitest transpiles without typechecking, so the failure arrived as `TypeError: audit.tail is not a function` / `TypeError: audit1.watermark is not a function` (3 failed | 4 passed) alongside the `tsc` `Property 'tail' does not exist on type 'SqliteAuditRepo'` errors Step 2 anticipates — no fake RED claimed. The Step 3 `AuditRepo` block and the whole Step 4 `audit-repo.ts` are byte-identical to shipped (byte-diffed). Block sync = shipped form.

---

## Task 4: `webhooks` table — DDL + Kysely schema + pins

**Files:**

- Modify: `src/infra/sqlite/migrations.ts` (append key after `'2026-09-12_inbox_claim_conflict'`)
- Modify: `src/infra/sqlite/schema.ts` (new table interface + `DB` entry)
- Modify: `src/infra/sqlite/migrations.test.ts` (TABLES list + constraint pins)

- [ ] **Step 1: Write the failing test**

`migrations.test.ts`: add `'webhooks'` to `TABLES` (:6-21). Append a pin test after the discussion-constraints test:

```ts
it('pins webhook DDL: unique url, integer checkpoint fields (D-bb)', async () => {
  const db = makeDb(':memory:')
  await migrateToLatest(db)
  await seedActorAndTask(db) // a_x (human) + t_x
  await sql`insert into actors (id, kind, handle, display_name, description, created_at)
                values ('a_ag2','agent','ag2','Ag2','','2026-01-01')`.execute(db)
  await sql`insert into webhooks (id, actor_id, url, secret, created_by, created_at,
                    delivered_cursor, attempts, next_attempt_at)
                values ('wh_1','a_ag2','http://x/cb','s3cr3t','a_x','2026-01-01',0,0,0)`.execute(db)
  await expect(
    sql`insert into webhooks (id, actor_id, url, secret, created_by, created_at,
                    delivered_cursor, attempts, next_attempt_at)
                values ('wh_2','a_ag2','http://x/cb','other','a_x','2026-01-01',0,0,0)`.execute(db)
  ).rejects.toThrow(/UNIQUE/i) // one runner, one wake path (D-bb)
  await expect(
    sql`insert into webhooks (id, actor_id, url, secret, created_by, created_at,
                    delivered_cursor, attempts, next_attempt_at)
                values ('wh_3','a_missing','http://x/y','s','a_x','2026-01-01',0,0,0)`.execute(db)
  ).rejects.toThrow(/FOREIGN KEY|foreign key/i)
  await db.destroy()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/infra/sqlite/migrations.test.ts`
Expected: FAIL — no table `webhooks`.

- [ ] **Step 3: Append the migration**

In `migrations.ts`, after the inbox_claim_conflict entry:

```ts
  '2026-09-12_webhooks': {
    up: async (db: Kysely<DB>) => {
      // D-bb/D-ff: one row per registered callback, its delivery checkpoint riding
      // with it (a separate ledger table is the second source D-aa rejects). secret
      // is PLAINTEXT on purpose — an HMAC signing key the loop must re-read; unlike
      // bearer tokens it cannot be stored hashed (D-ff states the exception). url is
      // UNIQUE: a runner gets exactly one wake path, and a re-register is an upsert
      // decision this board refuses to make silently.
      await sql`create table webhooks (
        id text primary key,
        actor_id text not null references actors(id),
        url text not null unique,
        secret text not null,
        created_by text not null references actors(id),
        created_at text not null,
        delivered_cursor integer not null default 0,
        attempts integer not null default 0,
        next_attempt_at integer not null default 0
      )`.execute(db)
    },
  },
```

(`next_attempt_at` is epoch-ms — the T14 wall-clock side, never a Clock-port timestamp. This is a storage fact of the retry mechanic, commented at its use site in Task 11.)

- [ ] **Step 4: Kysely schema**

`src/infra/sqlite/schema.ts` — append after `LinksTable` and add the `DB` entry:

```ts
export interface WebhooksTable {
  id: string
  actor_id: string
  url: string
  secret: string
  created_by: string
  created_at: string
  delivered_cursor: number
  attempts: number
  next_attempt_at: number
}
```

In `export interface DB { … }` (:88-103) add: `webhooks: WebhooksTable`.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm test src/infra/sqlite/migrations.test.ts && pnpm test && pnpm lint && pnpm typecheck`
Expected: green.

- [ ] **Step 6: Commit**

```bash
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -am "feat(db): webhooks table with per-row delivery checkpoint"
```

> **Amendment (Task 4, prettier hug on the checkpoint inserts):** Three byte-sync notes. (1) The wh_1 and wh_2 insert statements exceed printWidth 100 (the 8-char `'s3cr3t'` / 7-char `'other'` secrets push them over), so prettier hugs their arguments: both ship as ``…'2026-01-01',0,0,0)`.execute(`↵`db`↵`)``; the wh_3 statement fits and ships as planned. The SQL text inside every template literal is byte-identical to the Step 1 block. (2) Embedding offset only: the Step 1 block lands at the file's `describe`-nesting indent (+2 base, same treatment as Task 2's block); statement and template contents unchanged. (3) Honest RED: both pins were genuine — `creates all tables` failed on the missing `webhooks` entry and the new pin failed with `SqliteError: no such table: webhooks` (2 failed | 7 passed) before Step 3. The Step 3 `migrations.ts` block and the Step 4 `schema.ts` block are byte-identical to shipped (byte-diffed). Block sync = shipped form.

---

## Task 5: `WebhookRepo` port + implementation (D-ff secret discipline)

**Files:**

- Modify: `src/application/ports.ts` (after the links section)
- Modify: `src/application/ports.ts` (`Repos` seam)
- Modify: `src/infra/sqlite/uow.ts` (`repos(tx)` factory)
- Create: `src/infra/sqlite/webhook-repo.ts` + test

- [ ] **Step 1: Write the failing test**

Create `src/infra/sqlite/webhook-repo.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { makeDb } from '#root/infra/sqlite/db'
import { migrateToLatest } from '#root/infra/sqlite/migrations'
import { SqliteWebhookRepo } from '#root/infra/sqlite/webhook-repo'

const setup = async () => {
  const db = makeDb(':memory:')
  await migrateToLatest(db)
  await sql`insert into actors (id, kind, handle, display_name, description, created_at)
              values ('a_h','human','h','H','','2026-01-01'),
                     ('a_g','agent','g','G','','2026-01-01')`.execute(db)
  return db
}
const draft = (id = 'wh_1') => ({
  id,
  actor_id: 'a_g',
  url: `http://x/${id}`,
  secret: 'sekret',
  created_by: 'a_h',
  created_at: '2026-01-01',
  delivered_cursor: 7,
})

describe('SqliteWebhookRepo (D-ff)', () => {
  it('read paths never carry the secret; listDue is the ONLY secret reader (D-ff)', async () => {
    const db = await setup()
    const repo = new SqliteWebhookRepo(db)
    await repo.add(draft())
    const found = await repo.find('wh_1')
    expect(found).toEqual({
      id: 'wh_1',
      actor_id: 'a_g',
      url: 'http://x/wh_1',
      created_by: 'a_h',
      created_at: '2026-01-01',
      delivered_cursor: 7,
    })
    expect(JSON.stringify(found)).not.toContain('sekret') // exposure surface zero at the repo boundary
    expect(await repo.list()).toEqual([found])
    const due = await repo.listDue(0) // next_attempt_at 0 <= 0 ⇒ due
    expect(due).toEqual([
      { id: 'wh_1', url: 'http://x/wh_1', secret: 'sekret', delivered_cursor: 7, attempts: 0 },
    ])
    await db.destroy()
  })

  it('listDue windows on next_attempt_at; advance resets attempts; scheduleRetry parks', async () => {
    const db = await setup()
    const repo = new SqliteWebhookRepo(db)
    await repo.add(draft())
    expect(await repo.listDue(1000)).toHaveLength(1)
    await repo.scheduleRetry('wh_1', 3, 5000)
    expect(await repo.listDue(4999)).toEqual([]) // parked until 5000
    expect(await repo.listDue(5000)).toHaveLength(1)
    await repo.advance('wh_1', 42)
    const r = await repo.find('wh_1')
    expect(r?.delivered_cursor).toBe(42)
    const due = await repo.listDue(5000)
    expect(due[0]?.attempts).toBe(0) // advance resets the backoff counter
    await db.destroy()
  })

  it('setSecret swaps the key; remove deletes; list is oldest-first', async () => {
    const db = await setup()
    const repo = new SqliteWebhookRepo(db)
    await repo.add(draft('wh_b'))
    await repo.add(draft('wh_a'))
    await repo.setSecret('wh_a', 'rotated')
    expect((await repo.listDue(0)).find((w) => w.id === 'wh_a')?.secret).toBe('rotated')
    await repo.remove('wh_a')
    expect((await repo.list()).map((w) => w.id)).toEqual(['wh_b'])
    expect(await repo.find('wh_a')).toBeNull()
    await db.destroy()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/infra/sqlite/webhook-repo.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Port declarations**

`src/application/ports.ts` — after the `LinkRepo` section (before the FileStore section):

```ts
// ---- webhooks (spec §6.8/§9; D-bb/D-ff) — admin-registered agent wake callbacks

export interface WebhookRecord {
  id: string
  actor_id: string
  url: string
  created_by: string
  created_at: string
  delivered_cursor: number
}

export interface NewWebhookDraft {
  id: string
  actor_id: string
  url: string
  secret: string
  created_by: string
  created_at: string
  delivered_cursor: number
}

/** The delivery loop's private read shape — the ONLY type that carries the secret (D-ff). */
export interface DueWebhook {
  id: string
  url: string
  secret: string
  delivered_cursor: number
  attempts: number
}

export interface WebhookRepo {
  add(draft: NewWebhookDraft): Promise<void>
  /** Secret never present (D-ff): the column is excluded by the SELECT, not filtered after. */
  find(id: string): Promise<WebhookRecord | null>
  list(): Promise<WebhookRecord[]>
  remove(id: string): Promise<void>
  setSecret(id: string, secret: string): Promise<void>
  /** Due = next_attempt_at <= nowMs (T14 wall-clock domain — caller passes Date.now()). */
  listDue(nowMs: number): Promise<DueWebhook[]>
  /** Advance the checkpoint AND reset the backoff counter (successful ACK ⇒ attempts 0). */
  advance(id: string, deliveredCursor: number): Promise<void>
  scheduleRetry(id: string, attempts: number, nextAttemptAt: number): Promise<void>
  /** Rotation re-anchor (D-bb): checkpoint to cursor, backoff cleared, un-parked — one write. */
  reanchor(id: string, deliveredCursor: number): Promise<void>
}
```

`Repos` seam (:353-363) gains: `webhooks: WebhookRepo`.

- [ ] **Step 4: UoW factory + implementation**

`src/infra/sqlite/uow.ts` — import `SqliteWebhookRepo` and add `webhooks: new SqliteWebhookRepo(tx),` to the `repos(tx)` factory (webhook admin writes co-own the audit transaction; the loop's reads are single-statement root uses of the same class).

Create `src/infra/sqlite/webhook-repo.ts`:

```ts
import type { Kysely } from 'kysely'
import type {
  DueWebhook,
  NewWebhookDraft,
  WebhookRecord,
  WebhookRepo,
} from '#root/application/ports'
import type { DB } from '#root/infra/sqlite/schema'

const PUBLIC_COLUMNS = [
  'id',
  'actor_id',
  'url',
  'created_by',
  'created_at',
  'delivered_cursor',
] as const

// D-ff: find/list SELECT every column EXCEPT secret — no response can project what the
// record type never carries. The secret is visible only in listDue, the delivery loop's
// private read path (and the create/rotate use-case returns, which mint it themselves).
export class SqliteWebhookRepo implements WebhookRepo {
  constructor(private readonly db: Kysely<DB>) {}

  async add(draft: NewWebhookDraft): Promise<void> {
    await this.db.insertInto('webhooks').values(draft).execute()
  }

  async find(id: string): Promise<WebhookRecord | null> {
    const r = await this.db
      .selectFrom('webhooks')
      .select([...PUBLIC_COLUMNS])
      .where('id', '=', id)
      .executeTakeFirst()
    return r ?? null
  }

  async list(): Promise<WebhookRecord[]> {
    // recency order by (created_at, id): ids are RandomIdGen-random (ids.ts), NOT
    // monotonic — the inbox-repo lesson applies verbatim here
    return this.db
      .selectFrom('webhooks')
      .select([...PUBLIC_COLUMNS])
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute()
  }

  async remove(id: string): Promise<void> {
    await this.db.deleteFrom('webhooks').where('id', '=', id).execute()
  }

  async setSecret(id: string, secret: string): Promise<void> {
    await this.db.updateTable('webhooks').set({ secret }).where('id', '=', id).execute()
  }

  async listDue(nowMs: number): Promise<DueWebhook[]> {
    return this.db
      .selectFrom('webhooks')
      .select(['id', 'url', 'secret', 'delivered_cursor', 'attempts'])
      .where('next_attempt_at', '<=', nowMs)
      .orderBy('created_at', 'asc')
      .execute()
  }

  async advance(id: string, deliveredCursor: number): Promise<void> {
    await this.db
      .updateTable('webhooks')
      .set({ delivered_cursor: deliveredCursor, attempts: 0 })
      .where('id', '=', id)
      .execute()
  }

  async scheduleRetry(id: string, attempts: number, nextAttemptAt: number): Promise<void> {
    await this.db
      .updateTable('webhooks')
      .set({ attempts, next_attempt_at: nextAttemptAt })
      .where('id', '=', id)
      .execute()
  }

  async reanchor(id: string, deliveredCursor: number): Promise<void> {
    // rotation IS re-registration (D-bb): checkpoint, attempts AND park reset together
    await this.db
      .updateTable('webhooks')
      .set({ delivered_cursor: deliveredCursor, attempts: 0, next_attempt_at: 0 })
      .where('id', '=', id)
      .execute()
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm test src/infra/sqlite/webhook-repo.test.ts && pnpm test && pnpm lint && pnpm typecheck`
Expected: green. (Deps wiring of `webhooksRoot` comes in Task 9 with the routes — nothing imports this repo yet except its test.)

- [ ] **Step 6: Commit**

```bash
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -am "feat(infra): webhook repo — secret never leaves the read path"
```

> **Amendment (Task 5, add() insert fix + reanchor pin):** Three byte-sync notes. (1) The Step 4 `add()` block does not typecheck as written: schema.ts keeps plain `number` for `delivered_cursor`/`attempts`/`next_attempt_at` (inherited Task 4 ruling — schema.ts untouched), so Kysely's `InsertObject` requires the two omitted keys and `.values(draft)` is rejected. Shipped as `this.db.insertInto('webhooks').values({ ...draft, attempts: 0, next_attempt_at: 0 }).execute()` — the repo's own precedent is `inbox-repo.ts:21` `.values({ ...draft, read: 0 })` — and at 103 chars prettier hugs it to the 4-line chain (`await this.db`↵`.insertInto('webhooks')`↵`.values({ ...draft, attempts: 0, next_attempt_at: 0 })`↵`.execute()`). The rest of `webhook-repo.ts` is byte-identical to the Step 4 block (diffed). (2) The Step 1 test block carries no pin for `reanchor`, yet the Step 3 port block — shipped verbatim, Tasks 7/8 consume the method — declares it; an untested method would lower global coverage below baseline (never-lower). The shipped file adds a fourth `it` before the closing `})` pinning the one-write semantics (checkpoint→99, attempts→0, and un-parked: due again at `nowMs` 0); everything else is byte-identical to the block — plan lines 583–657 land as file lines 1–75, the block's trailing `})` slips to line 89 with the new `it` on 77–88 (diffed). (3) The Step 3 ports block is byte-identical (diffed); the `Repos` seam gains `webhooks: WebhookRepo` after `links`, and `uow.ts` gains the import plus `webhooks: new SqliteWebhookRepo(tx),` in `repos(tx)`. Honest RED: the Step 2 failure is module-not-found — `tsc`: `Cannot find module '#root/infra/sqlite/webhook-repo'`; vitest: `Test Files 1 failed (1) / Tests no tests` with the caret under that import line — zero tests ran, no fake RED claimed. Block sync = shipped form.

---

## Task 6: Delivery-loop env knobs + signing-key generator (D-w pattern: one config task)

**Files:**

- Modify: `src/main/config.ts`
- Modify: `src/infra/token-hash.ts`
- Modify: config test (grep `loadConfig` under `src/main/*.test.ts` — extend the existing defaults/overrides test; create `src/main/config.test.ts` colocated if absent)

- [ ] **Step 1: Write the failing test (config)**

Append to the config test's defaults case (or create the file with the standard `loadConfig({})` shape):

```ts
it('defaults the webhook delivery knobs (D-bb)', () => {
  const c = loadConfig({})
  expect(c.webhookIntervalMs).toBe(1000)
  expect(c.webhookTimeoutMs).toBe(5000)
  expect(c.webhookMaxBackoffMs).toBe(300_000)
})

it('interval 0 disables the loop (the D-v honesty lever); bounds are enforced', () => {
  expect(loadConfig({ NS_WEBHOOK_INTERVAL_MS: '0' }).webhookIntervalMs).toBe(0)
  expect(() => loadConfig({ NS_WEBHOOK_TIMEOUT_MS: '1' })).toThrow(/invalid env/)
  expect(() => loadConfig({ NS_WEBHOOK_MAX_BACKOFF_MS: '5' })).toThrow(/invalid env/)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/main/config.test.ts` — Expected: FAIL (unknown properties).

- [ ] **Step 3: Implement config**

`src/main/config.ts` — `EnvSchema` gains (after `NS_RATE_LIMIT_PER_MIN`):

```ts
  NS_WEBHOOK_INTERVAL_MS: z.coerce.number().int().min(0).default(1_000),
  NS_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),
  NS_WEBHOOK_MAX_BACKOFF_MS: z.coerce.number().int().min(1_000).default(300_000),
```

`Config` gains: `webhookIntervalMs: number`, `webhookTimeoutMs: number`, `webhookMaxBackoffMs: number`. `loadConfig`'s return maps them (same order). Doc-comment on interval: `/** delivery-loop poll interval; 0 = loop disabled (test default; D-v lineage) */`.

- [ ] **Step 4: The signing-key generator**

`src/infra/token-hash.ts` — append:

```ts
/**
 * Webhook HMAC signing key (D-ff). Same 256-bit strength as agent tokens, but
 * stored PLAINTEXT by design: it is a signing key the delivery loop must re-read,
 * not a lookup secret that could be hashed. generate === raw-token form on purpose.
 */
export const generateWebhookSecret = (): string => randomBytes(32).toString('base64url')
```

- [ ] **Step 5: Run + gate + commit**

Run: `pnpm test && pnpm lint && pnpm typecheck` — green.

```bash
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -am "feat(config): webhook interval/timeout/backoff knobs + key gen"
```

> **Amendment (Task 6, generator pin + defaults-case update):** Three byte-sync notes. (1) The Step 1 blocks land embedded: the two `it`s sit inside the file's `describe('loadConfig')` at +2 base indent (same treatment as Tasks 2/4) — content byte-identical (diffed). The Step 3 `EnvSchema` lines, the `Config` fields + interval doc-comment, the `loadConfig` return mapping, and the whole Step 4 `token-hash.ts` append are byte-identical to shipped (diffed). (2) The file-list's "extend the existing defaults/overrides test" binds: the pre-existing `'applies defaults'` is an exact `toEqual`, so it gains `webhookIntervalMs: 1000`, `webhookTimeoutMs: 5000`, `webhookMaxBackoffMs: 300_000` — without it Step 3 would leave that test RED. (3) Step 1 carries no pin for `generateWebhookSecret`, yet Step 4 exports it; an untested exported function would drop global functions coverage below the never-lower baseline (Task 5 amendment (2) reasoning, verbatim). Shipped `token-hash.test.ts` adds a third `it` pinning the raw-token form (43-char base64url) and 100-sample uniqueness. Honest RED: config — `Tests 3 failed | 6 passed (9)` with `AssertionError: expected { port: 3123, …(5) } to deeply equal { port: 3123, …(8) }`, `expected undefined to be 1000`, `expected undefined to be +0` (each test's first assertion failed, so the two `toThrow` pins never executed pre-Step 3); token-hash — `TypeError: generateWebhookSecret is not a function` (vitest's SSR transform does not throw on a missing named export, so the absence surfaces as a call-time TypeError) — no fake RED claimed. Block sync = shipped form.

---

## Task 7: `CreateWebhook` use-case (D-bb watermark seeding)

**Files:**

- Create: `src/application/usecases/manage-webhooks.ts` (CreateWebhook now; siblings in Task 8)
- Test: `src/application/usecases/manage-webhooks.test.ts` (create; `fixedClock` one-liner per create-task.test.ts precedent)

- [ ] **Step 1: Write the failing test**

Create `src/application/usecases/manage-webhooks.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Clock } from '#root/application/ports'
import { makeDb } from '#root/infra/sqlite/db'
import { migrateToLatest } from '#root/infra/sqlite/migrations'
import { SqliteUnitOfWork } from '#root/infra/sqlite/uow'
import { RandomIdGen } from '#root/infra/ids'
import { CreateWebhook } from '#root/application/usecases/manage-webhooks'

const fixedClock = (): Clock => ({ now: () => new Date('2026-05-05T05:05:05.000Z') })

const setup = async () => {
  const db = makeDb(':memory:')
  await migrateToLatest(db)
  // a_h human actor, audit watermark baseline: one audited action (done via direct
  // audit append — the use-case under test reads repos.audit.watermark inside its tx)
  await db
    .insertInto('actors')
    .values([
      {
        id: 'a_h',
        kind: 'human',
        handle: 'h',
        display_name: 'H',
        description: '',
        created_at: '2026-01-01',
      },
      {
        id: 'a_g',
        kind: 'agent',
        handle: 'g',
        display_name: 'G',
        description: '',
        created_at: '2026-01-01',
      },
      {
        id: 'a_h2',
        kind: 'human',
        handle: 'h2',
        display_name: 'H2',
        description: '',
        created_at: '2026-01-01',
      },
    ])
    .execute()
  const uow = new SqliteUnitOfWork(db)
  await uow.withTransaction(async (repos) =>
    repos.audit.append({
      actor_id: 'a_h',
      token_id: null,
      action: 'warmup',
      entity_type: 'task',
      entity_id: 't_w',
      created_at: '2026-01-01',
    })
  )
  return { db, uow }
}
const actor = { id: 'a_h', kind: 'human' as const, handle: 'h', display_name: 'H' }

describe('CreateWebhook (D-bb/D-ff)', () => {
  it('registers an agent callback: secret minted once, checkpoint at the watermark, audit pinned', async () => {
    const { db, uow } = await setup()
    const uc = new CreateWebhook(uow, fixedClock(), new RandomIdGen())
    const { webhook, secret } = await uc.run({
      actor,
      tokenId: null,
      agent_id: 'a_g',
      url: 'http://runner.example/cb',
    })
    expect(webhook.id).toMatch(/^wh_[a-z0-9]{16}$/) // D-z family
    expect(webhook.delivered_cursor).toBe(2) // warmup(1) + own webhook_created(2): the anchor is self-inclusive — a runner is never woken for its own registration (D-bb)
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/) // 32 bytes base64url
    const rows = await db.selectFrom('webhooks').selectAll().execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.secret).toBe(secret) // plaintext at rest, by D-ff — pin the choice
    const audit = await db
      .selectFrom('audit_log')
      .select(['action', 'reason', 'after_json'])
      .execute()
    expect(audit.map((a) => [a.action, a.reason])).toEqual([['webhook_created', 'webhook created']]) // grep-pinned forward
    expect(audit[0]?.after_json).not.toContain(secret) // never audited (D-ff)
    await db.destroy()
  })

  it('rejects: unknown actor 404-ish, human target, bad/short/non-http url, duplicate url', async () => {
    const { db, uow } = await setup()
    const uc = new CreateWebhook(uow, fixedClock(), new RandomIdGen())
    const mk = (o: { agent_id: string; url: string }) =>
      uc.run({ actor, tokenId: null, ...o }).catch((e) => e)
    expect((await mk({ agent_id: 'a_no', url: 'http://x/cb' })).code).toBe('not_found')
    expect((await mk({ agent_id: 'a_h2', url: 'http://x/cb2' })).code).toBe('invalid_request')
    expect((await mk({ agent_id: 'a_g', url: 'not a url' })).code).toBe('invalid_request')
    expect((await mk({ agent_id: 'a_g', url: 'ftp://x/cb' })).code).toBe('invalid_request')
    await uc.run({ actor, tokenId: null, agent_id: 'a_g', url: 'http://x/cb3' })
    expect((await mk({ agent_id: 'a_g', url: 'http://x/cb3' })).code).toBe('invalid_request')
    await db.destroy()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/application/usecases/manage-webhooks.test.ts` — Expected: FAIL (module absent).

- [ ] **Step 3: Implement**

Create `src/application/usecases/manage-webhooks.ts`:

```ts
import { DomainError } from '#root/domain/errors'
// sanctioned pure-util import (manage-actors precedent): node:crypto-only, no infra coupling
import { generateWebhookSecret } from '#root/infra/token-hash'
import type { ActorContext, Clock, IdGen, UnitOfWork, WebhookRecord } from '#root/application/ports'

export interface CreateWebhookInput extends ActorContext {
  agent_id: string
  url: string
}

export interface CreatedWebhook {
  webhook: WebhookRecord
  /** shown exactly once (D-ff); the repo read paths never carry it again */
  secret: string
}

const parseHttpUrl = (url: string): URL => {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new DomainError('invalid_request', `url '${url}' is not a parseable URL`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new DomainError('invalid_request', 'webhook url must be http(s)')
  }
  return u
}

export class CreateWebhook {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGen
  ) {}

  async run(input: CreateWebhookInput): Promise<CreatedWebhook> {
    parseHttpUrl(input.url) // edge parse; the stored string is exactly what validated
    const now = this.clock.now().toISOString()
    const secret = generateWebhookSecret()
    return this.uow.withTransaction(async (repos) => {
      const agent = await repos.actors.findById(input.agent_id)
      if (!agent) throw new DomainError('not_found', `actor ${input.agent_id} not found`)
      if (agent.kind !== 'agent') {
        // spec §6.8 registers PER-AGENT callbacks; humans are woken by their own UI polling
        throw new DomainError('invalid_request', `actor ${input.agent_id} is not an agent`)
      }
      const id = this.ids.newId('wh')
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'webhook_created',
        entity_type: 'webhook',
        entity_id: id,
        after: { agent_id: input.agent_id, url: input.url },
        reason: 'webhook created', // grep-pinned forward (binding: never reword)
        created_at: now,
      })
      // D-bb: the checkpoint anchors at the watermark INCLUDING the own webhook_created
      // row just appended in this same transaction — a registering runner is woken for
      // what happens NEXT, never for its own registration. Same tx ⇒ no window race.
      const watermark = await repos.audit.watermark()
      try {
        await repos.webhooks.add({
          id,
          actor_id: input.agent_id,
          url: input.url,
          secret,
          created_by: input.actor.id,
          created_at: now,
          delivered_cursor: watermark,
        })
      } catch {
        // honest backstop (D-y lineage): the UNIQUE(url) race loser surfaces here as a
        // domain 400 rather than a bare SqliteError→500; the pre-check on agent + the
        // UNIQUE are the gates, this catch is the loser path. The tx rolls back clean
        // (the audit row included).
        throw new DomainError('invalid_request', `a webhook for '${input.url}' already exists`)
      }
      // plan-verbatim cast (manage-actors precedent): row inserted in THIS tx — the
      // null arm of find is unreachable here
      const webhook = (await repos.webhooks.find(id)) as WebhookRecord
      return { webhook, secret }
    })
  }
}
```

- [ ] **Step 4: Run + gate + commit**

Run: `pnpm test src/application/usecases/manage-webhooks.test.ts && pnpm test && pnpm lint && pnpm typecheck` — green.

```bash
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -am "feat(app): CreateWebhook with watermark-seeded checkpoint"
```

> **Amendment (Task 7, audit-spine pin was self-contradictory):** Two byte-sync notes. (1) The Step 1 block's audit assertion cannot pass its own `setup()`: `setup()` appends a `warmup` audit row (the very row `delivered_cursor === 2` counts), yet the block expects `audit.map(...)` to equal only `[['webhook_created', 'webhook created']]`. The verbatim block was run against the shipped implementation and came back RED for exactly this — `AssertionError: expected [ [ 'warmup', null ], …(1) ] to deeply equal [ [ 'webhook_created', …(1) ] ]` — so this is a plan bug, not a repair of working code. Shipped pins the WHOLE spine (`[['warmup', null], ['webhook_created', 'webhook created']]`, prettier hugs the 2-entry array), which is the stronger pin: it proves the use-case adds exactly ONE audit row and that its reason is the grep-pinned `webhook created`; the secret-never-audited pin moves to `audit[1]` (`audit[0]` is the warmup row, whose `after_json` is `null` — the verbatim `audit[0]` assertion would have been a vacuous pass against `null`). (2) Nothing else diverged: the Step 3 `manage-webhooks.ts` is byte-identical to the block (diffed against the plan's own lines — watermark-after-append ordering, the self-inclusive-anchor comment, the `webhooks.add` backstop catch, the `find(id) as WebhookRecord` cast, and every machine string: `webhook created` / `actor ${input.agent_id} not found` / `actor ${input.agent_id} is not an agent` / `url '${url}' is not a parseable URL` / `webhook url must be http(s)` / `a webhook for '${input.url}' already exists`), and no reflow was needed even at the boundary — the block's `import type { ActorContext, Clock, IdGen, UnitOfWork, WebhookRecord } from '#root/application/ports'` is exactly 100 columns, so prettier leaves it hugged-free. Honest RED: Step 2 failed as planned with `Error: Cannot find module '#root/application/usecases/manage-webhooks'` (`Test Files 1 failed (1) / Tests no tests`); the note-(1) divergence surfaced only after Step 3 and was proven against the shipped implementation before the expectation was rewritten — no fake RED claimed. Block sync = shipped form.

---

## Task 8: `DeleteWebhook` + `RotateWebhookSecret` (D-bb rotation re-anchor)

**Files:**

- Modify: `src/application/usecases/manage-webhooks.ts`
- Modify: `src/application/usecases/manage-webhooks.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `manage-webhooks.test.ts` (reuse `setup`/`actor`; import the new classes):

```ts
describe('DeleteWebhook / RotateWebhookSecret (D-bb)', () => {
  it('delete removes the row and audits; ghost 404s (never 403, D-r doctrine)', async () => {
    const { db, uow } = await setup()
    const create = new CreateWebhook(uow, fixedClock(), new RandomIdGen())
    const { webhook } = await create.run({
      actor,
      tokenId: null,
      agent_id: 'a_g',
      url: 'http://x/del',
    })
    const del = new DeleteWebhook(uow, fixedClock())
    await expect(del.run({ actor, tokenId: null, webhook_id: 'wh_missing' })).rejects.toMatchObject(
      { code: 'not_found' }
    )
    await del.run({ actor, tokenId: null, webhook_id: webhook.id })
    expect(await db.selectFrom('webhooks').selectAll().execute()).toHaveLength(0)
    const audit = await db.selectFrom('audit_log').select(['action', 'reason']).execute()
    expect(audit.map((a) => [a.action, a.reason])).toContainEqual([
      'webhook_deleted',
      'webhook deleted',
    ]) // pinned forward
    await db.destroy()
  })

  it('rotate mints a new secret, RE-ANCHORS the checkpoint and clears backoff, audits', async () => {
    const { db, uow } = await setup()
    const create = new CreateWebhook(uow, fixedClock(), new RandomIdGen())
    const first = await create.run({ actor, tokenId: null, agent_id: 'a_g', url: 'http://x/rot' })
    await uow.withTransaction(async (repos) =>
      repos.audit.append({
        actor_id: 'a_h',
        token_id: null,
        action: 'more',
        entity_type: 'task',
        entity_id: 't_w',
        created_at: '2026-01-02',
      })
    )
    await uow.withTransaction(async (repos) =>
      repos.webhooks.scheduleRetry(first.webhook.id, 4, 9_999_999)
    )
    const rotate = new RotateWebhookSecret(uow, fixedClock())
    const { webhook, secret } = await rotate.run({
      actor,
      tokenId: null,
      webhook_id: first.webhook.id,
    })
    expect(secret).not.toBe(first.secret)
    expect(webhook.delivered_cursor).toBe(4) // re-anchor is SELF-INCLUSIVE (D-bb, same rule as create): warmup(1)+created(2)+more(3)+own rotated(4)
    const repo = new SqliteWebhookRepo(db)
    const due = await repo.listDue(0) // parked until 9_999_999 before; re-anchor must clear it
    expect(due.map((w) => w.id)).toContain(webhook.id) // attempts/next_attempt reset by re-anchor
    const stored = await db.selectFrom('webhooks').select('secret').executeTakeFirst()
    expect(stored?.secret).toBe(secret)
    const audit = await db.selectFrom('audit_log').select(['action', 'reason']).execute()
    expect(audit.map((a) => [a.action, a.reason])).toContainEqual([
      'webhook_secret_rotated',
      'webhook secret rotated',
    ]) // pinned forward
    await expect(
      rotate.run({ actor, tokenId: null, webhook_id: 'wh_missing' })
    ).rejects.toMatchObject({ code: 'not_found' })
    await db.destroy()
  })
})
```

(Add `import { SqliteWebhookRepo } from '#root/infra/sqlite/webhook-repo'` and the two new class imports at top.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/application/usecases/manage-webhooks.test.ts` — Expected: FAIL (classes absent).

- [ ] **Step 3: Implement (append to `manage-webhooks.ts`)**

```ts
export interface DeleteWebhookInput extends ActorContext {
  webhook_id: string
}

export class DeleteWebhook {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock
  ) {}

  async run(input: DeleteWebhookInput): Promise<void> {
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      const webhook = await repos.webhooks.find(input.webhook_id)
      if (!webhook) throw new DomainError('not_found', `webhook ${input.webhook_id} not found`)
      await repos.webhooks.remove(input.webhook_id)
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'webhook_deleted',
        entity_type: 'webhook',
        entity_id: input.webhook_id,
        after: { url: webhook.url },
        reason: 'webhook deleted', // grep-pinned forward
        created_at: now,
      })
    })
  }
}

export interface RotateWebhookSecretInput extends ActorContext {
  webhook_id: string
}

export class RotateWebhookSecret {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock
  ) {}

  /** New secret shown exactly once (D-ff); rotation IS re-registration (D-bb): */
  async run(input: RotateWebhookSecretInput): Promise<CreatedWebhook> {
    const now = this.clock.now().toISOString()
    const secret = generateWebhookSecret()
    return this.uow.withTransaction(async (repos) => {
      const existing = await repos.webhooks.find(input.webhook_id)
      if (!existing) throw new DomainError('not_found', `webhook ${input.webhook_id} not found`)
      await repos.webhooks.setSecret(input.webhook_id, secret)
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'webhook_secret_rotated',
        entity_type: 'webhook',
        entity_id: input.webhook_id,
        after: { url: existing.url },
        reason: 'webhook secret rotated', // grep-pinned forward
        created_at: now,
      })
      // re-anchor AFTER the own rotation audit (D-bb, same self-inclusive rule as
      // create): checkpoint moves to the watermark, the backoff counter clears and
      // the park un-set — the old-key backlog is undeliverable by definition and
      // the rotating runner is never woken by its own rotation. ONE statement
      // (WebhookRepo.reanchor, shipped since Task 5).
      await repos.webhooks.reanchor(input.webhook_id, await repos.audit.watermark())
      const webhook = (await repos.webhooks.find(input.webhook_id)) as WebhookRecord
      return { webhook, secret }
    })
  }
}
```

- [ ] **Step 4: Run + gate + commit**

Run: `pnpm test && pnpm lint && pnpm typecheck` — green.

```bash
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -am "feat(app): webhook delete and rotate-secret (re-anchor per D-bb)"
```

> **Amendment (Task 8, audit-spine pin upgrade + absence forward-pin):** The Step 3 `manage-webhooks.ts` block is byte-identical to the shipped file (diffed the plan's own lines against the shipped addition — zero diff: the find→remove→audit and find→setSecret→audit→reanchor→find-as-`WebhookRecord` orderings, the self-inclusive re-anchor comment, the one-statement `reanchor(input.webhook_id, await repos.audit.watermark())`, and both new machine strings `webhook deleted` / `webhook secret rotated`). The Step 1 test block was run VERBATIM at Step 2 and produced the genuine RED the plan anticipated — `TypeError: DeleteWebhook is not a constructor` and `TypeError: RotateWebhookSecret is not a constructor` (`Tests 2 failed | 2 passed`); unlike Task 7's spine bug the block is NOT self-contradictory (its `toContainEqual` tolerates the setup's `warmup` row). Two shipped divergences, both in test. (1) Per the Task 7 full-spine doctrine ("pin the WHOLE spine, never assume a single-row spine") the two `toContainEqual` audit assertions ship as FULL-SPINE `toEqual` with `.orderBy('id')` — delete: `[['warmup', null], ['webhook_created', 'webhook created'], ['webhook_deleted', 'webhook deleted']]`; rotate: `[['warmup', null], ['webhook_created', 'webhook created'], ['more', null], ['webhook_secret_rotated', 'webhook secret rotated']]` — plus own-row exact `after_json` pins (`audit[2]` = `{"url":"http://x/del"}`, `audit[3]` = `{"url":"http://x/rot"}` — url only, never the secret, D-ff). `toContainEqual` would have admitted a stray extra audit row; the spine pins prove exactly-one-row added. The upgrade was written before Step 3 touched the implementation, so the only RED claimed is the anticipated absent-class RED; no separate RED is claimed for the tightened assertions — honest declaration, no fake RED. (2) A third test ships (the Task 7 reviewer's optional forward pin, accepted because it fits this describe naturally): a duplicate-url `CreateWebhook` rejection leaves NO audit row — the loser's `webhook_created` append rode in the rolled-back tx; spine stays `[['warmup', null], ['webhook_created', 'webhook created']]`. That pin passed first-run against shipped code — there is no RED phase to claim and none is claimed. Imports: the two new classes merge into the existing `manage-webhooks` import (the plan's parenthetical "add the two new class imports at top" done as one named import, prettier-shaped). Block sync = shipped form.

---

## Task 9: `/admin/webhooks` REST surface + contract (human-only, D-ff exposure pins)

**Files:**

- Create: `src/adapters/rest/routes/webhooks.ts` + test
- Modify: `src/main/deps.ts` (`webhooksRoot`, three use-cases)
- Modify: `src/adapters/rest/app.ts` (one registration)
- Modify: `src/testing/test-app.ts` (loop-off default comes fully in Task 12; here only if config forces it — it does not: interval defaults 1000 but no loop starts in tests because makeTestApp never calls start())
- Modify: `openapi/openapi.yaml` (paths + schemas + tag)

- [ ] **Step 1: Wire deps**

`deps.ts`: import `SqliteWebhookRepo`, `CreateWebhook`, `DeleteWebhook`, `RotateWebhookSecret`; `AppDeps` gains `webhooksRoot: SqliteWebhookRepo` and `useCases.createWebhook/deleteWebhook/rotateWebhookSecret`; constructor:

```ts
    webhooksRoot: new SqliteWebhookRepo(db),
    // ...in useCases:
    createWebhook: new CreateWebhook(uow, clock, ids),
    deleteWebhook: new DeleteWebhook(uow, clock),
    rotateWebhookSecret: new RotateWebhookSecret(uow, clock),
```

- [ ] **Step 2: Write the failing route test**

Create `src/adapters/rest/routes/webhooks.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { makeTestApp } from '#root/testing/test-app'

const bearer = (t: string) => ({ authorization: `Bearer ${t}` })

describe('POST/GET/DELETE /admin/webhooks + rotate (D-ff, requireHuman)', () => {
  it('agent callers are 403 on every webhook route (human-only, spec §6.8 admin)', async () => {
    const t = await makeTestApp()
    // register an agent actor + token through the admin surface first
    const agent = await t.app.inject({
      method: 'POST',
      url: '/admin/actors',
      headers: bearer(t.adminToken),
      payload: { kind: 'agent', handle: 'whd-agent', display_name: 'W' },
    })
    const tok = await t.app.inject({
      method: 'POST',
      url: `/admin/actors/${agent.json().id}/tokens`,
      headers: bearer(t.adminToken),
      payload: { label: 'w' },
    })
    const asAgent = bearer(tok.json().raw_token)
    // fastify validates the body BEFORE the preHandler — 403 (not 400) only proves the
    // human-guard, so every POST here carries a schema-VALID body
    for (const [method, url, payload] of [
      ['GET', '/admin/webhooks', undefined],
      ['POST', '/admin/webhooks', { agent_id: agent.json().id, url: 'http://x/403-probe' }],
      ['DELETE', '/admin/webhooks/wh_x', undefined],
      ['POST', '/admin/webhooks/wh_x/rotate-secret', undefined], // no body schema on this route
    ] as const) {
      const res = await t.app.inject({ method, url, headers: asAgent, payload })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
      expect(res.json().code).toBe('forbidden')
    }
    await t.close()
  })

  it('human lifecycle: create (secret once) → list (secret-free) → rotate → delete → 404', async () => {
    const t = await makeTestApp()
    const agent = await t.app.inject({
      method: 'POST',
      url: '/admin/actors',
      headers: bearer(t.adminToken),
      payload: { kind: 'agent', handle: 'life', display_name: 'L' },
    })
    const created = await t.app.inject({
      method: 'POST',
      url: '/admin/webhooks',
      headers: bearer(t.adminToken),
      payload: { agent_id: agent.json().id, url: 'http://runner.local/cb' },
    })
    expect(created.statusCode).toBe(201)
    const c = created.json()
    expect(c.id).toMatch(/^wh_/)
    expect(c.delivered_cursor).toBeGreaterThanOrEqual(1) // webhook_created audit rides BEFORE the seed? — assert >= 1 only; exact anchor value is the use-case's contract (Task 7 pins it)
    expect(c.secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const list = await t.app.inject({
      method: 'GET',
      url: '/admin/webhooks',
      headers: bearer(t.adminToken),
    })
    expect(list.json()).toHaveLength(1)
    expect(JSON.stringify(list.json())).not.toContain(c.secret) // D-ff exposure pin at the HTTP edge
    expect(list.json()[0].secret).toBeUndefined()
    const rotated = await t.app.inject({
      method: 'POST',
      url: `/admin/webhooks/${c.id}/rotate-secret`,
      headers: bearer(t.adminToken),
    })
    expect(rotated.statusCode).toBe(200)
    expect(rotated.json().secret).not.toBe(c.secret)
    const del = await t.app.inject({
      method: 'DELETE',
      url: `/admin/webhooks/${c.id}`,
      headers: bearer(t.adminToken),
    })
    expect(del.statusCode).toBe(204)
    expect(
      (
        await t.app.inject({
          method: 'DELETE',
          url: `/admin/webhooks/${c.id}`,
          headers: bearer(t.adminToken),
        })
      ).statusCode
    ).toBe(404)
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: `/admin/webhooks/wh_ghost/rotate-secret`,
          headers: bearer(t.adminToken),
        })
      ).json().code
    ).toBe('not_found')
    await t.close()
  })

  it('edge validation: human target and unknown actor; duplicate url 400; extra body keys STRIP per status quo (Task 7 parity, removeAdditional queued)', async () => {
    const t = await makeTestApp()
    const bad = await t.app.inject({
      method: 'POST',
      url: '/admin/webhooks',
      headers: bearer(t.adminToken),
      payload: { agent_id: 'a_nils', url: 'http://x/1' },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('invalid_request')
    const ghost = await t.app.inject({
      method: 'POST',
      url: '/admin/webhooks',
      headers: bearer(t.adminToken),
      payload: { agent_id: 'a_ghost', url: 'http://x/2' },
    })
    expect(ghost.statusCode).toBe(404)
    const mkAgent = async (handle: string) =>
      (
        await t.app.inject({
          method: 'POST',
          url: '/admin/actors',
          headers: bearer(t.adminToken),
          payload: { kind: 'agent', handle, display_name: handle },
        })
      ).json()
    const ag = await mkAgent('dup1')
    const a = await t.app.inject({
      method: 'POST',
      url: '/admin/webhooks',
      headers: bearer(t.adminToken),
      payload: { agent_id: ag.id, url: 'http://x/dup' },
    })
    expect(a.statusCode).toBe(201)
    const dup = await t.app.inject({
      method: 'POST',
      url: '/admin/webhooks',
      headers: bearer(t.adminToken),
      payload: { agent_id: ag.id, url: 'http://x/dup' },
    })
    expect(dup.statusCode).toBe(400)
    // removeAdditional status quo: unknown key silently stripped, NOT 400 (queued human decision)
    const parity = await t.app.inject({
      method: 'POST',
      url: '/admin/webhooks',
      headers: bearer(t.adminToken),
      payload: { agent_id: ag.id, url: 'http://x/parity', smuggled_actor: 'a_nils' },
    })
    expect(parity.statusCode).toBe(201)
    expect(parity.json().created_by).toBe('a_nils') // the ONLY human is the caller — no smuggle effect
    await t.close()
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm test src/adapters/rest/routes/webhooks.test.ts` — Expected: FAIL 404s (no routes).

- [ ] **Step 4: Implement the route module**

Create `src/adapters/rest/routes/webhooks.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import { actorCtx, requireHuman } from '#root/adapters/rest/auth'

// /admin/webhooks* — human-only (requireHuman stays async: sync-void deadlocks fastify
// 5's hook iterator, auth.ts/R4). Secrets: created/rotated shown once, never listable (D-ff).
export const registerWebhookRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  app.get('/admin/webhooks', { preHandler: [requireHuman] }, async () => deps.webhooksRoot.list())

  app.post(
    '/admin/webhooks',
    {
      preHandler: [requireHuman],
      schema: {
        body: {
          type: 'object',
          required: ['agent_id', 'url'],
          additionalProperties: false,
          properties: {
            agent_id: { type: 'string', minLength: 1, maxLength: 60 },
            // 8 = 'http://a', shortest parseable http(s) URL — links.ts precedent; the
            // http(s) SCHEME rule is the use-case's (ports speak validation of shape here)
            url: { type: 'string', minLength: 8, maxLength: 2000 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { agent_id: string; url: string }
      const created = await deps.useCases.createWebhook.run({
        ...body,
        ...actorCtx(request), // actorCtx LAST (binding)
      })
      return reply.code(201).send({ ...created.webhook, secret: created.secret })
    }
  )

  app.post('/admin/webhooks/:id/rotate-secret', { preHandler: [requireHuman] }, async (request) => {
    const { id } = request.params as { id: string }
    const rotated = await deps.useCases.rotateWebhookSecret.run({
      ...actorCtx(request),
      webhook_id: id,
    })
    return { ...rotated.webhook, secret: rotated.secret }
  })

  app.delete('/admin/webhooks/:id', { preHandler: [requireHuman] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    await deps.useCases.deleteWebhook.run({ ...actorCtx(request), webhook_id: id })
    return reply.code(204).send()
  })
}
```

`app.ts`: import + `registerWebhookRoutes(server, deps)` after `registerAdminRoutes` (admin surface groups together).

- [ ] **Step 5: Contract (drift test turns RED until this lands)**

`openapi/openapi.yaml` — add tag `- name: webhooks` under `tags:`; append paths after `/admin/policy/{key}`:

```yaml
/admin/webhooks:
  get:
    tags: [webhooks]
    operationId: listWebhooks
    description: registered agent wake callbacks (human-only, spec §6.8); secrets are NEVER re-served after creation (D-ff)
    responses:
      '200':
        description: webhook rows, oldest first
        content:
          application/json:
            schema: { type: array, items: { $ref: '#/components/schemas/Webhook' } }
      default: { $ref: '#/components/responses/Problem' }
  post:
    tags: [webhooks]
    operationId: createWebhook
    description: >-
      register a per-agent callback (spec §6.8): HMAC secret generated and shown
      EXACTLY ONCE (D-ff); the delivery checkpoint anchors at the current audit
      watermark (D-bb) — a new webhook sees only subsequent events. url must be
      http(s) (use-case rule), unique (DDL rule), 8..2000 chars (schema rule).
    requestBody:
      required: true
      content:
        application/json:
          schema:
            type: object
            required: [agent_id, url]
            additionalProperties: false
            properties:
              agent_id: { type: string, minLength: 1, maxLength: 60 }
              url: { type: string, minLength: 8, maxLength: 2000 }
    responses:
      '201':
        description: webhook row + the one-time secret
        content:
          application/json:
            schema: { $ref: '#/components/schemas/WebhookWithSecret' }
      default: { $ref: '#/components/responses/Problem' }
/admin/webhooks/{id}:
  parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
  delete:
    tags: [webhooks]
    operationId: deleteWebhook
    description: remove a webhook; absent is 404 not_found. Delivery stops immediately.
    responses:
      '204': { description: removed (no body) }
      default: { $ref: '#/components/responses/Problem' }
/admin/webhooks/{id}/rotate-secret:
  parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
  post:
    tags: [webhooks]
    operationId: rotateWebhookSecret
    description: >-
      new HMAC secret shown exactly once; the checkpoint RE-ANCHORS to the current
      watermark and the backoff clears (rotation IS re-registration, D-bb). 404 on ghost.
    responses:
      '200':
        description: webhook row + the new one-time secret
        content:
          application/json:
            schema: { $ref: '#/components/schemas/WebhookWithSecret' }
      default: { $ref: '#/components/responses/Problem' }
```

Append schemas (after `Attachment`):

```yaml
Webhook:
  type: object
  description: registered callback (ports.ts WebhookRecord, D-bb); secret exists only in create/rotate responses (D-ff)
  properties:
    id: { type: string }
    actor_id: { type: string }
    url: { type: string }
    created_by: { type: string }
    created_at: { type: string }
    delivered_cursor: { type: integer, description: audit id the loop delivers AFTER (D-bb) }
WebhookWithSecret:
  description: webhook row + the secret, returned exactly once (D-ff, spec §5 raw_token lineage)
  allOf:
    - $ref: '#/components/schemas/Webhook'
    - type: object
      properties:
        secret:
          {
            type: string,
            description: base64url 32-byte HMAC key; signs X-Nightshift-Signature (D-bb),
          }
```

- [ ] **Step 6: Full gate**

Run: `pnpm test && pnpm lint && pnpm typecheck && pnpm build` — green (drift test pins the new paths; `Problem.code` enum untouched — no new codes in this task).

- [ ] **Step 7: Commit**

```bash
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -am "feat(api): human-only webhook admin surface + contract"
```

> **Amendment (Task 9, embed offsets + quote chars; both TS blocks byte-identical):** Three byte-sync notes. (1) The Step 2 test block and the Step 4 route module transcribed **byte-identical** to disk (diffed against the plan's own lines — zero diff), each passing `prettier --check` as written; the Step 3 RED is the anticipated one: `AssertionError: GET /admin/webhooks: expected 404 to be 403`, `expected 404 to be 201`, `expected 404 to be 400` (3 failed — the 404 is problem.ts's notFoundHandler `not_found`; no fake RED claimed). (2) The Step 5 yaml blocks land embedded: paths at the file's `paths:` nesting indent (+2), schemas at `components.schemas` (+4), and prettier's yaml override (`singleQuote: false`) swaps the blocks' single-quoted `'200'`/`'#/components/...'` tokens to the file's double-quote style — Task 2 amendment precedent, quote characters only, structure as planned. Both normalizations verified mechanically: block + embed-indent + quote-swap diffs zero against disk. (3) The Step 1 deps.ts fragment lands at the file's nesting offsets — the three use-case lines at +2 (the `useCases` members sit at 6 spaces where the fragment shows 4) and `webhooksRoot` byte-identical at 4; the import lines and `AppDeps` field lines have no plan block (the step's prose names the symbols), and the app.ts registration follows the step's placement prose with a house comment. Block sync = shipped form.

---

## Task 10: `GET /events` — the cursor feed (D-aa/D-dd)

**Files:**

- Create: `src/adapters/rest/routes/events.ts` + test
- Modify: `src/adapters/rest/app.ts`
- Modify: `openapi/openapi.yaml`

- [ ] **Step 1: Write the failing test**

Create `src/adapters/rest/routes/events.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { makeTestApp } from '#root/testing/test-app'

const bearer = (t: string) => ({ authorization: `Bearer ${t}` })

const createTask = async (t: Awaited<ReturnType<typeof makeTestApp>>, title: string) =>
  t.app.inject({ method: 'POST', url: '/tasks', headers: bearer(t.adminToken), payload: { title } })

describe('GET /events (D-aa, D-dd)', () => {
  it('requires auth (PUBLIC_PATHS stays exactly {/ping,/openapi.yaml})', async () => {
    const t = await makeTestApp()
    const res = await t.app.inject({ method: 'GET', url: '/events' })
    expect(res.statusCode).toBe(401)
    await t.close()
  })

  it('cursor advances monotonically; caught-up ⇒ empty; payloads excluded', async () => {
    const t = await makeTestApp()
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: '/events?cursor=0',
          headers: bearer(t.adminToken),
        })
      ).json()
    ).toEqual([])
    await createTask(t, 'one')
    const r1 = await t.app.inject({
      method: 'GET',
      url: '/events?cursor=0',
      headers: bearer(t.adminToken),
    })
    const events = r1.json()
    expect(events.map((e: { action: string }) => e.action)).toEqual(['task_created'])
    const e0 = events[0]
    // minus payloads (D-aa): the before/after snapshots are the excluded payloads —
    // every OTHER audit-worthy field rides
    expect(Object.keys(e0).sort()).toEqual(
      [
        'action',
        'actor_id',
        'created_at',
        'cursor',
        'entity_id',
        'entity_type',
        'reason',
        'token_id',
      ].sort()
    )
    expect(e0.entity_type).toBe('task')
    expect(e0.reason).toBe('task created')
    const cursorA = e0.cursor
    await createTask(t, 'two')
    const r2 = await t.app.inject({
      method: 'GET',
      url: `/events?cursor=${cursorA}`,
      headers: bearer(t.adminToken),
    })
    const next = r2.json()
    expect(next).toHaveLength(1)
    expect(next[0].cursor).toBeGreaterThan(cursorA) // monotonic, ASCENDING
    const tail = await t.app.inject({
      method: 'GET',
      url: `/events?cursor=${next[0].cursor}`,
      headers: bearer(t.adminToken),
    })
    expect(tail.json()).toEqual([]) // caught up
    await t.close()
  })

  it('query validation: negative/fractional/non-integer cursor → 400 invalid_request; limit bounds', async () => {
    const t = await makeTestApp()
    for (const q of ['cursor=-1', 'cursor=1.5', 'cursor=abc', 'limit=0', 'limit=501']) {
      const res = await t.app.inject({
        method: 'GET',
        url: `/events?${q}`,
        headers: bearer(t.adminToken),
      })
      expect(res.statusCode, q).toBe(400)
      expect(res.json().code, q).toBe('invalid_request')
    }
    await t.close()
  })

  it('tailing BURNS the per-actor rate-limit budget like any GET (D-dd pin)', async () => {
    const t = await makeTestApp({ NS_RATE_LIMIT_PER_MIN: '2' })
    const h = bearer(t.adminToken)
    expect((await t.app.inject({ method: 'GET', url: '/events', headers: h })).statusCode).toBe(200)
    expect((await t.app.inject({ method: 'GET', url: '/events', headers: h })).statusCode).toBe(200)
    const third = await t.app.inject({ method: 'GET', url: '/events', headers: h })
    expect(third.statusCode).toBe(429)
    expect(third.json().code).toBe('rate_limited')
    await t.close()
  })

  it('limit caps the batch (default 100, max 500 — yaml schema parity)', async () => {
    const t = await makeTestApp()
    for (let i = 0; i < 4; i++) await createTask(t, `t${i}`)
    const res = await t.app.inject({
      method: 'GET',
      url: '/events?cursor=0&limit=2',
      headers: bearer(t.adminToken),
    })
    const batch = res.json()
    expect(batch).toHaveLength(2)
    expect(batch[0].cursor).toBeLessThan(batch[1].cursor) // ASCENDING slice from the cursor
    const all = await t.app.inject({
      method: 'GET',
      url: '/events?cursor=0',
      headers: bearer(t.adminToken),
    })
    expect(all.json().length).toBeGreaterThan(2) // the cap, not the data, produced the 2
    await t.close()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/adapters/rest/routes/events.test.ts` — Expected: FAIL 404.

- [ ] **Step 3: Implement**

Create `src/adapters/rest/routes/events.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import type { AuditRow } from '#root/application/ports'

// minus payloads (D-aa, spec §6.8 "everything audit-worthy minus payloads"): the
// before/after snapshots ARE the payloads; actor/token attribution, the machine
// action+entity, the machine reason and the timestamp all ride. cursor = audit_log.id.
const toEvent = (r: AuditRow) => ({
  cursor: r.id,
  actor_id: r.actor_id,
  token_id: r.token_id,
  action: r.action,
  entity_type: r.entity_type,
  entity_id: r.entity_id,
  reason: r.reason,
  created_at: r.created_at,
})

export const registerEventRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  // D-dd: NO rate-limit exemption — this GET reaches the budget like every other
  // route (burn rule pinned in events.test.ts); tailing at NS_RATE_LIMIT_PER_MIN
  // is the designed posture, webhooks are the push path
  app.get(
    '/events',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            cursor: { type: 'integer', minimum: 0, default: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
          },
        },
      },
    },
    async (request) => {
      const q = request.query as { cursor: number; limit: number }
      const rows = await deps.auditRoot.tail(q.cursor, q.limit)
      return rows.map(toEvent)
    }
  )
}
```

`app.ts`: import + `registerEventRoutes(server, deps)` after `registerAuditRoutes` (audit surface groups).

- [ ] **Step 4: Contract**

`openapi/openapi.yaml` — tags gains `- name: events`; paths (after `/audit`):

```yaml
/events:
  get:
    tags: [events]
    operationId: getEvents
    description: >-
      global event feed (spec §6.8): the audit spine minus payloads (D-aa), ASCENDING
      from the cursor; cursor is an audit_log.id — monotonic across restarts (append-only,
      never purged). Tailing burns the per-actor rate-limit budget (D-dd). SSE is deferred
      (§6.8/§12): poll this, or register a webhook.
    parameters:
      - { name: cursor, in: query, schema: { type: integer, minimum: 0, default: 0 } }
      - {
          name: limit,
          in: query,
          schema: { type: integer, minimum: 1, maximum: 500, default: 100 },
        }
    responses:
      '200':
        description: events with cursor strictly increasing; empty when caught up
        content:
          application/json:
            schema: { type: array, items: { $ref: '#/components/schemas/Event' } }
      default: { $ref: '#/components/responses/Problem' }
```

Schema (after `AuditEntry`):

```yaml
Event:
  type: object
  description: audit spine minus payloads (D-aa) — before/after snapshots are excluded; the machine reason rides
  properties:
    cursor: { type: integer, description: audit_log.id — the restart-monotonic cursor }
    actor_id: { type: ['string', 'null'] }
    token_id: { type: ['string', 'null'] }
    action: { type: string }
    entity_type: { type: string }
    entity_id: { type: string }
    reason: { type: ['string', 'null'] }
    created_at: { type: string }
```

- [ ] **Step 5: Full gate + commit**

Run: `pnpm test && pnpm lint && pnpm typecheck` — green.

```bash
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -am "feat(api): GET /events cursor feed over the audit spine"
```

---

## Task 11: `WebhookDeliveryLoop` — the drain, HMAC, checkpoint/backoff (D-bb)

**Files:**

- Create: `src/infra/webhooks/delivery-loop.ts` + test

The loop reads ONLY root repos / its injected repos — it never opens a transaction, so the non-reentrancy clause is satisfied vacuously and **no transaction is ever held across network I/O** (binding). Per the inherited ruling, a background loop needing a UoW gets its **own** instance on the same db; this loop needs **none** — all its writes are single statements (uow.ts:44-45: global safety is Kysely's driver mutex). Stated instead of silently deviating.

- [ ] **Step 1: Write the failing test** — create `src/infra/webhooks/delivery-loop.test.ts`

```ts
import { createServer, type Server } from 'node:http'
import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AddressInfo } from 'node:net'
import { sql } from 'kysely'
import type { AuditEntryDraft } from '#root/application/ports'
import { makeDb } from '#root/infra/sqlite/db'
import { migrateToLatest } from '#root/infra/sqlite/migrations'
import { SqliteAuditRepo } from '#root/infra/sqlite/audit-repo'
import { SqliteWebhookRepo } from '#root/infra/sqlite/webhook-repo'
import { WebhookDeliveryLoop } from '#root/infra/webhooks/delivery-loop'

interface Received {
  body: string
  sig: string | undefined
  ts: string | undefined
}

// a REAL receiver (a real store pins the contract — no fakes): node:http on an
// ephemeral port, programmed per-test with a status queue
let receiver: Server
let received: Received[]
let statuses: number[] = []
let url: string

beforeAll(async () => {
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      received.push({
        body: Buffer.concat(chunks).toString('utf8'),
        sig: req.headers['x-nightshift-signature'] as string | undefined,
        ts: req.headers['x-nightshift-timestamp'] as string | undefined,
      })
      const status = statuses.length > 0 ? (statuses.shift() as number) : 200
      res.writeHead(status).end()
    })
  })
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/cb`
})
afterAll(async () => {
  await new Promise((r) => receiver.close(r))
})

const CFG = { intervalMs: 0, timeoutMs: 2_000, maxBackoffMs: 10_000 }

const setup = async (opts: { url?: string; secret?: string } = {}) => {
  const db = makeDb(':memory:')
  await migrateToLatest(db)
  await sql`insert into actors (id, kind, handle, display_name, description, created_at)
              values ('a_h','human','h','H','','2026-01-01'),
                     ('a_g','agent','g','G','','2026-01-01')`.execute(db)
  const audit = new SqliteAuditRepo(db)
  const webhooks = new SqliteWebhookRepo(db)
  await webhooks.add({
    id: 'wh_1',
    actor_id: 'a_g',
    url: opts.url ?? url,
    secret: opts.secret ?? 'k3y',
    created_by: 'a_h',
    created_at: '2026-01-01',
    delivered_cursor: 0,
  })
  return { db, audit, webhooks }
}
const audited = async (
  audit: SqliteAuditRepo,
  n: number,
  entity = 'task',
  id = 't_1'
): Promise<void> => {
  const e: AuditEntryDraft = {
    actor_id: 'a_h',
    token_id: null,
    action: `act_${n}`,
    entity_type: entity,
    entity_id: id,
    after: { payload: 'SECRET-PAYLOAD' },
    reason: `reason ${n}`,
    created_at: '2026-01-01',
  }
  await audit.append(e)
}

describe('WebhookDeliveryLoop (D-bb)', () => {
  it('delivers the envelope, signed, past the checkpoint — and nothing before it', async () => {
    received = []
    const s = await setup({ secret: 'topkey' })
    await audited(s.audit, 1)
    await s.webhooks.advance('wh_1', 1) // checkpoint PAST row 1 (watermark semantics)
    await audited(s.audit, 2)
    const loop = new WebhookDeliveryLoop(s.webhooks, s.audit, CFG)
    await loop.tick(1_000)
    expect(received).toHaveLength(1) // row 1 already checkpointed ⇒ only row 2 (D-bb)
    const msg = JSON.parse(received[0].body)
    expect(msg).toEqual({ event: 'act_2', task_id: 't_1', cursor: 2 }) // §6.8 envelope LITERAL
    expect(received[0].sig).toBe(
      `sha256=${createHmac('sha256', 'topkey').update(received[0].body).digest('hex')}`
    )
    expect(Number(received[0].ts)).toBeGreaterThan(0)
    expect((await s.webhooks.find('wh_1'))?.delivered_cursor).toBe(2)
    // minus-payloads rule: the audit after-snapshot NEVER crosses the wire
    expect(received[0].body).not.toContain('SECRET-PAYLOAD')
    await s.db.destroy()
  })

  it('non-task entity ⇒ task_id null; batch drains newest cursor only', async () => {
    received = []
    const s = await setup()
    await audited(s.audit, 1, 'thread', 'th_9')
    await audited(s.audit, 2)
    await new WebhookDeliveryLoop(s.webhooks, s.audit, CFG).tick(1_000)
    expect(received).toHaveLength(2)
    expect(JSON.parse(received[0].body)).toEqual({ event: 'act_1', task_id: null, cursor: 1 })
    expect((await s.webhooks.find('wh_1'))?.delivered_cursor).toBe(2)
    await s.db.destroy()
  })

  it('failure ⇒ checkpoint STAYS, attempts++ with backoff park; retry then advances (at-least-once)', async () => {
    received = []
    statuses = [500] // first attempt fails, later attempts default 200
    const s = await setup()
    await audited(s.audit, 1)
    const loop = new WebhookDeliveryLoop(s.webhooks, s.audit, CFG)
    await loop.tick(1_000)
    expect(received).toHaveLength(1) // tried
    const stuck = await s.webhooks.listDue(1_000) // still parked at now+2000
    expect(stuck).toEqual([]) // parked ⇒ not due at the same now
    const row = await sql<{ c: number; a: number; n: number }>`
      select delivered_cursor as c, attempts as a, next_attempt_at as n from webhooks`.execute(s.db)
    expect(row.rows[0]).toEqual({ c: 0, a: 1, n: 3_000 }) // min(10_000, 1000·2^1) (T14 raw Date.now domain)
    await loop.tick(3_000) // due now — succeeds ⇒ exactly-once becomes AT-least-once: event delivered TWICE total
    expect(received).toHaveLength(2)
    expect((await s.webhooks.find('wh_1'))?.delivered_cursor).toBe(1)
    expect((await s.webhooks.listDue(9_999))[0]?.attempts).toBe(0) // ACK resets backoff (advance)
    await s.db.destroy()
  })

  it('dead endpoint: network error is a retryable failure, identical bookkeeping to 500', async () => {
    received = []
    const s = await setup({ url: 'http://127.0.0.1:1/cb' }) // nothing listens
    await audited(s.audit, 1)
    await new WebhookDeliveryLoop(s.webhooks, s.audit, CFG).tick(1_000)
    const row = await sql<{
      c: number
      a: number
    }>`select delivered_cursor as c, attempts as a from webhooks`.execute(s.db)
    expect(row.rows[0]).toEqual({ c: 0, a: 1 })
    await s.db.destroy()
  })

  it('backoff caps at maxBackoffMs (geometric, capped)', async () => {
    received = []
    statuses = [500, 500, 500, 500, 500, 500, 500, 500, 500] // long failure streak
    const s = await setup()
    await audited(s.audit, 1)
    const loop = new WebhookDeliveryLoop(s.webhooks, s.audit, CFG) // maxBackoff 10_000
    let now = 1_000
    for (let i = 0; i < 8; i++) {
      await loop.tick(now)
      const row = await sql<{
        n: number
        a: number
      }>`select next_attempt_at as n, attempts as a from webhooks`.execute(s.db)
      const { n, a } = row.rows[0] as { n: number; a: number }
      expect(a).toBe(i + 1)
      expect(n - now).toBeLessThanOrEqual(10_000) // capped
      expect(n - now).toBe(Math.min(10_000, 1_000 * 2 ** (i + 1)))
      now = n
    }
    await s.db.destroy()
  })

  it('overlap guard: a tick() fired while a drain is in flight returns the SAME pass', async () => {
    // deterministic without any timing race: the guard is synchronous — the second
    // call lands before the first tick awaits anything, so identity proves the no-op
    received = []
    const s = await setup()
    await audited(s.audit, 1)
    const loop = new WebhookDeliveryLoop(s.webhooks, s.audit, CFG)
    const first = loop.tick(1_000)
    const second = loop.tick(1_000)
    expect(second).toBe(first)
    await Promise.all([first, second])
    expect(received).toHaveLength(1) // one event, exactly one POST despite two tick calls
    await s.db.destroy()
  })

  it('empty tail ⇒ no POST, no checkpoint churn; a webhook past the watermark receives nothing', async () => {
    received = []
    const s = await setup()
    await s.webhooks.advance('wh_1', 999) // D-bb watermark anchor state
    await new WebhookDeliveryLoop(s.webhooks, s.audit, CFG).tick(1_000)
    expect(received).toEqual([])
    expect((await s.webhooks.find('wh_1'))?.delivered_cursor).toBe(999)
    await s.db.destroy()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/infra/webhooks/delivery-loop.test.ts` — Expected: FAIL (module absent).

- [ ] **Step 3: Implement** — create `src/infra/webhooks/delivery-loop.ts`

```ts
import { createHmac } from 'node:crypto'
import type { AuditRepo, DueWebhook, WebhookRepo } from '#root/application/ports'

export interface DeliveryConfig {
  intervalMs: number // 0 = loop disabled (config-level kill; start() refuses)
  timeoutMs: number
  maxBackoffMs: number
}

/** One batch per webhook per tick — a long backlog drains across ticks (D-bb). */
const BATCH = 50

/**
 * The webhook delivery loop (D-bb): reads the audit spine PAST each webhook's
 * checkpoint (audit IS the outbox, D-aa), POSTs `{event, task_id, cursor}` signed
 * with the webhook's HMAC key, advances the checkpoint per ACK. At-least-once —
 * a crash between POST and advance re-delivers; consumers dedupe on the cursor.
 *
 * Never holds a transaction across network I/O (binding): the loop owns NO UoW —
 * its writes are single statements (uow.ts: global safety is Kysely's driver mutex),
 * and its reads ride root repos. This is the §9 "outbox table → delivery loop"
 * realized on the audit spine; the §9 "DeliveryQueue port" materializes as exactly
 * this class + WebhookRepo's checkpoint methods — there is no separate enqueue.
 *
 * Single-process honesty (D-v lineage): one interval timer per container.
 */
export class WebhookDeliveryLoop {
  private timer: ReturnType<typeof setInterval> | undefined
  private draining: Promise<void> | undefined

  constructor(
    private readonly webhooks: WebhookRepo,
    private readonly audit: AuditRepo,
    private readonly config: DeliveryConfig
  ) {}

  /** Composition-root entry (index.ts): refuses to start disabled (intervalMs 0). */
  start(): void {
    if (this.config.intervalMs <= 0) return
    this.timer = setInterval(() => void this.tick().catch(() => undefined), this.config.intervalMs)
    this.timer.unref() // the loop must never hold shutdown hostage (index.ts owns close)
  }

  /**
   * One drain pass. `nowMs` defaults to RAW Date.now — T14 seam: retry windows are
   * throttle/retry DECISIONS on real elapsed time (comment deliberately here).
   * Overlap-guarded: an interval fire while a drain is in flight is a no-op
   * (sequential delivery per webhook keeps the checkpoint race-free).
   */
  tick(nowMs: number = Date.now()): Promise<void> {
    if (this.draining) return this.draining // re-entrant tick() is a no-op while draining
    this.draining = this.drainAll(nowMs).finally(() => {
      this.draining = undefined
    })
    return this.draining
  }

  private async drainAll(nowMs: number): Promise<void> {
    for (const hook of await this.webhooks.listDue(nowMs)) {
      await this.drainOne(hook, nowMs)
    }
  }

  private async drainOne(hook: DueWebhook, nowMs: number): Promise<void> {
    const events = await this.audit.tail(hook.delivered_cursor, BATCH)
    for (const ev of events) {
      try {
        await this.post(hook, ev.action, ev.entity_type === 'task' ? ev.entity_id : null, ev.id)
        await this.webhooks.advance(hook.id, ev.id) // per-ACK advance ⇒ at-least-once
      } catch {
        // honest at-least-once boundary: on failure the checkpoint STAYS at the last
        // ACK'd id and the webhook parks until next_attempt_at (D-bb backoff)
        const attempts = hook.attempts + 1
        const delay = Math.min(this.config.maxBackoffMs, 1_000 * 2 ** attempts)
        await this.webhooks.scheduleRetry(hook.id, attempts, nowMs + delay)
        return
      }
    }
  }

  /** Envelope is LITERALLY spec §6.8: {event, task_id, cursor}. No additions. */
  private async post(
    hook: DueWebhook,
    event: string,
    taskId: string | null,
    cursor: number
  ): Promise<void> {
    const body = JSON.stringify({ event, task_id: taskId, cursor })
    // HMAC over the exact wire bytes (D-bb); key plaintext at rest by D-ff's stated exception
    const signature = `sha256=${createHmac('sha256', hook.secret).update(body, 'utf8').digest('hex')}`
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-nightshift-signature': signature,
        'x-nightshift-timestamp': String(Date.now()), // replay-window aid (runner-side policy; board never enforces)
      },
      body,
      signal: AbortSignal.timeout(this.config.timeoutMs),
    })
    if (!res.ok) throw new Error(`webhook ${hook.id} answered ${res.status}`)
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.draining // let an in-flight drain finish (at-least-once across shutdown)
  }
}
```

**Deviation note (plan self-review):** the Step-1 failure-bookkeeping test expects `delivered_cursor: 0, attempts: 1, next_attempt_at: 3000` for the FIRST failure — `2**attempts` with attempts starting at 1 ⇒ delay 2000 parked from now=1000. The backoff-cap loop's first delta is likewise 2000. If review changes the exponent base (e.g. `2**(attempts-1)`), the amendment protocol applies; the shipped text and tests must agree.

- [ ] **Step 4: Gate + commit**

Run: `pnpm test && pnpm lint && pnpm typecheck` — green.

```bash
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -am "feat(infra): webhook delivery loop — signed, backoff, at-least-once"
```

---

## Task 12: Wire the loop into the composition root (start disabled in tests)

**Files:**

- Modify: `src/main/deps.ts` (`AppDeps.deliveryLoop`)
- Modify: `src/index.ts` (start after listen; stop inside shutdown; **its own UoW-less repos** — see note)
- Modify: `src/testing/test-app.ts` (explicit `NS_WEBHOOK_INTERVAL_MS: '0'` default)

- [ ] **Step 1: Failing behavior test** — append to `src/adapters/rest/routes/webhooks.test.ts`:

```ts
it('makeTestApp defaults the loop DISABLED (the suite must never POST; D-v posture)', async () => {
  const t = await makeTestApp()
  expect(t.deps.config.webhookIntervalMs).toBe(0)
  // start() on a disabled loop is inert — no timer to leak, proven by process exit
  await t.deps.deliveryLoop.stop() // resolves even when never started
  await t.close()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/adapters/rest/routes/webhooks.test.ts` — Expected: FAIL (`deliveryLoop`/config knob absent on deps).

- [ ] **Step 3: deps**

`deps.ts`: import `WebhookDeliveryLoop`; `AppDeps` gains `deliveryLoop: WebhookDeliveryLoop`. In `makeDepsFromDb`:

```ts
    // D-bb loop: constructed here, STARTED only by the composition root (index.ts) —
    // makeTestApp never starts it (intervalMs 0 default there) so the suite stays inert.
    // Its repo instances are its own (root connections) — the loop touches no UoW
    // (stated deviation from the background-loop clause: it needs none; all its writes
    // are single statements, global safety via Kysely's driver mutex, uow.ts:44-45).
    deliveryLoop: new WebhookDeliveryLoop(
      new SqliteWebhookRepo(db),
      new SqliteAuditRepo(db),
      {
        intervalMs: config.webhookIntervalMs,
        timeoutMs: config.webhookTimeoutMs,
        maxBackoffMs: config.webhookMaxBackoffMs,
      }
    ),
```

- [ ] **Step 4: index.ts** — start after `listen`, stop inside `shutdown` (before `server.close` is irrelevant; order: loop first — network I/O must stop before the db):

```ts
await server.listen({ port: config.port, host: '0.0.0.0' })
deps.deliveryLoop.start() // refuses when intervalMs 0 (config-level kill, D-v lineage)

const shutdown = async (): Promise<void> => {
  if (closing) return
  closing = true
  server.log.info('Graceful shutdown signal received')
  await deps.deliveryLoop.stop() // drains the in-flight pass before the db goes away
  await server.close()
  await db.destroy()
  process.exit(0)
}
```

- [ ] **Step 5: makeTestApp** — defaults object gains `NS_WEBHOOK_INTERVAL_MS: '0',` (with the rate-limit line's comment lineage: "the suite must never POST").

- [ ] **Step 6: Full gate + commit**

Run: `pnpm test && pnpm lint && pnpm typecheck && pnpm build` — green.

```bash
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -am "feat(main): webhook loop in the composition root, off in tests"
```

---

## Task 13: FTS5 external-content index + repo-port read (D-gg, spec §9 — no UI, no route)

**Files:**

- Modify: `src/infra/sqlite/migrations.ts` (append key)
- Modify: `src/infra/sqlite/schema.ts`
- Modify: `src/infra/sqlite/migrations.test.ts` (TABLES grows with the FTS shadow tables — exact names listed below; EXPLAIN-probe step included because shadow naming is an implementation fact, not folklore)
- Create: `src/infra/sqlite/search-repo.ts` + test
- Modify: `src/application/ports.ts` (`TaskSearchHit`, `TaskSearchRepo` — read-only root port, NOT in `Repos`)
- Modify: `src/main/deps.ts` (`searchRoot`)

- [ ] **Step 1: Write the failing repo test** — create `src/infra/sqlite/search-repo.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { DomainError } from '#root/domain/errors'
import { makeDb } from '#root/infra/sqlite/db'
import { migrateToLatest } from '#root/infra/sqlite/migrations'
import { SqliteSearchRepo } from '#root/infra/sqlite/search-repo'

const setup = async () => {
  const db = makeDb(':memory:')
  await migrateToLatest(db)
  await sql`insert into actors (id, kind, handle, display_name, description, created_at)
              values ('a_h','human','h','H','','2026-01-01')`.execute(db)
  const task = (id: string, title: string, description: string, ac: string) =>
    sql`insert into tasks (id, title, description, acceptance_criteria, created_by, created_at, updated_at, position)
          values (${id}, ${title}, ${description}, ${ac}, 'a_h', '2026-01-01', '2026-01-01', 1)`.execute(
      db
    )
  return { db, task }
}

describe('SqliteSearchRepo (D-gg)', () => {
  it('matches title/description/AC; returns id/title/snippet/score, score-desc', async () => {
    const { db, task } = await setup()
    await task(
      't_a',
      'Deploy the widget service',
      'kubernetes widget rollout notes',
      'widgets live'
    )
    await task('t_b', 'Unrelated', 'widget mentions only in the description body', '')
    await task('t_c', 'Nothing here', '', '')
    const repo = new SqliteSearchRepo(db)
    const hits = await repo.search('widget', 10)
    expect(hits.map((h) => h.id).sort()).toEqual(['t_a', 't_b']) // AC-free t_c absent
    expect(hits[0].title).toBeDefined()
    expect(hits[0].snippet).toMatch(/\[widget\]/i) // snippet wraps matched terms in [] (D-gg marker choice)
    expect(hits[0].score).toBeGreaterThan(hits[1].score) // bm25 flipped: higher = better
    expect(await repo.search('widget', 1)).toHaveLength(1) // limit respected (score order decides WHICH one)
    await db.destroy()
  })

  it('population rides the triggers: raw insert/update visible; UPDATE moves the term', async () => {
    const { db, task } = await setup()
    await task('t_u', 'alpha', 'body one', '')
    const repo = new SqliteSearchRepo(db)
    expect((await repo.search('alpha', 10)).map((h) => h.id)).toEqual(['t_u'])
    await sql`update tasks set title = 'beta', description = 'body one' where id = 't_u'`.execute(
      db
    )
    expect(await repo.search('alpha', 10)).toEqual([]) // AU trigger deleted the old row
    expect((await repo.search('beta', 10)).map((h) => h.id)).toEqual(['t_u']) // and inserted the new
    await db.destroy()
  })

  it('malformed FTS syntax is invalid_request, not a 500 (taxonomy: NO new code)', async () => {
    const { db, task } = await setup()
    await task('t_q', 'searchable term', '', '')
    const repo = new SqliteSearchRepo(db)
    const err = await repo.search('"unbalanced', 10).catch((e) => e)
    expect(err).toBeInstanceOf(DomainError)
    expect((err as DomainError).code).toBe('invalid_request')
    // probe note (record observed behavior here, never assume): if the implementer also
    // probes 'AND OR' and the engine REJECTS it too, pin it as a second case; if the
    // engine accepts it (0 hits, no throw), pin that with expect(...).resolves.toEqual([]).
    await db.destroy()
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `pnpm test src/infra/sqlite/search-repo.test.ts` — FAIL (no table/module).

- [ ] **Step 3: Probe the shadow-table names before editing the pin (honesty step)**

Append the migration first (Step 4), then run the probe — a one-liner through the project's own tsx:

```bash
pnpm exec tsx --eval "
import { makeDb } from './src/infra/sqlite/db.ts'
import { migrateToLatest } from './src/infra/sqlite/migrations.ts'
const d = makeDb(':memory:')
await migrateToLatest(d)
const r = await d.selectFrom('sqlite_master').select('name').where('type', '=', 'table').execute()
console.log(r.map((x) => x.name).sort().join('\n'))
await d.destroy()
"
```

Expected: the base list plus `task_fts` and the FTS5 shadow names. SQLite's documented shadow set for a table named `task_fts` is `task_fts_config`, `task_fts_content`, `task_fts_data`, `task_fts_docsize`, `task_fts_idx` — the probe CONFIRMS (never assume); paste the observed names into Step 5's `TABLES` edit verbatim and quote the probe output in the commit note.

- [ ] **Step 4: Migration** — append to the map:

```ts
  '2026-09-12_fts_search': {
    up: async (db: Kysely<DB>) => {
      // D-gg (spec §9 "nearly free"): EXTERNAL-CONTENT FTS5 — text lives in `tasks`,
      // the index lives here. content_rowid='rowid': tasks.id is TEXT (RandomIdGen),
      // which cannot alias rowid, but a rowid table KEEPS its implicit rowid — the
      // triggers mirror (task_ai/ad/au) keep the index honest. NO UI yet (§12):
      // reads ship as a repo port only.
      await sql`create virtual table task_fts using fts5(
        title, description, acceptance_criteria,
        content='tasks', content_rowid='rowid', tokenize='unicode61'
      )`.execute(db)
      await sql`create trigger task_fts_ai after insert on tasks begin
        insert into task_fts (rowid, title, description, acceptance_criteria)
          values (new.rowid, new.title, new.description, new.acceptance_criteria);
      end`.execute(db)
      await sql`create trigger task_fts_ad after delete on tasks begin
        insert into task_fts (task_fts, rowid) values ('delete', old.rowid);
      end`.execute(db)
      await sql`create trigger task_fts_au after update on tasks begin
        insert into task_fts (task_fts, rowid, title, description, acceptance_criteria)
          values ('delete', old.rowid, old.title, old.description, old.acceptance_criteria);
        insert into task_fts (rowid, title, description, acceptance_criteria)
          values (new.rowid, new.title, new.description, new.acceptance_criteria);
      end`.execute(db)
      // population: external-content FTS5 does NOT back-fill on its own. The canonical
      // rebuild ships IN the migration: on CI the content table is empty (no-op) and on
      // a homelab upgrade it indexes every pre-existing task — one statement, both paths.
      await sql`insert into task_fts(task_fts) values ('rebuild')`.execute(db)
    },
  },
```

**Honest declaration (the rebuild's data-carry arm):** the `rebuild` statement executes on every CI migration run (against zero pre-existing rows — the statement path is covered); the _populating-from-existing-rows_ arm fires only on a homelab upgrade and cannot be exercised in CI (the migration map is module-private — no step-up probe). Declared, not pinned; no fake RED is claimed. The triggers, which keep the index honest from migration time onward, ARE pinned by the Step 1 tests.

- [ ] **Step 5: schema + TABLES pin**

`schema.ts`: FTS5 virtual tables have no static Kysely row interface worth faking; the search repo queries through `sql` templates against the real table. Add to `DB`:

```ts
// FTS5 virtual table: queried via sql templates (Kysely's builder has no match-op);
// column interface matches the fts5 columns (rowid implicit). Declared for type-honest
// sql-template composition only.
task_fts: {
  rowid: number
  title: string
  description: string
  acceptance_criteria: string
}
```

`migrations.test.ts`: append to `TABLES` the probe-confirmed names (expected: `'task_fts'`, `'task_fts_config'`, `'task_fts_content'`, `'task_fts_data'`, `'task_fts_docsize'`, `'task_fts_idx'` — **the probe output is the source of truth**; the existing `not like 'sqlite%'` filter does NOT catch them). The `'creates all tables'` test goes RED then GREEN purely from the extended list.

- [ ] **Step 6: Port + implementation + deps**

`ports.ts` (after the links section):

```ts
// ---- task search (spec §9 FTS5, D-gg) — READ-ONLY root port: no UI (spec §12), no
// route (a route without contract entry trips the drift test), no tx writes.
export interface TaskSearchHit {
  id: string
  title: string
  /** title column, matched terms wrapped in [] */
  snippet: string
  /** bm25 flipped: higher = better */
  score: number
}

export interface TaskSearchRepo {
  /** FTS5 MATCH syntax; malformed queries ⇒ DomainError('invalid_request'). */
  search(query: string, limit: number): Promise<TaskSearchHit[]>
}
```

Create `src/infra/sqlite/search-repo.ts`:

```ts
import { sql, type Kysely } from 'kysely'
import { DomainError } from '#root/domain/errors'
import type { TaskSearchHit, TaskSearchRepo } from '#root/application/ports'
import type { DB } from '#root/infra/sqlite/schema'

// D-gg: read-only over the FTS5 external-content index. LIMIT is a bound parameter after
// integer clamping — the limit is our own validated integer, not user text. bm25() is
// negative-better; flipped to score (higher = better) at the port boundary.
// FTS5 SYNTAX errors are QUERY facts (the MATCH string is user input) — mapped to
// invalid_request, taxonomy unchanged. The map is exact: better-sqlite3 raises
// SqliteError whose message starts 'fts5:'. Anything else RE-THROWS (internal_error
// honesty — no blanket catch that swallows real bugs).
export class SqliteSearchRepo implements TaskSearchRepo {
  constructor(private readonly db: Kysely<DB>) {}

  async search(query: string, limit: number): Promise<TaskSearchHit[]> {
    const capped = Math.max(1, Math.min(200, Math.trunc(limit)))
    let r
    try {
      r = await sql<TaskSearchHit>`
        select
          t.id as id,
          t.title as title,
          snippet(task_fts, 0, '[', ']', '…', 16) as snippet,
          -bm25(task_fts) as score
        from task_fts
        join tasks t on t.rowid = task_fts.rowid
        where task_fts match ${query}
        order by score desc
        limit ${capped}
      `.execute(this.db)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/^fts5:/i.test(msg))
        throw new DomainError('invalid_request', `invalid search query: ${msg}`)
      throw e // unknown errors stay internal_error (problem.ts fallback)
    }
    return r.rows.map((row) => ({ ...row, score: Number(row.score) }))
  }
}
```

`deps.ts`: `searchRoot: SqliteSearchRepo` (+ construction `new SqliteSearchRepo(db)`).

- [ ] **Step 7: Gate + commit**

Run: `pnpm test && pnpm lint && pnpm typecheck` — green (domain coverage unaffected).

```bash
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -am "feat(infra): FTS5 external-content search over tasks (repo-port only)"
```

---

## Task 14: `claim_conflict` emission in `ClaimTask` (D-cc — second-tx pattern)

**Files:**

- Modify: `src/application/usecases/claim-task.ts`
- Modify: its existing use-case test file (locate: `rg "ClaimTask" src --glob '*.test.ts'`) — extend, don't duplicate

- [ ] **Step 1: Write the failing tests** (append to the existing ClaimTask test file; adapt its setup helpers)

```ts
it('race loser gets a claim_conflict inbox copy AND still gets the unchanged 409 (D-cc)', async () => {
  // setup: uow + a task 't_x' todo; actor A claims; actor B (distinct ActorRef+token) attacks
  await expect(uc.run(claimByB)).rejects.toMatchObject({
    code: 'already_claimed',
    details: { holder_handle: 'a', holder_display_name: 'A' }, // contract byte-exact (ora-14 M-1)
  })
  const rows = await db.selectFrom('inbox_items').selectAll().execute()
  expect(rows.map((r) => [r.actor_id, r.kind, r.task_id])).toEqual([
    ['b_actor', 'claim_conflict', 't_x'],
  ])
  // NOT audited (D-cc): a rejection is not a workspace mutation (D-r doctrine)
  expect(
    (await db.selectFrom('audit_log').select('action').execute()).map((a) => a.action)
  ).not.toContain('claim_conflict')
})

it('holder re-claiming its OWN task does NOT spam its inbox (D-cc guard)', async () => {
  await uc.run(claimByA) // first claim
  await expect(uc.run(claimByA)).rejects.toMatchObject({ code: 'already_claimed' })
  expect(await db.selectFrom('inbox_items').selectAll().execute()).toEqual([])
})

it('other rejection paths leave no inbox trace (not_found / not_a_leaf paths untouched)', async () => {
  await expect(
    uc.run({ actor: actorB, tokenId: 'tok_b', taskId: 't_ghost' })
  ).rejects.toMatchObject({ code: 'not_found' })
  expect(await db.selectFrom('inbox_items').selectAll().execute()).toEqual([])
})
```

(The second-transaction post-throw write means the loser path must NOT be inside the original `withTransaction` — the tests above pin the split. Adjust `claimByA/claimByB` fixture actor ids to the real file's conventions; the pin semantics are the contract.)

- [ ] **Step 2: Run to verify it fails** — `pnpm test` on that file — FAIL (no inbox rows; guard test may pass vacuously pre-change — say so in the commit note, no fake RED).

- [ ] **Step 3: Implement** — replace `src/application/usecases/claim-task.ts` entirely:

```ts
import { formatLeaseToken } from '#root/domain/claim'
import { DomainError, isDomainError } from '#root/domain/errors'
import type { TaskStatus } from '#root/domain/task'
import type { ActorContext, Clock, IdGen, UnitOfWork } from '#root/application/ports'

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
    private readonly clock: Clock,
    private readonly ids: IdGen // D-cc: the loser inbox copy needs an id
  ) {}

  async run(input: ClaimTaskInput): Promise<ClaimResult> {
    const now = this.clock.now().toISOString()
    if (!input.tokenId) {
      throw new DomainError('invalid_request', 'claiming requires an authenticated token')
    }
    // Typecheck deviation (sanctioned, inherited): input.tokenId loses its null-guard
    // narrowing inside the transaction closure — capture the narrowed string here.
    const tokenId = input.tokenId
    try {
      return await this.uow.withTransaction(async (repos) => {
        const task = await repos.tasks.findById(input.taskId)
        if (!task) throw new DomainError('not_found', `task ${input.taskId} not found`)
        if (task.status === 'canceled') {
          throw new DomainError('canceled_terminal', `task ${input.taskId} is canceled`)
        }
        if (task.status !== 'todo' && task.status !== 'in_progress') {
          throw new DomainError(
            'invalid_request',
            `task in status '${task.status}' is not claimable`
          )
        }
        // Invariant 1 / D6: leaf-claim
        if (await repos.tasks.hasChildren(input.taskId)) {
          throw new DomainError('not_a_leaf', 'work happens on leaves; claim a child instead')
        }

        const alreadyClaimed = async (): Promise<DomainError> => {
          // ora-14 M-1 (inherited): FRESH re-read — after a lost CAS the current row is
          // the truth about who holds the claim today.
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
        const result = await repos.tasks.tryClaim(task.id, tokenId, input.actor.id, newStatus, now)
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
    } catch (e) {
      // D-cc: the race loser's async copy (deferred by D-r until wake paths existed —
      // webhooks shipped them). It MUST ride a SECOND transaction: the first one just
      // rolled back, so writing inside it is writing nothing. Rethrow is byte-exact:
      // the 409 contract (code + holder details) is unchanged for synchronous callers.
      if (isDomainError(e) && e.code === 'already_claimed' && !selfReclaim(input.actor.handle, e)) {
        await this.uow.withTransaction(async (repos) => {
          await repos.inbox.add({
            id: this.ids.newId('ib'),
            actor_id: input.actor.id,
            kind: 'claim_conflict',
            task_id: input.taskId,
            thread_id: null,
            created_at: now,
          })
        })
      }
      throw e
    }
  }
}

/** D-cc guard: a holder retrying its OWN claimed task must not spam its inbox — the
 *  synchronous 409 already tells it exactly that. Handle-identity, not id: the 409's
 *  details carry the holder's PUBLIC handle vocabulary (ora-14 M-1 shape unchanged). */
const selfReclaim = (handle: string, e: DomainError): boolean => e.details?.holder_handle === handle
```

**Required wiring:** `deps.ts` line 118 becomes `claimTask: new ClaimTask(uow, clock, ids)`. Existing use-case tests construct `new ClaimTask(uow, fixedClock(), new RandomIdGen())`.

**Honest edge note (pinned in review, not in code):** if the CAS loser's _own_ handle collides with the holder's handle the guard skips — impossible (handles are unique, DDL-pinned). A holder whose token was deleted mid-race yields `holder_handle: null ≠ handle` ⇒ inbox written — correct (the loser genuinely lost to an unknown holder; the async copy is the courtesy).

- [ ] **Step 4: Gate + commit**

Run: `pnpm test && pnpm lint && pnpm typecheck` — green (existing 409 pins prove the rethrow unchanged).

```bash
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -am "feat(app): claim_conflict inbox copy for race losers (D-cc)"
```

---

## Task 15: Acceptance story — event feed + webhook delivery end-to-end (spec §11 "webhook delivery + event cursor replay")

**Files:**

- Create: `src/adapters/rest/scenarios-events.test.ts`

Follows the scenarios-file convention: one numbered `// §`-commented story, helper closures up top, lower-bound counts only, machine strings grep-exact.

- [ ] **Step 1: Write the story** — create `src/adapters/rest/scenarios-events.test.ts`

```ts
import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeTestApp } from '#root/testing/test-app'

// acceptance (spec §11.2 "webhook delivery + event cursor replay") — the Plan C story,
// on the REAL surface: real fastify, real sqlite, real node:http receiver. One receiver
// server serves BOTH runner callbacks; a per-path queue programs responses.

type Received = { body: string; sig?: string }

describe('acceptance — events & webhooks (spec §6.8/§11): a runner wakes on its work, not on history', () => {
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` })
  let receiver: ReturnType<typeof createServer>
  let inbox: Record<string, Received[]>
  let failOnce: Record<string, boolean>
  let base: string

  beforeAll(async () => {
    inbox = {}
    failOnce = {}
    receiver = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const path = req.url ?? ''
        const key = path.slice(1)
        const body = Buffer.concat(chunks).toString('utf8')
        ;(inbox[key] ??= []).push({
          body,
          sig: req.headers['x-nightshift-signature'] as string | undefined,
        })
        if (failOnce[key]) {
          failOnce[key] = false
          res.writeHead(503).end()
          return
        }
        res.writeHead(200).end()
      })
    })
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise((r) => receiver.close(r))
  })

  it('full story: register, tail, race, wake, retry', async () => {
    const t = await makeTestApp()
    const mkAgent = async (handle: string) => {
      const a = await t.app.inject({
        method: 'POST',
        url: '/admin/actors',
        headers: bearer(t.adminToken),
        payload: { kind: 'agent', handle, display_name: handle },
      })
      const tok = await t.app.inject({
        method: 'POST',
        url: `/admin/actors/${a.json().id}/tokens`,
        headers: bearer(t.adminToken),
        payload: { label: 'story' },
      })
      return { id: a.json().id as string, token: tok.json().raw_token as string }
    }

    // §6.8.1 human files work; a runner registers its wake path AFTER the backlog exists
    const todoTask = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: bearer(t.adminToken),
      payload: { title: 'wake-story task', status: 'todo' },
    })
    expect(todoTask.statusCode).toBe(201)
    const hermes = await mkAgent('hermes-evt')
    const wh = await t.app.inject({
      method: 'POST',
      url: '/admin/webhooks',
      headers: bearer(t.adminToken),
      payload: { agent_id: hermes.id, url: `${base}/hermes` },
    })
    expect(wh.statusCode).toBe(201)
    const hermesSecret = wh.json().secret as string
    const watermark = wh.json().delivered_cursor as number

    // §6.8.2 the cursor feed serves the backlog the webhook refused to replay
    const feed = (
      await t.app.inject({
        method: 'GET',
        url: `/events?cursor=0&limit=500`,
        headers: bearer(t.adminToken),
      })
    ).json()
    expect(feed.length).toBeGreaterThanOrEqual(2) // lower bound only (binding)
    expect(feed.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(['task_created', 'webhook_created'])
    )
    for (let i = 1; i < feed.length; i++) expect(feed[i].cursor).toBeGreaterThan(feed[i - 1].cursor)
    expect(feed[feed.length - 1].cursor).toBe(watermark) // the watermark IS the feed head

    // §6.8.3 a race: hermes wins, bilbo loses and gets the inbox copy (D-cc) — and the
    // loser's claim_conflict must NOT spam the webhook with undeliverable history
    const bilbo = await mkAgent('bilbo-evt')
    const claimed = await t.app.inject({
      method: 'POST',
      url: `/tasks/${todoTask.json().id}/claim`,
      headers: bearer(hermes.token),
    })
    expect(claimed.statusCode).toBe(200)
    const lost = await t.app.inject({
      method: 'POST',
      url: `/tasks/${todoTask.json().id}/claim`,
      headers: bearer(bilbo.token),
    })
    expect(lost.statusCode).toBe(409)
    expect(lost.json().code).toBe('already_claimed')
    const loserInbox = (
      await t.app.inject({ method: 'GET', url: '/inbox', headers: bearer(bilbo.token) })
    ).json()
    expect(loserInbox.map((i: { kind: string }) => i.kind)).toEqual(['claim_conflict']) // hermes-1 claim ⇒ bilbo's copy, grep-exact kind

    // §6.8.4 the loop wakes hermes for everything AFTER its registration anchor
    await t.deps.deliveryLoop.tick(1_000)
    const received = inbox['hermes'] ?? []
    const events = received.map(
      (r) => JSON.parse(r.body) as { event: string; task_id: string | null; cursor: number }
    )
    // all-events posture (D-bb): every audit-worthy row past the checkpoint wakes every
    // runner — bilbo's registration audits ride too; filtering is deferred
    expect(events.map((e) => e.event)).toEqual(['actor_created', 'token_created', 'claim_acquired'])
    const claimEvent = events.find((e) => e.event === 'claim_acquired')!
    expect(claimEvent.task_id).toBe(todoTask.json().id)
    expect(claimEvent.cursor).toBeGreaterThan(watermark)
    for (const r of received) {
      expect(r.sig).toBe(
        `sha256=${createHmac('sha256', hermesSecret).update(r.body).digest('hex')}`
      )
    }

    // §6.8.5 best-effort retry: a dead-first-try callback parks, then drains the SAME
    // event — at-least-once, in action
    failOnce['bob'] = true
    const bob = await mkAgent('bob-evt')
    const whBob = await t.app.inject({
      method: 'POST',
      url: '/admin/webhooks',
      headers: bearer(t.adminToken),
      payload: { agent_id: bob.id, url: `${base}/bob` },
    })
    const bobWatermark = whBob.json().delivered_cursor as number
    const bobId = whBob.json().id as string
    const bobTask = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: bearer(bob.token),
      payload: { title: 'bobs own', status: 'todo' },
    })
    await t.deps.deliveryLoop.tick(2_000) // try + 503 ⇒ parked until 2_000 + 1_000·2^1
    expect((await t.deps.webhooksRoot.listDue(3_999)).map((w) => w.id)).not.toContain(bobId) // parked
    expect((await t.deps.webhooksRoot.listDue(4_000)).map((w) => w.id)).toContain(bobId) // due again at the park horizon
    await t.deps.deliveryLoop.tick(4_000) // retry ⇒ ACK
    const bobPosts = (inbox['bob'] ?? []).map(
      (r) => JSON.parse(r.body) as { event: string; task_id: string | null; cursor: number }
    )
    expect(bobPosts.map((e) => e.cursor)).toEqual([bobWatermark + 1, bobWatermark + 1]) // failed attempt + ACK share ONE cursor — the consumer dedupes on it
    expect(bobPosts[0].event).toBe('task_created')
    expect(bobPosts[0].task_id).toBe(bobTask.json().id)
    expect((await t.deps.webhooksRoot.find(bobId))?.delivered_cursor).toBe(bobWatermark + 1)

    // §6.8.6 tail-to-head: an agent caught up receives nothing more
    const head = (
      await t.app.inject({
        method: 'GET',
        url: `/events?cursor=0&limit=500`,
        headers: bearer(t.adminToken),
      })
    ).json()
    const tail = (
      await t.app.inject({
        method: 'GET',
        url: `/events?cursor=${head[head.length - 1].cursor}`,
        headers: bearer(t.adminToken),
      })
    ).json()
    expect(tail).toEqual([])
    await t.close()
  })
})
```

- [ ] **Step 2: Run to verify it fails first**

Run: `pnpm test src/adapters/rest/scenarios-events.test.ts` — Expected: RED is NOT available for this story (every unit it leans on shipped green in Tasks 9-14; per the honesty clause: no RED phase is claimed and none is invented). It must run GREEN on first execution; if it does not, that is a bug in the shipped units — fix the unit, not the story.

- [ ] **Step 3: Full gate + commit**

Run: `pnpm test && pnpm lint && pnpm typecheck` — green.

```bash
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -am "test(acceptance): event feed + webhook wake story (spec §11.2)"
```

---

## Task 16: Backlog micro — admin kind enum from a domain const; links import merge

**Files:**

- Modify: `src/domain/task.ts:11`
- Modify: `src/adapters/rest/routes/admin.ts:4,27`
- Modify: `src/adapters/rest/routes/links.ts:3-4`

Zero behavior change (the drift test only pins TaskStatus + Problem.code; Actor.kind enum is not drift-pinned — the yaml keeps its literal `enum: [human, agent]`, unchanged bytes).

- [ ] **Step 1: Domain const tuple** — `src/domain/task.ts`, replace :11:

```ts
export const ACTOR_KINDS = ['human', 'agent'] as const
export type ActorKind = (typeof ACTOR_KINDS)[number] // identical union to the prior hand-written type
```

- [ ] **Step 2: Admin route derives** — `routes/admin.ts`: add value import `import { ACTOR_KINDS } from '#root/domain/task'` (the `import type { ActorKind }` line keeps its type import); :27 becomes:

```ts
            kind: { type: 'string', enum: ACTOR_KINDS },
```

- [ ] **Step 3: Links import merge (the review-ruled nit)** — `routes/links.ts:3-4` become one line:

```ts
import { LINK_KINDS, type LinkKind } from '#root/domain/discussion'
```

(If eslint/prettier ships it byte-different — e.g. separate lines re-wrapped — the amendment protocol applies; zero behavior either way.)

- [ ] **Step 4: Gate + commit**

Run: `pnpm test && pnpm lint && pnpm typecheck` — green (coverage: `ACTOR_KINDS` line is import-covered in domain — domain 100 holds).

```bash
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -am "chore(api): derive admin kind enum; merge links import"
```

---

## Task 17: Final whole-plan gate + record

- [ ] **Step 1: Full gate**

Run: `pnpm test:coverage && pnpm lint && pnpm typecheck && pnpm build`
Expected: all green; `src/domain/**` still 100; global ≥85. Any newly uncovered arm must be an ENGINEERED-OUT arm or join the documented-untestable list with a one-line justification (T14 lineage: reachability honesty, not new pins).

- [ ] **Step 2: Append the final gate record** to this file's "Status & provenance" → Baseline line: date, `<N> tests; Stmts/Branch/Funcs/Lines`, and the documented-untestable additions (expected: the FTS delete-trigger arm — no task-delete path exists; the loop's `start()` interval body — driven via `tick()` in tests, the timer itself exercised only in production; both declared, neither pinned).

- [ ] **Step 3: Commit**

```bash
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -am "docs(plan): plan C final gate record"
```

- [ ] **Step 4: Stop. Report to @tyriis.** No push, no merge, no PR (binding).

---

## Execution handoff

**Plan complete — two execution options:**

1. **Subagent-Driven (recommended)** — fresh implementer subagent per task, strict serial (shared wiring in `ports.ts`/`migrations.ts`/`deps.ts`/`app.ts` forbids parallel lanes), independent spec + quality review before advancing, fix rounds re-verified, amendments byte-synced.
2. **Inline Execution** — executing-plans, batch with checkpoints.

Either way: the working agreements at the top of this file are part of every task, not suggestions.
