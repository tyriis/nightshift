# Plan G: Brotli Shell-Cache Fix & Keepalive Enforcement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close Plan F's recorded brotli shell-cache finding with a ruling-logged `ui.ts` fix + in-suite negotiating arms + the deploy-smoke gate flip (22/1 → 23/0), and ship the §12 keepalive-enforcement slice: a dormant-by-default sweeper that expires silent claims atomically with the audit reason spec §6.7 pre-named, fencing zombies on the EXISTING 412 `stale_lease`, plus a `nightshift heartbeat` CLI leg.

**Architecture:** Zero new dependencies, zero new tables, zero new error codes. The brotli act edits one `setHeaders` predicate (`src/adapters/rest/ui.ts`) and adds test arms. The keepalive act adds two dormant env flags, two CAS primitives on `SqliteTaskRepo`, one loop class shaped on `WebhookDeliveryLoop` (kill-switch `start()`, injectable-`now` `tick()` seam, `unref`'d timer, drain-on-`stop()`), and one CLI command. Lease state already lives on the `tasks` row (`claim_token_id`/`claim_generation`/`last_heartbeat_at` — `schema.ts:41-43`); expiry rides those columns, audit lands on the spine that already feeds `/events` and webhooks (D-aa), and every post-revert zombie write is rejected by the invariant-3 fence already shipped in `update-status.ts`/`heartbeat.ts`/`release-claim.ts`.

**Tech Stack:** inherited A–F stack (fastify 5 + @fastify/static 10.1.3, Kysely 0.29.5/better-sqlite3, zod 4, vitest 4.1.x — pin ^4.1.5, probed at 4.1.11); no new deps of ANY kind.

---

## Status & branch (verified 2026-09-10)

- Baseline: `main` = `5fab97f` (Plan F merge; PR #12). Gate bar inherited: `pnpm test` **674 / 88**; coverage **99.52 / 98.52 / 99.78 / 99.70** (floor — every axis never-lower); `src/domain/**` 100×4; lint/typecheck/build/ui:build/offline-check clean; deploy-smoke ship-recorded **22 PASS / 1 recorded-FAIL** (the brotli arm — Task 8 flips it).
- Branch: **`feature/plan-g-brotli-keepalive` branches from `main` @ `5fab97f` only** (this ticket's G-gate — confirmed 2026-09-10; re-confirm at execution start before ANY work).
- Ticket: resolves #13. **NEVER merge — merges are @tyriis personally (binding).**

## Pre-dispatch amendment ledger (plan-review + artifact preflight)

Per the ticket protocol and the A–F binding lessons ("treat your own plan as untrusted input"; "policies decay, tools don't"; "preflight probes run against STATEFUL servers, not fresh fixtures"), BEFORE any implementer dispatch: (1) an independent plan-review lane (PASS/FAIL; FAIL ⇒ revisions logged here); (2) the machine artifact-preflight extracting and compiling EVERY embedded block against the pinned deps, PLUS the live probes P1–P10 below. Results land here as amendments BEFORE Task 1 dispatch.

- **P1 — brotli hazard LIVE reproduction** (stateful, per F's lesson): boot the CURRENT (unfixed) built UI behind a REAL `app.listen` server; `fetch('/ui/', {headers:{'accept-encoding':'br'}})` ⇒ expect `content-encoding: br` + `cache-control: public, max-age=2592000, immutable` (the recorded hazard reproduced on the pinned deps — the fix target).
- **P2 — inject-negotiation parity:** `t.app.inject({ url:'/ui/', headers:{'accept-encoding':'br'} })` answers `content-encoding: br` (U3 lineage re-verified against @fastify/static 10.1.3) and shows the SAME wrong 30d cache-control — so the in-suite arms see the hazard too. If inject normalizes differently, the D-fff ruling re-anchors on P1 and the arms move to the mcp-parity `app.listen({port:0})` pattern.
- **P3 — build-tree variant-extension probe:** `find adapters/sveltekit/build -name '*.br' -o -name '*.gz' -o -name '*.deflate'` ⇒ the fix regex covers EXACTLY the emitted set (adapter-static precompress emits br+gz; `.deflate` must be absent or the regex widens — decide from the probe, not from this line).
- **P4 — sweep-SQL probe on a stateful db:** seed claim/heartbeat/canceled/legacy-NULL-anchor rows through the REAL repo paths, then run `listStaleClaims`/`expireStaleClaim` (bodies from Task 3): ISO-string `<` comparison against `coalesce(last_heartbeat_at, updated_at)` is lexicographically correct for the stored UTC format; `UPDATE … RETURNING` with a raw-sql `where` expression compiles on Kysely 0.29.5; a racing `setHeartbeat` defeats the CAS (honest miss).
- **P5 — config superRefine matrix probe:** all five loadConfig cases (dormant / half-open ×2 / timeout<tick / enabled pair) against pinned zod 4.
- **P6 — audit-attribution probe (the `!` trust-cast arm):** claim a task with an agent token, REVOKE the token (verify `revokeToken` does not clear the claim), then `findActorByTokenId` must still resolve the holder row (FK `claim_token_id → tokens.id → actors.id`, FKs measured ON per F's lesson); this is what licenses the `!` in the sweeper's audit append.
- **P7 — regen-delta probe:** on a scratch copy, edit the heartbeat `description` line and run `pnpm gen:client`; the `schema.d.ts` delta must be JSDoc-comment-only (proves the D-kkk sanctioned-delta size).
- **P8 — CLI exact-set probe:** apply the Task-5 `run.ts` delta to a scratch copy and run `src/cli/cli.test.ts` + `src/cli/shim.test.ts` unchanged — no hidden COMMANDS-set/USAGE pins may RED (unknown-command/`help` pins are regex-loose and must stay green).
- **P9 — sweeper-vs-suite probe:** with the new `leaseSweeper` in `AppDeps`, `makeTestApp` defaults keep it inert (`start()` refuses on 0/0) — run the FULL suite once with the wiring applied and no sweeper tests; zero new flakes, zero stray timers.
- **P10 — coverage-ghost analysis (enumerated at preflight, all covered):** sweeper start-refusal ×2 (dormant-pair test) · start-armed face + `isRunning` (armed-failing-timer test + drain test) · `stop()` TRUE arm (drain test) + FALSE never-started arm (dormant test gained `await s.stop()`) · timer callback FUNCTION + `Date.now()` default-param + `.catch` SWALLOW arm (armed-failing-timer test with a scripted rejecting UoW) · overlap early-return (identity-proof test) · `continue` on CAS miss (scripted honest-miss test) · config superRefine ×3 (matrix test) · `ui.ts` regex match/nomatch × html/asset (U1/U9/U9b/U10) · CLI local-config-error + arity + hf-miss (the four D-jjj arms). No statically uncoverable branch survives (Plan D "prove it, not document it").

### Plan-review lane — VERDICT: PASS (attempt 1, 2026-09-10, independent oracle)

Verbatim highlights: every embedded block verified compile-plausible against current source; `ui.ts:45-47` anchor byte-exact; U3 (:96-97) grounds the D-fff inject-negotiation argument; `sendFile` (ui.ts:55) routes through the SAME `pumpSendToReply` (static index.js:105-112, opts merged :252) — U9b's gz-fallback RED is structurally real; zombie heartbeat/status/release all throw `stale_lease`→412 with zero use-case change; Problem-code enum untouched; no cheat path on the 23/0 flip (the smoke's `/ui/` call sends no explicit `accept-encoding`; undici auto-negotiates br); D-fff genuinely closes the `d95dab4`/Task-6 owner follow-up; §12 realized with the env-pair deviation OWNED; no coverage ghosts found; scope: every #13 deliverable owned, nothing smuggled.

Advisories A1–A4 applied as sanctions in this wave (non-blocking):

- **A1:** Task 5 Step 4 now re-derives ALL `run.ts:N` citations in deploy/README.md (whole-file grep), not only the usage block.
- **A2:** Task 3 Step 5 corrected — the test fakes reach the seams via `as unknown as Repos` casts (claim-task.test.ts:256, update-status.test.ts:461), so typecheck will NOT red and fakes widen: the expected commit-body truth is "none (cast seams)".
- **A3:** Task 8 Step 1 `sed` span corrected to :73-77 (the no-cache check itself).
- **A4:** Task 2 Step 3(2) placement wording — "inside the callback, before its closing `})`".

### Artifact preflight — VERDICT: PREFLIGHT: PASS (2026-09-10, throwaway worktree @ 90a9ffb)

Pinned env (node 24.20.0 / @fastify/static 10.1.3 / Kysely 0.29.5 / zod 4.5.4 / vitest 4.1.11). Key verbatims: **P1** live LISTEN reproduction — br → `public, max-age=2592000, immutable`, identity → `no-cache` (hazard REAL); **P2** inject honors explicit accept-encoding (in-suite arms valid, no mcp-parity relocation needed) + with the Task-1 fix applied: shell/fallback → `no-cache`, asset → 30d, ui.test 11/11; **EXTRA FINDING:** the gzip fallback leaked 30d pre-fix too (smoke never probed it) — the shipped fallback comment is a lie (⇒ Task 1 Step 3b, U9b pins it); **P3** build emits exactly {br×8, gz×8}, zero `.deflate` — regex covers exactly; **P4** Kysely CAS compiles+runs, ISO-UTC lexicographic `<` byte-exact, canceled never listed, claim stamp round-trips — ONE forced test fix (cutoff 01-07 → 01-05, applied); **P5** all five config cases + treeify shape pinned; **P6** `revokeToken` does NOT clear claims, `findActorByTokenId` unfiltered by revoked ⇒ the sweeper `!` is LICENSED; sweeper 7/7 with wiring; **P7** regen delta = 1 JSDoc line; **P8** cli+shim 28/28 with the delta, usage span measured 42-44; **P9** full suite 684/88 with wiring, timer-inert, typecheck clean; 691/89 with the sweeper tests; **P10** ghosts: timer callback/default-param/swallow/stop-false — FORCED two arms, applied above (dormant-test stop() + armed-failing-timer). Amendments 1/3/4/5/6 applied in this commit; A2 confirmed aligned upstream. **No probe weakened; dispatch may proceed.**

## Decision records (Plan G — `D-fff … D-lll`; triples continue from F; `D-uu` stays dead)

Grep duty: the triples CONTAIN earlier pairs (`D-ff` ⊂ `D-fff`) — every ledger citation is whole-token.

- **D-fff — Brotli shell-cache fix (the ruling-logged delta into E's byte-pinned surface).** Ruling: `setHeaders` strips a trailing preCompressed encoding extension (`.br`/`.gz`) before the `.html` check, so every shell spelling answers `no-cache` while hashed assets keep the 30d immutable posture. Probe-based, not guess-based (P1/P2/P3): @fastify/static 10.1.3 hands `setHeaders` the VARIANT path (`index.js:289-308` builds `pathname + '.br'`; `:442` passes it as `metadata.path`) — exactly why E's `.endsWith('.html')` missed it and the plugin default reached the wire. The sanctioned delta names BOTH pinned files: `ui.ts` (the predicate) and `ui.test.ts` (ADDITIVE only — new arms `U9`/`U9b`/`U10`; `U1–U4`, `U5`, `U6–U8` byte-untouched; `U3`'s br-asset assertion byte-untouched, and it is U3 that PROVES inject honors an explicit `accept-encoding`). "LIVE arm" honesty: the in-suite arms negotiate explicitly (proven-negotiating `inject` — no socket opens, E's zero-socket posture holds); the TRUE live encoding-negotiating leg is the deploy-smoke gate flip in Task 8 (undici auto-negotiates br against the real image) — the plan ships both legs and the record says which is which.
- **D-ggg — Keepalive config: dormant by default, fail-closed when opened.** Two env flags on the `NS_WEBHOOK_INTERVAL_MS` precedent: `NS_KEEPALIVE_INTERVAL_MS` (sweeper tick; `0` = never starts) and `NS_KEEPALIVE_TIMEOUT_S` (silence budget; `0` = claims never expire). BOTH default `0` — enforcement OFF, every existing deployment byte-unchanged (D-pp dormant precedent). Enabling either without the other, or a timeout shorter than the tick, fails the boot (`invalid env` throw, exit 1) — half-configured enforcement is worse than none (D-qq precedent). WHY default-off is the honest posture: heartbeats today ride only MCP `post_update` + explicit calls; the CLI/agent cohort that never heartbeats would have claims reverted under an upgrade that never asked. Operator opts in per `deploy/README.md`. The §12 sketch "lease carries interval + timeout" is realized as the server-side pair APPLIED to the lease — NOT as response fields (D-kkk zero-contract ruling); `last_heartbeat_at` is already public on every Task DTO, so a holder can always compute its own margin.

- **D-hhh — Repo primitives: claim = first liveness; expiry = guarded CAS.** (a) `tryClaim` stamps `last_heartbeat_at` inside the claim CAS itself (the claim IS a liveness signal; amendment recorded here against B/C's pinned claim arms — the claim HTTP response is `{lease_token, generation}`, NOT a Task DTO, so no pinned response arm changes; heartbeat/model arms assert post-heartbeat values and stay green — P4 re-verifies). (b) `listStaleClaims` + `expireStaleClaim` follow `tryClaim`'s single-statement `UPDATE … RETURNING` CAS shape; staleness = `coalesce(last_heartbeat_at, updated_at) < cutoff` on `claim_token_id IS NOT NULL AND status = 'in_progress'` — the coalesce carries pre-G claims (NULL anchor) honestly on their `updated_at` (claim time, when untouched); the `in_progress`-only guard respects `canceled`-terminal (a pre-existing quirk: the cancel path does not clear claims — the sweeper NEVER touches it, QUEUED) and never reverts review/done states. The staleness predicate is RE-CHECKED inside the expiry UPDATE, so a heartbeat landing between the sweep read and the sweep write is an honest MISS, never a false revert.
- **D-iii — The sweeper loop.** `src/infra/keepalive/lease-sweeper.ts`, shaped on `WebhookDeliveryLoop` (kill-switch `start()`, overlap-guarded `tick(nowMs = Date.now())` seam per T14 lineage, `unref`'d interval, `stop()` drains) with ONE stated divergence: the sweeper HOLDS a transaction per sweep — the loop-no-UoW clause exists because of NETWORK I/O; the sweep is pure DB, so revert+audit land ATOMICALLY (audit is the system's memory — spec §6.7 — and the outbox feeding `/events` + webhooks: one write, one truth). Audit vocabulary is NEW and grep-pinned: action `lease_expired`, reason exactly `lease expired` — the reason spec §6.7 pre-named ("including 'claim released by split', 'lease expired' later" — later is now). Attribution honesty: actor = the token's holder (`findActorByTokenId`, P6 licenses the `!`), token = the dying claim — the row answers WHOSE lease died; the reason answers what happened. Zombie fencing adds ZERO code: the generation bump rides the shipped `stale_lease` 412 arms (`update-status.ts:42-56`, `heartbeat.ts:30-34`, `release-claim.ts:23-27`) — no new error code ⇒ the Problem-code enum pins stay byte-green. `heartbeat.ts:11`'s doc-comment ("no keepalive enforcement in v1") is amended with lineage in the same wave.
- **D-jjj — CLI `heartbeat` command.** `COMMANDS` grows to `next|claim|heartbeat|report` (exact set, lockstep — dispatch, USAGE, README mirror, arms, all in one commit). `heartbeat <task-id>` requires `NS_LEASE_TOKEN`: its absence is a LOCAL `config_error` (exit 2, NOTHING sent — the D-aaa ladder, never a server round-trip); on the wire it rides the EXISTING `POST /tasks/{id}/heartbeat` op (zero contract change) and prints the server's Task DTO (D-aaa: the DTO IS the truth). The USAGE edit is string-content-only (3 lines stay 3 lines) BUT the `COMMANDS` insertion shifts `run.ts` line numbers — deploy/README's verbatim-usage-block citation (`run.ts:41-43`, P8 measured: lands at `42-44` post-delta) is RE-DERIVED against the final file in the same commit (docs-mirror duty: grep, never guess).
- **D-kkk — Contract: ONE description flip, ZERO shape change.** `openapi.yaml` heartbeat op: `description: liveness record only; keepalive enforcement is deferred (spec §12)` becomes the shipped truth; `pnpm gen:client` regen lands IN THE SAME COMMIT (D-zz duty). Paths×methods, schemas, required-sets, the Problem-code enum — byte-untouched (no new code; P7 proves the regen delta is JSDoc-only). SPEC STAYS FROZEN: §3's non-goal line and §7.2's heartbeat row go stale exactly as §12's CLI row went stale when F shipped the CLI — the F precedent is binding: §12 migration is recorded in plan docs, never by editing the frozen spec.
- **D-lll — Deploy surface: re-derived citations + the keepalive section.** `deploy/README.md`: the NS\_\* table grows two rows (defaults/rules copied from the FINAL `config.ts`); the "Transcribed from `config.ts:5-34`" and `config.ts:39-56` citations are re-derived against the final file (grep the real bounds — machine strings point at truth or drift); a short `## Keepalive (Plan G)` section carries the enable pair, what expiry looks like, and the copy-pasteable heartbeat/expiry operator legs. `DEPLOY-SMOKE.md` §3 gains the `heartbeat` CLI arm; the §1 known-RED note stays UNTOUCHED until Task 8's live 23/0 evidence exists (flip with lineage, never before).
- **QUEUED (HUMAN / follow-up, honest):** cancel-leaves-claim-attached quirk (sweeper respects it; clearing on cancel is a behavior change for its own wave) · per-lease `interval`/`timeout` echoed into the claim response (would be a real contract ruling) · UI staleness surfacing (`last_heartbeat_at` already public) · F's unchanged ledger (real Pocket ID, nonce verify-once, role surgery, session-key rotation, CSP, npm publish).

## Inherited duties (every task, unchanged)

One taxonomy map; machine strings grep-pinned + README-mirrored; `PUBLIC_PATHS`/exact-sets never widened silently; D-ff secrets env-only; MCP frozen at 35 (`mount.test.ts` byte-untouched — this plan adds NO MCP tool); `openapi/openapi.yaml` byte-untouched EXCEPT D-kkk's single description line; `pnpm-lock.yaml` byte-untouched; `ci.yaml` byte-untouched (D-xx); `vitest.config.ts` byte-untouched; toolchain-boundary: `scripts/`/`bin/`/`deploy/` gates are EXECUTION not unit-suite; ≤72-char subjects; `LEFTHOOK_CONFIG=$PWD/lefthook.yaml`; raw-git verify every commit (`git log --format='%h %s'` against `origin/main..HEAD`, no phantom hashes); honest REDs before greens; coverage never lowered; serial gates: fresh implementer per task, spec-compliance review THEN code-quality review, PASS before next dispatch; NEVER merge.

## File structure

| File                                                | Change                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `src/adapters/rest/ui.ts`                           | D-fff: `setHeaders` encoding-aware predicate                                                     |
| `src/adapters/rest/ui.test.ts`                      | D-fff: ADDITIVE `U9`/`U9b`/`U10` arms                                                            |
| `src/main/config.ts` + `config.test.ts`             | D-ggg: the dormant pair + fail-closed matrix                                                     |
| `src/application/ports.ts`                          | D-hhh: `StaleClaimRow` + 2 `TaskRepo` members                                                    |
| `src/infra/sqlite/task-repo.ts` + `.test.ts`        | D-hhh: claim stamp + sweep CAS primitives                                                        |
| `src/infra/keepalive/lease-sweeper.ts` + `.test.ts` | D-iii: the loop (NEW)                                                                            |
| `src/main/deps.ts`, `src/index.ts`                  | D-iii: construct-not-started + start/stop                                                        |
| `src/application/usecases/heartbeat.ts`             | D-iii: doc-comment amendment (line 11 only)                                                      |
| `src/cli/run.ts` + `cli.test.ts`                    | D-jjj: `heartbeat` command + arms                                                                |
| `openapi/openapi.yaml`, `src/client/schema.d.ts`    | D-kkk: description + regen, same commit                                                          |
| `deploy/README.md`, `deploy/DEPLOY-SMOKE.md`        | D-lll: table/section/arms; Task 8 flips the RED note                                             |
| `scripts/deploy-smoke.mjs`                          | NO CHANGE (verified Task 8 Step 0 — the arm already asserts no-cache; undici auto-negotiates br) |

---

### Task 1: Brotli shell-cache fix (D-fff)

**Files:**

- Modify: `src/adapters/rest/ui.ts` (the `setHeaders` callback)
- Modify: `src/adapters/rest/ui.test.ts` (ADDITIVE new describe at EOF)

- [ ] **Step 1: Write the failing arms.** Append at the END of `src/adapters/rest/ui.test.ts` (file-level helpers `BUILD`, `BUILD_DIR`, `uiApp` and the `readdirSync`/`join` imports already exist — do NOT re-import):

```ts
// D-fff — the deploy-smoke hazard, pinned in-suite. inject negotiates NOTHING
// implicitly (the U1-U4 blindness, Plan F's recorded lesson), but U3 PROVED it
// honors an explicit accept-encoding — so these arms send the header a browser
// or node fetch sends by default and finally see the preCompressed variant path.
describe('ui shell cache under explicit br/gz negotiation (D-fff)', () => {
  it.skipIf(!BUILD)(
    'U9 GET /ui/ with accept-encoding: br — the shell, br-encoded, STILL no-cache',
    async () => {
      const t = await uiApp()
      const res = await t.app.inject({
        method: 'GET',
        url: '/ui/',
        headers: { 'accept-encoding': 'br' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-encoding']).toBe('br')
      expect(res.headers['cache-control']).toBe('no-cache')
      await t.close()
    }
  )

  it.skipIf(!BUILD)(
    'U9b gzip deep-link rides the fallback: the shell, gz-encoded, no-cache (the fallback hazard the smoke never probed)',
    async () => {
      const t = await uiApp()
      const res = await t.app.inject({
        method: 'GET',
        url: '/ui/tasks/NS-1',
        headers: { 'accept-encoding': 'gzip' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toContain('text/html')
      expect(res.headers['content-encoding']).toBe('gzip')
      expect(res.headers['cache-control']).toBe('no-cache')
      await t.close()
    }
  )

  it.skipIf(!BUILD)(
    'U10 hashed asset under br keeps the 30d immutable posture (the fix is shell-scoped)',
    async () => {
      const t = await uiApp()
      const asset = readdirSync(join(BUILD_DIR, '_app', 'immutable', 'entry')).find(
        (f) => !f.endsWith('.br') && !f.endsWith('.gz')
      )!
      const res = await t.app.inject({
        method: 'GET',
        url: `/ui/_app/immutable/entry/${asset}`,
        headers: { 'accept-encoding': 'br' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-encoding']).toBe('br')
      expect(res.headers['cache-control']).toBe('public, max-age=2592000, immutable')
      await t.close()
    }
  )
})
```

- [ ] **Step 2: Run to see the honest RED.** `pnpm vitest run src/adapters/rest/ui.test.ts` (requires `pnpm ui:build` first if arms skip). Expected: **U9 and U9b FAIL** with `expected 'public, max-age=2592000, immutable' to be 'no-cache'` (the recorded hazard measured in-suite); **U10 PASSES pre-fix** — declared the posture-preservation arm (reds only if the fix over-widens). U1–U8 stay green.
- [ ] **Step 3: Apply the fix.** In `src/adapters/rest/ui.ts` replace exactly:

```ts
        setHeaders(reply, path) {
          if (path.endsWith('.html')) reply.header('cache-control', 'no-cache')
        },
```

with:

```ts
        setHeaders(reply, path) {
          // D-fff (Plan G): with preCompressed the plugin hands this callback the
          // VARIANT path (…/index.html.br — @fastify/static 10.1.3 index.js:289-308
          // builds it, :442 passes metadata.path), so the bare .html check MISSED
          // it and the 30d-immutable plugin default reached the wire: the recorded
          // deploy-smoke FAIL. Strip the encoding extension first — every shell
          // spelling answers no-cache; hashed assets keep 30d either way.
          const logicalPath = path.replace(/\.(?:br|gz)$/, '')
          if (logicalPath.endsWith('.html')) reply.header('cache-control', 'no-cache')
        },
```

- [ ] **Step 3b: Replace the stale fallback comment (P2 FORCED).** P2 measured the old comment's claim FALSE pre-fix (sendFile re-applied the plugin 30d default OVER the explicit header under negotiation — exactly the U9b hazard). In the scope notFound, replace exactly:

```ts
// html arm: no-cache via setHeaders is route-path-based; the explicit
// header wins for the fallback (sendFile ships the 30d plugin default)
```

with:

```ts
// D-fff honesty (P2 measured): the old comment here claimed the
// explicit header "wins for the fallback" — FALSE under encoding
// negotiation, where sendFile re-applied the plugin 30d default over
// it (the second, smoke-unprobed face of the hazard — U9b pins it).
// Post-fix the re-pinned setHeaders answers no-cache for every
// variant; the explicit header stays belt-and-braces for the plain path.
```

- [ ] **Step 4: Verify GREEN.** `pnpm vitest run src/adapters/rest/ui.test.ts` ⇒ ALL PASS (U1–U4/U5/U6–U8 byte-untouched). Then `pnpm test && pnpm lint && pnpm typecheck` — clean.
- [ ] **Step 5: Commit.** `git add src/adapters/rest/ui.ts src/adapters/rest/ui.test.ts && LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "fix(ui): shell no-cache survives preCompressed br/gz (D-fff)"`. Raw-git verify the hash (`git log -1 --format='%h %s'`).

---

### Task 2: The dormant keepalive config pair (D-ggg)

**Files:**

- Modify: `src/main/config.ts` (schema, superRefine, `Config`, `loadConfig`)
- Modify: `src/main/config.test.ts` (defaults-pin amendment + the G matrix)

- [ ] **Step 1: Write the failing tests.** Append to `src/main/config.test.ts`:

```ts
describe('plan G keepalive config (D-ggg)', () => {
  it('dormant by default: 0/0 — every pre-G deployment byte-unchanged', () => {
    const c = loadConfig({})
    expect(c.keepaliveIntervalMs).toBe(0)
    expect(c.keepaliveTimeoutS).toBe(0)
  })

  it('half-opened enforcement fails the boot, both directions (D-qq precedent)', () => {
    expect(() => loadConfig({ NS_KEEPALIVE_INTERVAL_MS: '30000' })).toThrow(/invalid env/)
    expect(() => loadConfig({ NS_KEEPALIVE_TIMEOUT_S: '300' })).toThrow(/invalid env/)
  })

  it('a budget shorter than the sweep tick is invalid; the enabled pair parses', () => {
    expect(() =>
      loadConfig({ NS_KEEPALIVE_INTERVAL_MS: '30000', NS_KEEPALIVE_TIMEOUT_S: '29' })
    ).toThrow(/invalid env/)
    const c = loadConfig({ NS_KEEPALIVE_INTERVAL_MS: '30000', NS_KEEPALIVE_TIMEOUT_S: '30' })
    expect(c.keepaliveIntervalMs).toBe(30_000)
    expect(c.keepaliveTimeoutS).toBe(30)
  })
})
```

- [ ] **Step 2: Run to see them fail.** `pnpm vitest run src/main/config.test.ts` ⇒ RED (members absent — `keepaliveIntervalMs` undefined / toEqual drift).
- [ ] **Step 3: Implement `config.ts`.** (1) In the `EnvSchema` object after `NS_SESSION_TTL_S` add:

```ts
    // Plan G (D-ggg): keepalive enforcement, DORMANT by default (0/0) on the
    // NS_WEBHOOK_INTERVAL_MS precedent. Interval = sweeper tick; timeout = silence
    // budget before a silent claim expires. superRefine keeps it all-or-nothing —
    // a half-opened posture fails the boot (D-qq precedent).
    NS_KEEPALIVE_INTERVAL_MS: z.coerce.number().int().min(0).default(0),
    NS_KEEPALIVE_TIMEOUT_S: z.coerce.number().int().min(0).default(0),
```

(2) INSIDE the `superRefine` callback body, after the OIDC block and BEFORE its closing `})`, add:

```ts
// D-ggg fail-closed matrix: enforcement is all-or-nothing, and the budget must
// be at least one tick (a sub-tick budget is a policy the timer cannot honor).
if (e.NS_KEEPALIVE_INTERVAL_MS > 0 && e.NS_KEEPALIVE_TIMEOUT_S <= 0) {
  ctx.addIssue({
    code: 'custom',
    message: 'NS_KEEPALIVE_TIMEOUT_S is required when the sweeper interval is set',
    path: ['NS_KEEPALIVE_TIMEOUT_S'],
  })
}
if (e.NS_KEEPALIVE_TIMEOUT_S > 0 && e.NS_KEEPALIVE_INTERVAL_MS <= 0) {
  ctx.addIssue({
    code: 'custom',
    message: 'NS_KEEPALIVE_INTERVAL_MS is required when a lease timeout is set',
    path: ['NS_KEEPALIVE_INTERVAL_MS'],
  })
}
if (
  e.NS_KEEPALIVE_INTERVAL_MS > 0 &&
  e.NS_KEEPALIVE_TIMEOUT_S * 1000 < e.NS_KEEPALIVE_INTERVAL_MS
) {
  ctx.addIssue({
    code: 'custom',
    message: 'NS_KEEPALIVE_TIMEOUT_S must be at least the sweeper interval',
    path: ['NS_KEEPALIVE_TIMEOUT_S'],
  })
}
```

(3) `Config` gains, after `sessionTtlS: number`: `keepaliveIntervalMs: number` and `keepaliveTimeoutS: number`; (4) `loadConfig`'s return gains, after `sessionTtlS`: `keepaliveIntervalMs: r.data.NS_KEEPALIVE_INTERVAL_MS,` / `keepaliveTimeoutS: r.data.NS_KEEPALIVE_TIMEOUT_S,`.

- [ ] **Step 4: Amend the defaults pin.** In `config.test.ts` the `applies defaults` toEqual object gains, after `sessionTtlS: 28_800,`:

```ts
      keepaliveIntervalMs: 0,
      keepaliveTimeoutS: 0,
```

- [ ] **Step 5: Verify GREEN + commit.** `pnpm vitest run src/main/config.test.ts` ⇒ PASS; `pnpm test && pnpm lint && pnpm typecheck` clean. Commit `git commit -am "feat(config): dormant keepalive pair, fail-closed when opened (D-ggg)"`; raw-git verify.

---

### Task 3: Sweep primitives on the task repo (D-hhh)

**Files:**

- Modify: `src/application/ports.ts` (new row type + 2 `TaskRepo` members)
- Modify: `src/infra/sqlite/task-repo.ts` (claim stamp + 2 methods)
- Modify: `src/infra/sqlite/task-repo.test.ts` (append one describe)

- [ ] **Step 1: Write the failing tests.** Append INSIDE the file's end (the file-level `setup()`/`draft()` helpers and the `sql` import exist):

```ts
// D-hhh — the keepalive sweep primitives, pinned on a SEEDED store (claim /
// heartbeat / canceled / legacy-null-anchor rows through the REAL repo paths —
// F's binding lesson: stateful seeding, never fresh fixtures).
describe('stale-claim sweep primitives (D-hhh)', () => {
  it('tryClaim stamps the liveness anchor — the claim IS the first heartbeat', async () => {
    const db = await setup()
    const repo = new SqliteTaskRepo(db)
    await seedToken(db, 'tok_s', 'a_agent')
    await repo.create(draft('t_1'))
    const r = await repo.tryClaim(
      't_1',
      'tok_s',
      'a_agent',
      'in_progress',
      '2026-01-02T00:00:00.000Z'
    )
    expect(r).not.toBeNull()
    expect((await repo.findById('t_1'))?.last_heartbeat_at).toBe('2026-01-02T00:00:00.000Z')
    await db.destroy()
  })

  it('listStaleClaims finds silent in_progress claims only; coalesce carries legacy rows', async () => {
    const db = await setup()
    const repo = new SqliteTaskRepo(db)
    for (const t of ['tok_s', 'tok_f', 'tok_l']) await seedToken(db, t, 'a_agent')
    await repo.create(draft('t_stale'))
    await repo.tryClaim('t_stale', 'tok_s', 'a_agent', 'in_progress', '2026-01-02T00:00:00.000Z')
    await repo.setHeartbeat('t_stale', '2026-01-03T00:00:00.000Z')
    await repo.create(draft('t_live'))
    await repo.tryClaim('t_live', 'tok_f', 'a_agent', 'in_progress', '2026-01-02T00:00:00.000Z')
    await repo.setHeartbeat('t_live', '2026-01-06T00:00:00.000Z')
    await repo.create(draft('t_legacy'))
    // the pre-G claim shape: token + status WITHOUT any heartbeat value — the
    // coalesce anchor is updated_at (draft literal: 2026-01-01) → stale vs cutoff
    await sql`update tasks set claim_token_id='tok_l', status='in_progress' where id='t_legacy'`.execute(
      db
    )
    const hit = await repo.listStaleClaims('2026-01-05T00:00:00.000Z', 50)
    expect(hit.map((h) => h.id)).toEqual(['t_legacy', 't_stale']) // ascending by id
    // canceled is terminal — a claimed canceled row is NEVER sweep material.
    // (P4 FORCED amendment: the cutoff stays 01-05 — at 01-07 t_live is
    // HONESTLY stale and the assertion would record the wrong truth; at 01-05
    // the CANCEL is what excludes t_stale, so the arm stays discriminating.)
    await repo.setStatus('t_stale', 'canceled', '2026-01-06T00:00:00.000Z')
    const after = await repo.listStaleClaims('2026-01-05T00:00:00.000Z', 50)
    expect(after.map((h) => h.id)).toEqual(['t_legacy'])
    await db.destroy()
  })

  it('expireStaleClaim is the FULL CAS: wrong token/generation, fresh heartbeat, all miss', async () => {
    const db = await setup()
    const repo = new SqliteTaskRepo(db)
    await seedToken(db, 'tok_s', 'a_agent')
    await seedToken(db, 'tok_x', 'a_agent')
    await repo.create(draft('t_1'))
    await repo.tryClaim('t_1', 'tok_s', 'a_agent', 'in_progress', '2026-01-02T00:00:00.000Z')
    const cutoff = '2026-01-05T00:00:00.000Z'
    const base = { taskId: 't_1', cutoff, at: '2026-01-06T00:00:00.000Z' } as const
    expect(await repo.expireStaleClaim({ ...base, tokenId: 'tok_x', generation: 1 })).toBeNull()
    expect(await repo.expireStaleClaim({ ...base, tokenId: 'tok_s', generation: 99 })).toBeNull()
    // the race-defeat arm: a heartbeat fresher than the cutoff defeats the sweep
    await repo.setHeartbeat('t_1', '2026-01-06T00:00:00.000Z')
    expect(await repo.expireStaleClaim({ ...base, tokenId: 'tok_s', generation: 1 })).toBeNull()
    // the exact captured stale claim expires: todo, unclaimed, fence bumped, anchor cleared
    await repo.setHeartbeat('t_1', '2026-01-03T00:00:00.000Z')
    expect(await repo.expireStaleClaim({ ...base, tokenId: 'tok_s', generation: 1 })).toEqual({
      generation: 2,
    })
    const t = (await repo.findById('t_1'))!
    expect([t.status, t.claim_token_id, t.claim_generation, t.last_heartbeat_at]).toEqual([
      'todo',
      null,
      2,
      null,
    ])
    await db.destroy()
  })
})
```

(`seedToken` comes from `#root/testing/fixtures` — if the import line lacks it, add it to the existing fixtures import.)

- [ ] **Step 2: Run to see them fail** (compile-error RED is the honest RED — TS rejects the missing members; record the error text).
- [ ] **Step 3: Ports.** In `src/application/ports.ts` after the `TaskPatch` interface add:

```ts
/** A row the keepalive sweep may expire (D-hhh). Ascending by id — deterministic
 * audit order; `last_heartbeat_at` rides as the captured staleness witness. */
export interface StaleClaimRow {
  id: string
  claim_token_id: string
  claim_generation: number
  last_heartbeat_at: string | null
}
```

On the `TaskRepo` interface after `setHeartbeat` add:

```ts
  /** Keepalive sweep read (D-hhh): claimed `in_progress` tasks whose staleness
   * anchor — heartbeat, or `updated_at` for pre-G claims (the coalesce) — predates
   * `cutoff`. Ascending by id, at most `limit` rows. */
  listStaleClaims(cutoff: string, limit: number): Promise<StaleClaimRow[]>
  /** Keepalive sweep write (D-hhh): a FULL CAS on the captured claim — id, token,
   * generation, `in_progress` status AND the staleness predicate are re-checked
   * inside the UPDATE (a heartbeat that lands after the sweep read is an honest
   * miss, never a false revert). Reverts to `todo`, clears the claim, bumps the
   * generation (the zombie fence), clears the anchor. Returns the NEW generation. */
  expireStaleClaim(input: {
    taskId: string
    tokenId: string
    generation: number
    cutoff: string
    at: string
  }): Promise<{ generation: number } | null>
```

And amend the `tryClaim` doc-comment to end: `D-hhh: the claim IS the first liveness — updated_at is also stamped into last_heartbeat_at, so every claim carries a staleness anchor.`

- [ ] **Step 4: Implementation.** In `src/infra/sqlite/task-repo.ts`: add `StaleClaimRow` to the ports type-import; in `tryClaim`'s `.set((eb) => ({ … }))` object, after `claim_token_id: tokenId,` add:

```ts
        // D-hhh: the claim IS the first heartbeat — every claim carries an anchor.
        last_heartbeat_at: updated_at,
```

After `setHeartbeat` add:

```ts
  async listStaleClaims(cutoff: string, limit: number): Promise<StaleClaimRow[]> {
    // D-hhh: stored timestamps are toISOString UTC — lexicographic `<` IS the time
    // order (P4 probe-verified). The coalesce gives pre-G claims an honest anchor.
    const r = await sql<StaleClaimRow>`
      select id, claim_token_id, claim_generation, last_heartbeat_at
        from tasks
       where claim_token_id is not null
         and status = 'in_progress'
         and coalesce(last_heartbeat_at, updated_at) < ${cutoff}
       order by id
       limit ${limit}
    `.execute(this.db)
    return r.rows
  }

  async expireStaleClaim(input: {
    taskId: string
    tokenId: string
    generation: number
    cutoff: string
    at: string
  }): Promise<{ generation: number } | null> {
    // Single statement, full CAS (tryClaim lineage): the staleness predicate sits
    // IN this UPDATE, so a heartbeat between sweep-read and sweep-write defeats it.
    const row = await this.db
      .updateTable('tasks')
      .set((eb) => ({
        claim_token_id: null,
        claim_generation: eb('claim_generation', '+', 1),
        status: 'todo',
        last_heartbeat_at: null,
        updated_at: input.at,
      }))
      .where('id', '=', input.taskId)
      .where('claim_token_id', '=', input.tokenId)
      .where('claim_generation', '=', input.generation)
      .where('status', '=', 'in_progress')
      .where(sql`coalesce(last_heartbeat_at, updated_at)`, '<', input.cutoff)
      .returning('claim_generation')
      .executeTakeFirst()
    return row ? { generation: row.claim_generation } : null
  }
```

- [ ] **Step 5: Fake-widening duty.** `pnpm typecheck` — A2 NOTE (review-verified): the test-side fakes reach the seams via `as unknown as Repos` casts (claim-task.test.ts:256, update-status.test.ts:461), so typecheck will NOT red and NO fake widens — the expected commit-body truth is `fakes widened: none (cast seams)`. ONLY if typecheck DOES report a missing-member error, add to each fake touched:

```ts
    listStaleClaims: async () => {
      throw new Error('sweep never runs in this fake')
    },
    expireStaleClaim: async () => {
      throw new Error('sweep never runs in this fake')
    },
```

- [ ] **Step 6: Verify + commit.** `pnpm vitest run src/infra/sqlite/task-repo.test.ts` ⇒ PASS; `pnpm test && pnpm lint && pnpm typecheck` clean (the claim model-arms staying green PROVES the stamp harmless — the claim HTTP response is `{lease_token, generation}`, NOT a Task DTO). Commit `git commit -am "feat(tasks): sweep CAS primitives, claim-stamped liveness (D-hhh)"`; raw-git verify.

---

### Task 4: The lease sweeper loop (D-iii)

**Files:**

- Create: `src/infra/keepalive/lease-sweeper.ts`
- Create: `src/infra/keepalive/lease-sweeper.test.ts`
- Modify: `src/main/deps.ts`, `src/index.ts`, `src/application/usecases/heartbeat.ts` (comment only)

- [ ] **Step 1: Write the failing test.** Create `src/infra/keepalive/lease-sweeper.test.ts`:

```ts
// D-iii — the sweeper on the WIRE path (inject, zero sockets): agent+token seeded
// on the test db (test-app.ts's hashToken pattern), claim/heartbeat/status through
// the ROUTES; the sweep is driven through the injectable tick(nowMs) seam (the
// delivery loop's T14 lineage). The timer itself is proven only as START-REFUSAL —
// dormant defaults keep the whole suite inert (makeTestApp never starts it).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Repos, UnitOfWork } from '#root/application/ports'
import { hashToken } from '#root/infra/token-hash'
import { makeTestApp } from '#root/testing/test-app'
import { LeaseSweeper } from '#root/infra/keepalive/lease-sweeper'

let t: Awaited<ReturnType<typeof makeTestApp>>
beforeEach(async () => {
  t = await makeTestApp()
})
afterEach(async () => {
  await t.close()
})

const SECRET = 'sweep-agent-secret-0123456789abcdef'
const asHold = { authorization: `Bearer ${SECRET}` }

const setupClaimed = async (): Promise<{ id: string; lease: string }> => {
  const now = new Date().toISOString()
  await t.deps.db
    .insertInto('actors')
    .values({
      id: 'a_hold',
      kind: 'agent',
      handle: 'hold',
      display_name: 'Hold',
      description: '',
      created_at: now,
      role: null,
    })
    .execute()
  await t.deps.db
    .insertInto('tokens')
    .values({
      id: 'tok_hold',
      actor_id: 'a_hold',
      token_hash: hashToken(SECRET),
      label: 'sweep',
      created_at: now,
      last_used_at: null,
      revoked_at: null,
    })
    .execute()
  const created = await t.app.inject({
    method: 'POST',
    url: '/tasks',
    headers: { authorization: `Bearer ${t.adminToken}`, 'content-type': 'application/json' },
    payload: { title: 'swept', status: 'todo' },
  })
  expect(created.statusCode).toBeLessThan(300)
  const id = (created.json() as { id: string }).id
  const claim = await t.app.inject({
    method: 'POST',
    url: `/tasks/${id}/claim`,
    headers: asHold,
  })
  expect(claim.statusCode).toBe(200)
  return { id, lease: (claim.json() as { lease_token: string }).lease_token }
}
const sweep = (timeoutS: number, intervalMs = 1000) =>
  new LeaseSweeper(t.deps.uow, { intervalMs, timeoutS })
const auditOf = async (id: string, action: string) =>
  (await t.deps.auditRoot.search({ entity_id: id, limit: 50 })).filter((a) => a.action === action)

describe('lease sweeper (D-iii)', () => {
  it('the dormant pair refuses to arm; stop() on a never-started sweeper resolves', async () => {
    for (const cfg of [
      { intervalMs: 0, timeoutS: 300 },
      { intervalMs: 1000, timeoutS: 0 },
    ] as const) {
      const s = new LeaseSweeper(t.deps.uow, cfg)
      s.start()
      expect(s.isRunning).toBe(false)
      await s.stop() // the FALSE timer arm (delivery-loop test:201-238 lineage)
    }
  })

  it('an armed timer fires tick() on the default clock; a failing pass is SWALLOWED (P10 arms)', async () => {
    // scripted rejecting UoW is the ONLY way to exercise the real interval
    // callback FUNCTION, the Date.now() default-param arm and the
    // .catch(() => undefined) swallow arm — the delivery loop pins it the
    // same way (delivery-loop.test.ts armed-timer lineage).
    let fired = 0
    const uow = {
      withTransaction: async () => {
        fired += 1
        throw new Error('scripted sweep failure')
      },
    } as unknown as UnitOfWork
    const s = new LeaseSweeper(uow, { intervalMs: 10, timeoutS: 300 })
    s.start()
    expect(s.isRunning).toBe(true)
    await new Promise((r) => setTimeout(r, 50))
    await s.stop()
    expect(s.isRunning).toBe(false)
    expect(fired).toBeGreaterThan(0) // the timer REALLY fired; nothing rejected
  })

  it('a silent claim reverts: todo, unclaimed, generation bumped, audit "lease expired"', async () => {
    const { id } = await setupClaimed()
    const before = (await t.deps.tasksRoot.findById(id))!
    await sweep(300).tick(Date.now() + 301_000) // liveness = the CLAIM stamp (D-hhh)
    const after = (await t.deps.tasksRoot.findById(id))!
    expect([after.status, after.claim_token_id, after.last_heartbeat_at]).toEqual([
      'todo',
      null,
      null,
    ])
    expect(after.claim_generation).toBe(before.claim_generation + 1)
    const rows = await auditOf(id, 'lease_expired')
    expect(rows.length).toBe(1)
    expect(rows[0].reason).toBe('lease expired') // spec §6.7's pre-named reason
    expect(rows[0].actor_id).toBe('a_hold')
    expect(rows[0].token_id).toBe('tok_hold')
  })

  it('a heartbeat inside the budget saves the claim; later silence still sweeps', async () => {
    const { id, lease } = await setupClaimed()
    const hb = await t.app.inject({
      method: 'POST',
      url: `/tasks/${id}/heartbeat`,
      headers: { ...asHold, 'content-type': 'application/json' },
      payload: { lease_token: lease },
    })
    expect(hb.statusCode).toBe(200)
    await sweep(300).tick(Date.now() + 100_000) // cutoff = now-200 s → fresh hb survives
    expect((await t.deps.tasksRoot.findById(id))?.status).toBe('in_progress')
    await sweep(300).tick(Date.now() + 600_000) // cutoff past the last liveness
    expect((await t.deps.tasksRoot.findById(id))?.status).toBe('todo')
  })

  it('ZOMBIE FENCE (§12 sentence 3): post-sweep writes on the dead lease answer 412 stale_lease', async () => {
    const { id, lease } = await setupClaimed()
    await sweep(300).tick(Date.now() + 301_000)
    const hb = await t.app.inject({
      method: 'POST',
      url: `/tasks/${id}/heartbeat`,
      headers: { ...asHold, 'content-type': 'application/json' },
      payload: { lease_token: lease },
    })
    expect([hb.statusCode, (hb.json() as { code: string }).code]).toEqual([412, 'stale_lease'])
    const st = await t.app.inject({
      method: 'PATCH',
      url: `/tasks/${id}/status`,
      headers: { ...asHold, 'content-type': 'application/json' },
      payload: { status: 'in_progress', reason: 'zombie commits', lease_token: lease },
    })
    expect([st.statusCode, (st.json() as { code: string }).code]).toEqual([412, 'stale_lease'])
  })

  it('the overlap guard is provable: concurrent ticks share ONE in-flight sweep, ONE audit row', async () => {
    const { id } = await setupClaimed()
    const s = sweep(300)
    const a = s.tick(Date.now() + 301_000)
    const b = s.tick(Date.now() + 301_000) // re-entrant while in flight
    expect(b).toBe(a) // the guard's identity proof — the same in-flight promise
    await Promise.all([a, b])
    expect((await auditOf(id, 'lease_expired')).length).toBe(1)
  })

  it('start() arms the timer when enabled; stop() disarms AND drains the in-flight sweep', async () => {
    const { id } = await setupClaimed()
    const s = sweep(300, 50) // the ARMED face: 50 ms interval (the only timer the
    // suite ever arms — stopped inside the test, so the suite still ends timer-free)
    s.start()
    expect(s.isRunning).toBe(true)
    const flight = s.tick(Date.now() + 301_000)
    await s.stop()
    await flight // stop() drained it — the sweep landed before the db went away
    expect(s.isRunning).toBe(false)
    expect((await t.deps.tasksRoot.findById(id))?.status).toBe('todo')
  })

  it('the honest miss skips the audit (scripted seam — the CAS-defeat branch is uninterleavable via wire)', async () => {
    const repos = {
      tasks: {
        listStaleClaims: async () => [
          { id: 't_r', claim_token_id: 'tok_r', claim_generation: 3, last_heartbeat_at: null },
        ],
        expireStaleClaim: async () => null, // a heartbeat raced the read (D-hhh's miss)
      },
      actors: { findActorByTokenId: async () => ({ id: 'a_r' }) },
      audit: {
        append: async () => {
          throw new Error('MUST NOT append on a CAS miss')
        },
      },
    } as unknown as Repos
    const uow = {
      withTransaction: async (fn: (r: Repos) => Promise<unknown>) => fn(repos),
    } as unknown as UnitOfWork
    await new LeaseSweeper(uow, { intervalMs: 0, timeoutS: 300 }).tick(Date.now())
  })
})
```

- [ ] **Step 2: Run to see it fail** (module missing ⇒ compile RED, recorded).
- [ ] **Step 3: Write the sweeper.** Create `src/infra/keepalive/lease-sweeper.ts`:

```ts
import type { UnitOfWork } from '#root/application/ports'

export interface SweeperConfig {
  intervalMs: number // 0 = loop disabled (start() refuses — D-v kill lineage)
  timeoutS: number // silence budget; 0 refuses start (D-ggg's all-or-nothing pair)
}

/** One batch per tick — a long backlog drains across ticks (D-bb BATCH lineage). */
const BATCH = 50

/**
 * The keepalive sweeper (D-iii, spec §12): claims silent past `timeoutS` revert
 * to `todo`, generation bumped — the zombie's next write rides the EXISTING 412
 * stale_lease fence (no new error surface) — and the audit spine records action
 * `lease_expired` / reason `lease expired` (spec §6.7's pre-named reason), which
 * rides /events + webhooks for free (D-aa: the audit IS the outbox).
 *
 * Shaped on the delivery loop (kill-switch start, overlap-guarded injectable-now
 * tick, unref'd timer, drain-on-stop) with ONE stated divergence: the sweep is
 * pure DB with zero network I/O, so it HOLDS a transaction — revert + audit land
 * atomically (audit is the system's memory, §6.7; no half-story). NO Clock:
 * expiry windows are DECISIONS on real elapsed time — the raw Date.now seam the
 * delivery loop ships, comment deliberately here.
 */
export class LeaseSweeper {
  private timer: ReturnType<typeof setInterval> | undefined
  private sweeping: Promise<void> | undefined

  constructor(
    private readonly uow: UnitOfWork,
    private readonly config: SweeperConfig
  ) {}

  /** Composition-root entry (index.ts): refuses to start dormant (D-ggg). */
  start(): void {
    if (this.config.intervalMs <= 0 || this.config.timeoutS <= 0) return
    this.timer = setInterval(() => void this.tick().catch(() => undefined), this.config.intervalMs)
    this.timer.unref() // never hold shutdown hostage (index.ts owns close)
  }

  /** Observability seam (tests + ops): is the timer armed? */
  get isRunning(): boolean {
    return this.timer !== undefined
  }

  /**
   * One sweep pass. `nowMs` defaults to RAW Date.now (the T14 seam above);
   * tests inject. Overlap-guarded: a fire during an in-flight sweep is a no-op.
   */
  tick(nowMs: number = Date.now()): Promise<void> {
    if (this.sweeping) return this.sweeping
    this.sweeping = this.sweepAll(nowMs).finally(() => {
      this.sweeping = undefined
    })
    return this.sweeping
  }

  private async sweepAll(nowMs: number): Promise<void> {
    const cutoff = new Date(nowMs - this.config.timeoutS * 1000).toISOString()
    const at = new Date(nowMs).toISOString()
    await this.uow.withTransaction(async (repos) => {
      const stale = await repos.tasks.listStaleClaims(cutoff, BATCH)
      for (const row of stale) {
        // the staleness predicate is RE-CHECKED inside the UPDATE (D-hhh): a
        // heartbeat that landed since the read defeats the CAS — honest miss.
        const bumped = await repos.tasks.expireStaleClaim({
          taskId: row.id,
          tokenId: row.claim_token_id,
          generation: row.claim_generation,
          cutoff,
          at,
        })
        if (bumped === null) continue
        // attribution honesty (D-iii): actor = the token's holder, token = the
        // dying claim — the row answers WHOSE lease died; the reason says what
        // happened. The FK chain claim→tokens→actors makes the holder total (P6).
        const holder = (await repos.actors.findActorByTokenId(row.claim_token_id))!
        await repos.audit.append({
          actor_id: holder.id,
          token_id: row.claim_token_id,
          action: 'lease_expired',
          entity_type: 'task',
          entity_id: row.id,
          before: { status: 'in_progress', generation: row.claim_generation },
          after: { status: 'todo', generation: bumped.generation },
          reason: 'lease expired',
          created_at: at,
        })
      }
    })
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.sweeping // let an in-flight sweep finish (audit completeness across shutdown)
  }
}
```

- [ ] **Step 4: Wire composition.** `deps.ts`: import `LeaseSweeper`; add `AppDeps` member `leaseSweeper: LeaseSweeper` (after `deliveryLoop`) and construction (after the `deliveryLoop` entry) with the comment "STARTED only by the composition root (index.ts) — makeTestApp never starts it; dormant 0/0 keeps the suite inert; rides the UoW (pure DB, atomic revert+audit — the no-UoW clause guards NETWORK I/O, not sqlite txs)":

```ts
    leaseSweeper: new LeaseSweeper(uow, {
      intervalMs: config.keepaliveIntervalMs,
      timeoutS: config.keepaliveTimeoutS,
    }),
```

`index.ts`: after `deps.deliveryLoop.start()` add `deps.leaseSweeper.start() // refuses when dormant (D-ggg/D-iii)`; in `shutdown` add `await deps.leaseSweeper.stop()` right after `deliveryLoop.stop()` (before `server.close()`). `heartbeat.ts` line 11 becomes:

```ts
/** Liveness record for the keepalive lease — enforcement shipped in G (D-iii): a
 * claim silent past NS_KEEPALIVE_TIMEOUT_S reverts to todo under the generation
 * fence. Dormant (0/0) = the pre-G behavior, byte-for-byte. */
```

- [ ] **Step 5: Verify.** `pnpm vitest run src/infra/keepalive/lease-sweeper.test.ts` PASS; `pnpm test && pnpm lint && pnpm typecheck` clean (P9 re-check: full suite ran with the wiring present and stayed timer-inert).
- [ ] **Step 6: Commit.** `git add src/infra/keepalive src/main/deps.ts src/index.ts src/application/usecases/heartbeat.ts && LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(keepalive): lease sweeper loop, dormant by default (D-iii)"`; raw-git verify.

---

### Task 5: The CLI heartbeat command (D-jjj)

**Files:**

- Modify: `src/cli/run.ts` (COMMANDS, USAGE, arity gate, dispatch)
- Modify: `src/cli/cli.test.ts` (append one describe)
- Modify: `deploy/README.md` (usage block, command table, env table — byte-sync SAME commit)

- [ ] **Step 1: Write the failing arms.** Append to `src/cli/cli.test.ts` (file-level `run`/`stubFetch`/`createTask`/`claimAs`/`agentToken` and `CURRENT` exist):

```ts
// D-jjj — the heartbeat leg: the CLI's keepalive voice for the sweeper (D-iii).
// The lease is a capability: absent NS_LEASE_TOKEN is LOCAL (exit 2, nothing
// sent, the D-aaa ladder); on the wire it rides the EXISTING heartbeat op.
describe('cli heartbeat (D-jjj)', () => {
  it('keeps the claim alive and prints the server Task DTO (last_heartbeat_at fresh)', async () => {
    const agent = await agentToken('a_beater')
    const t = await createTask('beatable')
    const lease = await claimAs(t.id, agent)
    const r = await run(['heartbeat', t.id], { NS_TOKEN: agent, NS_LEASE_TOKEN: lease })
    expect(r.code).toBe(0)
    const dto = JSON.parse(r.out[0]) as Record<string, unknown>
    expect(dto).toMatchObject({ id: t.id, status: 'in_progress' })
    expect(dto.last_heartbeat_at).not.toBeNull()
  })
  it('absent NS_LEASE_TOKEN is a local config_error — exit 2, NOTHING sent', async () => {
    const r = await run(
      ['heartbeat', 't_x'],
      {},
      stubFetch(() => Promise.reject(new Error('must not send')))
    )
    expect(r.code).toBe(2)
    expect(r.err[0]).toBe('nightshift: config_error heartbeat requires NS_LEASE_TOKEN (from claim)')
  })
  it('local gates: exact arity, no foreign flags', async () => {
    expect((await run(['heartbeat'])).err[0]).toBe(
      "nightshift: usage_error 'heartbeat' takes exactly one <task-id>"
    )
    expect((await run(['heartbeat', 'a', 'b'])).code).toBe(2)
    expect(
      (await run(['heartbeat', 't_x', '--label', 'nope'], { NS_LEASE_TOKEN: 'l' })).err[0]
    ).toBe("nightshift: usage_error unknown flag --label for 'heartbeat'")
  })
  it('a dead lease exits 3 stale_lease (release bumped the generation)', async () => {
    const agent = await agentToken('a_dead')
    const t = await createTask('dead-lease')
    const lease = await claimAs(t.id, agent)
    await CURRENT.app.inject({
      method: 'POST',
      url: `/tasks/${t.id}/release`,
      headers: { authorization: `Bearer ${agent}` },
    })
    const r = await run(['heartbeat', t.id], { NS_TOKEN: agent, NS_LEASE_TOKEN: lease })
    expect(r.code).toBe(3)
    expect(r.err[0]).toBe('nightshift: stale_lease')
  })
})
```

- [ ] **Step 2: Run to see the honest RED** (`usage_error unknown command 'heartbeat'` ≠ pinned strings).
- [ ] **Step 3: Implement `run.ts`.** (1) `COMMANDS` becomes exactly:

```ts
const COMMANDS: Record<string, readonly string[]> = {
  next: ['label', 'limit'],
  claim: [],
  heartbeat: [],
  report: ['message', 'status', 'reason'],
}
```

(2) USAGE lines 1-2 become exactly (line 3 byte-kept):

```ts
  'usage: nightshift next [--label L] [--limit N] | claim <task-id> | heartbeat <task-id> | report <task-id> [--message M] [--status S --reason R]',
  'env: NS_URL + NS_TOKEN required · NS_LEASE_TOKEN for heartbeat and --status · NS_TIMEOUT_MS default 15000 (secrets via env, never argv — D-ff)',
```

(3) arity gate: `const idWanted = cmd === 'claim' || cmd === 'heartbeat' || cmd === 'report'`. (4) dispatch — insert BETWEEN the claim arm and the report comment:

```ts
if (cmd === 'heartbeat') {
  // D-jjj: the holder's keepalive leg against the sweeper (D-iii). The lease is
  // a capability — its absence is a LOCAL config_error (exit 2, NOTHING sent,
  // D-aaa); on the wire it rides the EXISTING heartbeat op, zero contract change.
  if (env.data.NS_LEASE_TOKEN === undefined) {
    io.stderr('nightshift: config_error heartbeat requires NS_LEASE_TOKEN (from claim)')
    return 2
  }
  const hb = await client.POST('/tasks/{id}/heartbeat', {
    params: { path: { id } },
    body: { lease_token: env.data.NS_LEASE_TOKEN },
  })
  const hf = failFrom(io, hb)
  if (hf !== null) return hf
  io.stdout(JSON.stringify(hb.data)) // the server's Task DTO IS the truth (D-aaa)
  return 0
}
```

- [ ] **Step 4: README byte-sync, SAME commit.** In `deploy/README.md` §The CLI: replace the three lines inside the ` ```text ` block with the FINAL USAGE lines byte-exact; RE-DERIVE the "`src/cli/run.ts:41-43`" citation against the final file (`grep -n "usage: nightshift" src/cli/run.ts` — P8 measured the block at `run.ts:42-44` post-delta; confirm by grep, cite the measured span). A1 (review): RE-DERIVE **ALL** `run.ts:N` citations in deploy/README.md — whole-file `grep -n "run.ts:" deploy/README.md` (the env-table span :203, the never-echoed quote :213, the secret-scan note :245 all shift; the COMMANDS line and the inserted dispatch arm push everything down). Add the commands-table row between `claim` and `report`:

```markdown
| `heartbeat` | `<task-id>` (exactly one); the lease via `NS_LEASE_TOKEN` — REQUIRED (absent ⇒ exit 2, nothing sent) | the server's Task DTO (liveness recorded) |
```

Amend the env-table `NS_LEASE_TOKEN` rule column to begin: `optional; the claim-issued capability — REQUIRED for `heartbeat`(absent ⇒ exit 2, nothing sent) and REQUIRED **while the target task is CLAIMED** for`--status` (absent on an unclaimed task ⇒ omitted from the body; n29/P9)`.

- [ ] **Step 5: Verify + commit.** `pnpm vitest run src/cli/cli.test.ts src/cli/shim.test.ts` PASS (P8 pin re-check: no hidden exact-set pins); `pnpm test && pnpm lint && pnpm typecheck` clean. Commit `git add src/cli deploy/README.md && git commit -m "feat(cli): heartbeat command + README byte-sync (D-jjj)"` (body: byte-sync line `run.ts:<true-span>`); raw-git verify.

---

### Task 6: The contract description flip (D-kkk)

**Files:**

- Modify: `openapi/openapi.yaml` (ONE line — the `/tasks/{id}/heartbeat` post description)
- Modify (generated): `src/client/schema.d.ts` via `pnpm gen:client`

- [ ] **Step 1: Flip the description.** Replace exactly:

```yaml
description: liveness record only; keepalive enforcement is deferred (spec §12)
```

with:

```yaml
description: liveness record for the keepalive lease; silent leases expire via the server-side sweeper (Plan G, spec §12)
```

- [ ] **Step 2: Regen IN THE SAME COMMIT (D-zz duty).** `pnpm gen:client` — `git diff --stat src/client/schema.d.ts` must show ONLY the JSDoc-comment delta (P7).
- [ ] **Step 3: Verify the pins stayed byte-green.** `pnpm vitest run src/adapters/rest/openapi-contract.test.ts src/client/drift.test.ts src/adapters/mcp/mount.test.ts` ⇒ PASS (paths×methods unchanged, Problem-code enum untouched, MCP frozen at 35 byte-untouched). `pnpm test && pnpm lint && pnpm typecheck` clean.
- [ ] **Step 4: Commit.** `git add openapi/openapi.yaml src/client/schema.d.ts && git commit -m "docs(contract): heartbeat ships keepalive; regen same commit (D-kkk)"`; raw-git verify.

---

### Task 7: Deploy-surface docs (D-lll)

**Files:**

- Modify: `deploy/README.md` (NS\_\* table +2 rows, citation re-derivation, Keepalive section)
- Modify: `deploy/DEPLOY-SMOKE.md` (§3 heartbeat arm; the §1 known-RED note STAYS)

- [ ] **Step 1: NS\_\* table rows + citation truth.** After the `NS_SESSION_TTL_S` row add (column format matching neighbors):

```markdown
| `NS_KEEPALIVE_INTERVAL_MS` | `0` | int, ≥`0`; **`0` = sweeper never starts (dormant default, D-ggg)**; the sweep tick when enabled |
| `NS_KEEPALIVE_TIMEOUT_S` | `0` | int, ≥`0`; **`0` = claims never expire**; silence budget before a silent claim reverts to `todo`; with the interval it forms an all-or-nothing pair — half-open fails the boot, budget ≥ tick (`config.ts` superRefine) |
```

Then RE-DERIVE every stale `config.ts` citation in this file: the "Transcribed from `src/main/config.ts:5-34`" span and the "`config.ts:39-56`" fail-closed-matrix citation (grep the FINAL file's schema/superRefine bounds; update to truth).

- [ ] **Step 2: The Keepalive section.** After §OIDC add:

```markdown
## Keepalive enforcement (Plan G)

**Dormant by default** (`0`/`0` — D-ggg). To ENABLE, set BOTH (half-open fails
the boot, exit 1): e.g. `NS_KEEPALIVE_INTERVAL_MS=10000 NS_KEEPALIVE_TIMEOUT_S=300`.
A claimed task whose last liveness (heartbeat — or the claim itself, which counts
as the first) predates the budget reverts to `todo` at the next tick: claim
cleared, generation bumped, audit gains action `lease_expired` with reason
`lease expired` (spec §6.7's pre-named reason — it rides `GET /audit` and the
event feed). Any LATER write with the old lease answers `412 stale_lease` — the
zombie fence, zero new error surface. Holders stay alive by heartbeating inside
the budget (`nightshift heartbeat`, or MCP `post_update` which already rides it).

Effective budget is TICK-QUANTIZED: expiry is checked only on sweep
ticks, so detection can lag the configured budget by up to one interval
(worst case budget == interval means up to a full interval late — quality-lane
advisory off ed74a60, sanctioned here into the operator text).
```

- [ ] **Step 3: DEPLOY-SMOKE §3 arm.** After the `claim` checklist item add:

```markdown
- [ ] `NS_LEASE_TOKEN=<lease> … heartbeat <task-id>` → exit 0 with the server Task
      DTO (`last_heartbeat_at` fresh). Absent lease ⇒ exit 2, nothing sent. A dead
      lease ⇒ exit 3, stderr line 1 `nightshift: stale_lease`. With enforcement
      enabled (both `NS_KEEPALIVE_*` set), a SILENT claim reverts to `todo` past the
      budget — audit action `lease_expired` — and the old lease then fences exit 3.
```

The §1 KNOWN FINDING blockquote stays byte-untouched — ONLY Task 8's live 23/0 evidence licenses its flip.

- [ ] **Step 4: Commit.** `git add deploy && git commit -m "docs(deploy): keepalive surface, heartbeat leg, citations re-derived (D-lll)"`; raw-git verify.

---

### Task 8: FINAL GATE — full suite, live deploy-smoke, the RED-note flip, the record, the PR

**Files:**

- Execute: the full gate battery + docker build/run + `scripts/deploy-smoke.mjs` (ZERO change to the script — Step 1 verifies that claim)
- Modify (after the run ONLY): `deploy/DEPLOY-SMOKE.md` §1 note, `deploy/README.md` Deploy-smoke section
- Modify: this plan doc (FINAL-GATE RECORD)

- [ ] **Step 1: Script-truth verification (the no-change claim).** `sed -n 73,77p scripts/deploy-smoke.mjs` (the no-cache arm's own span) — confirm the `/ui shell is no-cache` check already asserts `includes('no-cache')` and sends no explicit `accept-encoding` (undici auto-negotiates br) ⇒ ZERO script change; quote the arm in the record. `grep -rn "22 PASS\|recorded-FAIL\|must NOT be weakened" deploy/` — the flip targets are exactly `README.md` (:257-266) and `DEPLOY-SMOKE.md` §1; plan-F/E docs are history and NEVER rewritten.
- [ ] **Step 2: The full local gate.** `pnpm test:coverage && pnpm lint && pnpm typecheck && pnpm build && pnpm ui:build && pnpm ui:offline-check && pnpm test:e2e` — coverage floor **99.52 / 98.52 / 99.78 / 99.70** every axis ≥ F's record (Funcs HELD; `src/domain/**` 100×4; `vitest.config.ts` byte-untouched; honest counts 674 → N / 88 → N files); e2e probe-first per D-xx; zero-drift audit: `git diff origin/main..HEAD --stat` vs this plan's File-structure table — sanctioned deltas ONLY (plan/CLI/deploy/keepalive additions + D-fff/D-kkk named edits).
- [ ] **Step 3: The LIVE leg — fresh image, then the smoke.** `docker build --no-cache -t ns-g .` (quote the offline-check build line) → boot the twin on a THROWAWAY volume (F's Task-6 recipe: `-v` a fresh volume, `NS_BOOTSTRAP_TOKEN` local-smoke literal, published `127.0.0.1:3199`) → `NS_URL=… NS_TOKEN=… node scripts/deploy-smoke.mjs` — **expect 23 PASS / 0 FAIL, exit 0** (the brotli arm goes GREEN live — the recorded finding's death certificate). Then the keepalive ENABLED twin: boot with `NS_KEEPALIVE_INTERVAL_MS=1000 NS_KEEPALIVE_TIMEOUT_S=3`, create+claim via CLI, wait > 4 s, verify `GET /audit` shows `lease_expired`/`lease expired`, the task is `todo`, and the old lease fences exit 3 (heartbeat AND status). `docker stop -t 12` ⇒ ExitCode 0.
- [ ] **Step 4: The flip (ONLY after Steps 2-3 are green).** In `DEPLOY-SMOKE.md` §1 REPLACE the KNOWN FINDING blockquote with a RESOLVED record (quote the original 3 lines of finding, then: fixed by the D-fff `setHeaders` re-pin + in-suite arms U9/U9b; live G-wave run 23 PASS / 0 FAIL, exit 0, verbatim tail quoted below; probe never weakened — the script is byte-identical since F). In `deploy/README.md` §Deploy-smoke, mirror that resolution (expect 23/0; the 22/1 is history with lineage). Commit `git add deploy && git commit -m "docs(deploy): brotli finding RESOLVED — live run 23 PASS / 0 FAIL (D-fff)"`.
- [ ] **Step 5: FINAL-GATE RECORD** appended to THIS document: gate numbers verbatim, the smoke's full PASS tail + the keepalive twin evidence (audit row verbatim), image id, stop ExitCode, zero-drift verdict, the D-fff…D-lll ledger complete, QUEUED honest, commit chain raw-git-verified. Commit `git commit -am "docs(plan): plan G final gate record"`.
- [ ] **Step 6: Hand-off.** `git push -u origin feature/plan-g-brotli-keepalive`; PR body: what shipped, the gate numbers, the brotli death certificate, QUEUED (unchanged + new), **NEVER merge — merges are @tyriis personally**.

---

## Scope guard (what this plan REJECTS)

No MCP tool changes (frozen at 35), no UI staleness surfacing, no per-claim response fields, no spec edits, no cancel-path claim-clear quirk fix, no new error codes, no `scripts/` changes, no CI changes, no session-key/CSP/npm work. Each REJECTED item is QUEUED above — surfaced in the PR, never smuggled.

---

## Execution ledger (per-task, appended at execution)

- **Task 1 COMPLETE — `fb68015`.** TDD honest RED verbatim (U9/U9b `expected 'public, max-age=2592000, immutable' to be 'no-cache'`; U10 pre-fix PASS as the declared posture-arm) → GREEN 14/14 ui.test.ts, full `pnpm test` 677/88 (baseline + exactly the 3 arms), lint/typecheck clean, 2-file diff raw-git-verified. SPEC-REVIEW: PASS (independent lane, live-ran the arms 14/14, vacuity-checked). QUALITY: PASS — advisories dispositioned: **A1 (.deflate)** NO code change (precompress never emits it; P3 measured; YAGNI holds, logged here instead) · **A2 (U10 find-DRY)** no change (per-arm-inline is the file's doctrine). Zero implementer drift.
- **Task 2 COMPLETE — `ed74a60`.** Honest RED (3 fail verbatim, undefined-members face) → GREEN config 17/17, full `pnpm test` 680/88, lint/typecheck clean, 2-file diff raw-git-verified, +60/−0 (defaults-pin the sole sanctioned existing-assertion touch). SPEC-REVIEW: PASS (boundary 30/30-equality parses confirmed by-design). QUALITY: PASS — advisories: #1 block-1/block-3 redundant co-fire DISPOSED keep (redundant-but-honest, self-healing); #2 Config field doc-comments DISPOSED deferred-to-Task-4-wiring-comment (the deps.ts entry carries the units+dormant note at the consumption seam); #3 30/30 boundary test-comment DISPOSED keep (test name covers intent); **#4 tick-quantized lag — SANCTIONED into Task 7 Step 2 operator text (amended above)**. Zero implementer drift.
