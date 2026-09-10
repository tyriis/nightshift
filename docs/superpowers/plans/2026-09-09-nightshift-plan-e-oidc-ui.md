# Plan E: OIDC Human Login & Minimal UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the human side of nightshift: an OIDC relying party (authorization-code + PKCE, discovery + JWKS, tested exclusively against an IN-PROCESS stub IdP), signed httpOnly cookie sessions resolved INSIDE the existing `auth.ts` onRequest hook, CSRF on state-changing browser requests, the `admin`/`member` human roles (§5) as an additional pinned gate, OIDC first-login → `human` actor enablement (§8.4) with a pinned deny posture, and the first SvelteKit static UI (five §8 views, `/events?cursor=` polling) served by the same server — plus the honest §11.5 Playwright posture and the explicit CLI decision (D-oo handoff).

**Architecture:** The OIDC RP (authorization-code + PKCE via `jose`), the session codec and the first-login decision tree live in `src/adapters/shared/` as pure functions of `(deps, config)` behind an injectable `fetch` seam — every test drives the RP against an **in-process stub IdP through fastify `inject()` (zero sockets)**. `auth.ts`'s EXISTING onRequest hook gains a cookie-session leg at its commented seam (`auth.ts:52-54`): a signed `__Host-ns_sess` cookie resolves through the authoritative `sessions` table; session-actor mutations additionally check the `X-CSRF-Token` companion (D-rr) — still ONE hook, hook order untouched. Roles ride the `actors` table (`role`/`oidc_subject` via in-place ADD COLUMN + unique index, D-ss); first-login provisioning is gated by a fail-closed `oidc_provisioning` policy + `oidc_allowlist` table (D-tt). The UI is a SvelteKit-2 static SPA at repo-root `adapters/sveltekit/` (outside `src/`, D-vv) mounted by `@fastify/static` under the `/ui` base in its own encapsulated scope; `/mcp` stays bearer-only (D-ww).

**Tech Stack:** fastify 5.12.3, `jose@6.2.12` (runtime, sanctioned exception — D-pp), `@fastify/static@10.1.3` (runtime, sanctioned exception — D-vv), zod 4.5.4 (already present), Kysely 0.29.5 + better-sqlite3 13.0.3; devDependencies added for the UI/test toolchain: `svelte@5.57.0`, `@sveltejs/kit@2.70.3`, `@sveltejs/adapter-static@3.0.10`, `@sveltejs/vite-plugin-svelte@7.3.0`, `vite@8.2.2` (already transitive via vitest), `@playwright/test@1.63.0` (D-xx). vitest 4, node 24 / pnpm 10.33 via mise. **No other runtime dependencies** — all versions registry-checked 2026-09-09; licenses MIT/Apache-2.0 (§4 D14 permissive-only).

**Spec / Inputs (all in-repo):** `docs/superpowers/specs/2026-09-05-nightshift-design.md` §8, §5, §10, §11.5, §14 (+§9 placement, §4 D11/D13/D14) · Plan D record `docs/superpowers/plans/2026-09-09-nightshift-plan-d-mcp-client.md` (D-hh…D-oo, final-gate record) · Plan C record (D-aa…D-gg) · Plan B record (D-m…D-z) · Plan A record (D-a…D-l, Ruling A) · ticket [tyriis/nightshift#9](https://github.com/tyriis/nightshift/issues/9).

---

## Status & provenance

- Branch: `feature/plan-e-oidc-ui` off `main` @ `3332a47` (PR #8 merge commit — Plan D IS merged, verified 2026-09-09). **Push/PR at end-of-night per ticket #9 Night-shift protocol (replaces the sign-off gate); NEVER merge — merges are @tyriis's (binding).**
- Ticket: tyriis/nightshift#9 (session-handover; scope = issue body "Plan E scope" + inherited rulings; UNATTENDED protocol — see the ticket; the plan-review lane replaces the human gate, QUEUED (HUMAN) items never block).
- Baseline gate (recorded by the planner 2026-09-09 at `3332a47`, from Plan D's final gate): **517 tests / 74 files; Stmts 99.36 / Branch 97.81 / Funcs 99.74 / Lines 99.61**; lint / typecheck / build clean. Confirmed green this session at execution start by the planner's own `pnpm test:coverage` run — figures byte-match the Plan D FINAL-GATE RECORD. Documented-uncovered set: `auth.ts:47`, `rate-limit.ts:35`, `migrations.ts:274` (error arm), `task-repo.ts:151-164`, `thread-repo.ts:96/132`, plus Plan D's documented `mount.ts` defensive arms (`:15`, `:45-48`, `:50`) and `bridge.ts`/`http.ts` (now closed-by-test).
- Environment facts (planner-verified 2026-09-09): node 24.20.0 / pnpm 10.33.0 via mise; `~/.cache/ms-playwright` ABSENT (browser binaries not installed); pnpm registry reachable.
- Decision letters: continue Plan D's `D-oo` at **`D-pp`**. Note: Plan D's line 37 cites a `D-uu` precedent that exists in NO plan record (dangling reference in the merged doc — observed, not repaired; merged records stay untouched). Plan E therefore **skips the `D-uu` letter** to keep the namespace unambiguous.

### Pre-dispatch amendment ledger (plan-review FAIL + artifact preflight, 2026-09-09)

Independent review returned **FAIL** (findings B1–B12 + notes); the artifact preflight machine-verified every embedded block against the pinned deps (jose@6.2.12 / fastify@5.12.3 / @fastify/static@10.1.3 / zod@4.5.4 / kysely@0.29.5 / better-sqlite3@13.0.3; TS 6.0.3 nodenext + declaration emit; node 24.20.0 / pnpm 10.33 via mise). All revisions below are LOGGED here and applied to the blocks; a **re-review (attempt 2 of 3) is required before implementer dispatch**. The byte-sync protocol still governs shipped-vs-plan divergences.

- [preflight P1/fix1] Task 5 + D-pp: the `createRemoteJWKSet` fetch seam is jose's exported `customFetch` SYMBOL — a plain `{ fetch }` option does not exist and is silently ignored (jose would hit `globalThis.fetch` ⇒ real sockets in tests); the "Planner preflight note" paragraph is consumed and `remoteJwks` ships its probed form.
- [preflight P2/fix2] Task 5 stub-idp: fastify@5.12.3 has NO built-in urlencoded parser — the stub registers an `addContentTypeParser(...)` or every token POST answers 415.
- [preflight P2/fix3] Task 5 makeInjectFetch: `payload` must stringify a URLSearchParams body (exchangeCode posts `body: form`) — the plan form dropped it and token exchange could never go green.
- [preflight P2/fix4] Task 5 test list: the expired arm signs exp-120s — exp-10s sits inside the pinned clockTolerance:60 and never throws.
- [preflight P2] Task 5 shipped-form note: the `discover` cache block ran green AS-WRITTEN — ships unchanged.
- [preflight P4/fix5] Task 2 migration: the actors `_v2` rebuild is REPLACED by ADD COLUMN + unique index + UPDATE backfill — dropping the PARENT table (eight pre-E tables reference it) under `foreign_keys=ON` throws inside the Migrator transaction on deployed DBs (`defer_foreign_keys` still fails at COMMIT; in-txn `foreign_keys=OFF` is a no-op — probe-recorded; actors-only fixtures cannot see it); D-ss records the why.
- [preflight P4/fix6] Task 2 Step-1 test: migrateTo target `'2026-09-12_webhooks'` — kysely sorts migration names lexicographically; fts_search is NOT the pre-E head.
- [preflight P4/fix7] Task 2 Step-1 test: `.orderBy('id')` on the actors select (rowid order returns the human first; the pinned array order was RED).
- [preflight P6/fix8] Task 3 Step-1 test: pins the SHIPPED attribute order `; HttpOnly; Secure; SameSite=Lax; Path=/` (regex + c1) — the old pin contradicted the task's own implementation (the RED could never go green). (Attempt-2 honesty: this line initially recorded the INTENT, not a landed edit — the two test blocks were repaired in the B7 follow-up commit and verified byte-consistent by the next review attempt.)
- [review R1/B6 + preflight fix10] D-rr records credential precedence: valid cookie + bearer ⇒ SESSION wins (the arm resolves first); Task 4 pin #9 INVERTED accordingly; D-ww both-credentials consequence (the 403 session rejection answers on /mcp).
- [preflight P7/fix11] Task 10 ui.ts: the scope registers `{ prefix: '/ui' }` with static `prefix: '/'` — the plan shape threw 'Not found handler already set for Fastify instance with prefix: /' at boot; the dead `deps.deliveryLoop` line is deleted (2-arg signature kept, `app.log` warns).
- [preflight P7/fix12] Task 10 drift test: routeKeys learns the wildcard leaf (sentinel `GET *` — pretty-print carries NO path for wildcards in any mode); the fails-loudly test re-pins in the SAME edit; the `GET /ui/*` spelling is pinned via `hasRoute` (GET ⇒ uiBuildPresent, POST ⇒ false) captured before `t.close()`; D-vv ruling #2 + the Task 10 title/files lines updated.
- [preflight P7/fix13] Task 10 U5: inject (and every UA) normalizes dot-segments BEFORE the hook — U5 re-pinned honestly (normalizer unit + /uix 401; a dot-segment inject answers the PUBLIC spec route, never the UI nor the API-under-test).
- [review R6/preflight n9] Task 7 hook arm: `(AUTH_PRE_SESSION as readonly string[]).includes(path)` — readonly-tuple `.includes(string)` is TS2345 (arm position unchanged: Task 7 Step 4).
- [review R2/B10] Task 6: the `PUT /admin/policy/{key}` body enum `['on','off']` (admin.ts:107 + openapi.yaml ~:466) widens to `['on','off','allowlist']`; NEW test arm: review_gate STILL rejects 'allowlist' (400 — POLICY_ALLOWLIST stays the per-key semantic gate).
- [review R3/B12] Task 9 Step 0: the board DTO gains `labels: string[]` (`TaskWithCounts` + `toTaskDto` + batched `labelsFor` in the task-repo list/get paths, no N+1) + the yaml `Task` schema + gen:client artifact in the Task 9 commit; §11.2 body-pins update mechanically; D-vv records the contract addition; the board chip filters `t.labels.includes(fLabel)`.
- [review R4/B9] Task 9 events.ts: /events returns a BARE ARRAY (`rows.map(toEvent)`; cursor = audit id) — FeedPage → FeedEvent[]; the state reducers + loop take the array; the unused `import { api }` is dropped.
- [review R5/B11] Task 11: the probe is `playwright screenshot ... about:blank` (a real headless launch — the 1.63 CLI has no `launch` command); D-xx + Step 1 updated.
- [review R7/B2/B3] Task 2: `bootstrap.ts` create gains `role: 'admin'` ("bootstrap IS the admin — role-NULL would 403 the first boot") + the ActorRef/ActorRow typecheck ripple enumerated (bootstrap.test.ts, actor-repo.test.ts, bridge.test.ts, usecase ctx test files) with the `pnpm typecheck` sweep rule; the Task 2 header, commit list and file-structure section grow.
- [review notes a] D-zz: eight → SEVEN new yaml operations (4 `auth` incl. `/auth/me` + 3 `admin`).
- [review notes b] D-tt: the handle grammar is restated cleanly — D-q grammar `[A-Za-z0-9][A-Za-z0-9_-]*` with lowercase normalization; Task 7's sanitize governs.
- [review notes c] Task 7 L1: routes/auth.ts must call `sendProblem(reply, 500, 'internal_error', 'oidc not configured')` EXPLICITLY (the generic Error path answers detail 'internal error' — problem.ts:59-65).
- [review notes d] all plan commit subjects ≤72 chars (Tasks 2/4/5/6/7/8/9 rewritten).
- [review notes e] Task 11: global-setup writes the bootstrap token to an `os.tmpdir()` path — no repo `.tokens.json`; `.gitignore` gains only `playwright-report/` + `test-results/`.
- [review notes f] Task 1: honest defaults-comment — undefined members are listed for grep-visibility + future-default tripwire; vitest toEqual tolerates undefined either way.
- [review notes g/h] Task 9: the ready-only predicate ships DIRECTLY in Step 3 in its amended form (plain-leaf + `unmet_blockers === 0` + `claim_token_id === null`, both on the DTO); the children tab renders NESTED per §8-2; the self-correction paragraph reduced to one honest sentence.
- [review notes i] Task 6/7: the `deps.useCases` additions are named — `addAllowlist`/`removeAllowlist`/`listAllowlist` + `useCases.provisionHumanFromOidc` (key spelling aligned everywhere).
- [review notes j] D-zz + Task 7 Step 6: `/auth/logout` carries `security: []` DELIBERATELY — the drift test pins path×method only and cannot see the security field (honest documentation, stated where the yaml shape is owned).

- **FINAL-GATE RECORD (Task 12, 2026-09-09 — gate executed by the planner at HEAD `40c2bd1`; this record is the final commit of Plan E; chain base `3332a47` (PR #8 merge — Plans A–D merged).**
  - **The gate (planner-run, this record's evidence):** `pnpm test` → **650 passed / 86 files**; `pnpm lint` → 0 issues; `pnpm typecheck` → clean; `pnpm build` → exit 0; `pnpm test:coverage` → **99.49 / 98.38 / 99.78 / 99.69** — every axis ≥ the Plan D record (99.36 / 97.81 / 99.74 / 99.61), all four MOVED UP; `pnpm ui:build` → exit 0 (`Wrote site to "build"`); `pnpm ui:offline-check` → `ui build offline-safe; hosts seen: http://www.w3.org https://svelte.dev` (Task 8's two proven-inert hosts only — any third host REDs); `pnpm test:e2e` → `✓ e2e/smoke.e2e.ts:8:1 › §11.5 login -> board -> task -> comment -> status (732ms) / 1 passed (4.0s)`. Honest residuals: `format:check` fails on EXACTLY the two pre-existing baseline files — the spec md (imperfect since `630fa16`, byte-untouched tonight) and the git-local `.slim/` session scratch; neither is in any gate.
  - **Zero-churn proof (planner-run):** `git diff main --stat` empty for `vitest.config.ts`, `lefthook.yaml`, `.github/workflows/ci.yaml`, `src/adapters/rest/problem.ts`, `src/domain/errors.ts`, `src/adapters/mcp/mount.test.ts` (the 35-tool surface frozen), `src/adapters/rest/rate-limit.ts`, `src/adapters/rest/auth.test.ts`, the spec, and ALL Plan A–D records. The only sanctioned deltas in the frozen-adjacent set: `src/adapters/rest/idempotency.ts` — one word, the planned `export` on `MUTATING` (Task 4) — and `src/domain/task.ts` +3 (`HUMAN_ROLES`, recorded D-ss duty). `git diff main -- src/domain` = `task.ts` alone; the taxonomy pin (domain ∪ adapter === yaml `Problem.code`) is green suite-wide with ZERO new codes across all of Plan E.
  - **Footprint:** 95 files, +9405/−89 vs main; 16 commits before this record — plan `42e5e25` · review+preflight amendment round `edbc57f` · B7-pin repair `66d4383` · T1 `8d52338` · T2 `ffc93c0` + BL1 fix `b618fef` · T3 `c3d4bef` · T4 `8148f7d` · T5 `b7c11d7` · T6 `03bd43d` · T7 `4516151` · T8 `125a6f5` · T9 `3803a3c` · T10 `9697f88` · T11 `d5a07d0` + fix round `40c2bd1`. Night-shift protocol executed: the sign-off gate was REPLACED by the independent plan-review lane (attempt 1 FAIL — B1–B12 all repaired and re-verified; the attempt-3 run correctly rejected a phantom commit — raw-git discipline logged as tonight's top process lesson; re-run PASS on the real commit) plus the machine artifact-preflight (13 amendments, including the `jose` `customFetch`-symbol seam — the silent `{ fetch }` option would have opened real sockets in tests).
  - **Per-task discipline held:** every task shipped with a fresh implementer, TDD order, honest RED accounting, the per-task amendment blockquote(s) in THIS file as the byte-sync ledger, and independent Stage-1 (spec) + Stage-2 (quality) review with PASS before the next task dispatched; two fix rounds (T2 BL1 — the `oidc_subject` documentation duty; T11 R-1/R-2 — the CSP bootstrap allowance + layout `$props()`, both caught by the REAL browser) each landed as reviewed child commits with re-verification.
  - **Uncovered-set delta:** byte-identical to the inherited documented set modulo the pure line renumbers recorded per task (`auth.ts` `?? '/'` arm :47→:76; `mount.ts` family :45-48→:51-54; `task-repo.ts` :151-164→:178-191; `migrations.ts` error arm :274→:324). All Plan E new production files 100×4. Enforced floors untouched (global ≥85; `src/domain/**` 100×4); `vitest.config.ts` byte-untouched.
  - **E2E posture (D-xx, honest):** the probe-first protocol chose **RUN** (launch probe exit 0; headless-shell v1243 + ffmpeg via the sanctioned CDN, quoted with home-prefix redaction in the Task 11 amendment); the smoke ran twice-green in the fix round, green under the reviewer's own run, and green again for this final record. No system packages touched; the Arch fallback build ran on libs present. QUEUED (HUMAN): browser re-install after Playwright upgrades; optional CI e2e job (an ubuntu runner CAN run it — `ci.yaml` stays byte-untouched tonight by design).
  - **D-yy restated (handoff chain D-oo→E→F, unbroken):** the `nightshift claim|report|next` CLI stays **SLICED TO F** — explicit here, in the Task 12 record, and in the PR body; the D-kk substrate plus tonight's `labels` DTO addendum carry it.
  - **End of night per the ticket protocol: gates green ⇒ branch pushed + PR opened (`resolves #9`), redaction pass applied (no local absolute paths, usernames, or hostnames). NEVER merge — merges are @tyriis's (binding).**

### Inherited binding rulings (Plans A+B+C+D — obey; violation = task failure)

- **Error taxonomy ONE map:** no Plan E task adds a `DomainErrorCode` WITHOUT a recorded decision; `src/domain/errors.ts` and the yaml `Problem.code` enum move only via a recorded ruling + the enum pin (`domain ∪ adapter === enum`, exact). Adapter codes live in `problem.ts` `ADAPTER_ERROR_CODES` (currently exactly `{internal_error:500, payload_too_large:413, unsupported_media_type:415}`). Plan E's PRE-FERRIED seam: a bare `Error{statusCode:401}` already maps to `unauthenticated` problem+json (`problem.ts` setErrorHandler; `app.test.ts:73-83` pins the Plan E expectation) — session-layer rejections SHOULD ride that, not new codes.
- **Audit is the one spine** (D-aa); machine reason/action strings are grep-pinned, never reworded; every Plan E mutation that audits follows the `repos.audit.append` shape (`manage-actors.ts:43-52`). New machine-facing strings get pinned by their test the same task. Bootstrap init is unaudited BY RULING (`bootstrap.ts:4`) — first-login enablement is a RUNTIME mutation and IS audited (D-tt).
- `PUBLIC_PATHS` stays EXACTLY `{/ping, /openapi.yaml}` (binding comment `auth.ts:43-46`). Static UI assets do NOT silently join it — the static mount is its own ruled surface (D-vv) and the PUBLIC_PATHS membership pin stays green. Hook order `auth → idempotency → rate-limit` UNCHANGED; **no new app-level onRequest hooks** — the cookie-session leg lands INSIDE `registerAuth`'s existing hook at the commented seam (`auth.ts:52-54`); any deviation is a recorded ruling. `requireHuman` stays async; actorCtx spreads LAST.
- **Ghost-404 doctrine**, UoW FIFO non-reentrant, never touch root db inside `withTransaction`, no background loops (auth cache stays stateless or explicitly ruled), Time seam: login timestamps via `Clock` port.
- MCP surface FROZEN at 35 (`mount.test.ts` snapshot + D-ll exact-set `/mcp` drift exemption): Plan E adds/removes ZERO tools. `/mcp` ⇄ human cookie sessions: D-ww rules explicitly (default NO — bearer stays the only `/mcp` identity path).
- Secrets (D-ff posture): no plaintext secret at rest beyond the webhook-signing exception; session keys/OIDC client secret live in ENV only (`NS_OIDC_*`), never logged, never printed in tests; the session-signing key handling story is stated in D-qq.
- Coverage: thresholds unchanged (global ≥85, `src/domain/**` 100×4), `vitest.config.ts` byte-unchanged, never-lower bar on EVERY axis vs the Plan D record (99.36 / 97.81 / 99.74 / 99.61); every new uncovered arm closed-by-test or documented with a one-line justification.
- `src/domain/**`: touching domain files REQUIRES the domain 100×4 to survive (ACTOR_KINDS lives in `domain/task.ts`; a roles column decision may or may not touch domain — D-ss decides and states the coverage duty).
- New runtime deps ONLY with a recorded decision + license check (Apache-2.0/MIT family; D14); UI toolchain is devDependency-built static; `pnpm-workspace.yaml` `onlyBuiltDependencies` stays `{esbuild, better-sqlite3}` unless a recorded decision says otherwise.
- Conventions: TDD, `pnpm test <file>` red/green then `pnpm test && pnpm lint && pnpm typecheck` before commit; `LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "<subject ≤72>"` conventional commits; tests colocated `*.test.ts`; env via `makeTestApp(overrides)`; temp dirs via `os.tmpdir()`; tests NEVER read `.env`/secret paths; no fake RED — honest declarations; new files `git add` explicitly; a commit cannot quote its own hash. **Night-shift additions (ticket #9):** never read `.env*`/`*.db`/`*secret*` files; NO real network IdP calls (in-process stub only); no global installs; scratch only under the session tmp dir; queued-human decisions never block (route around + say so).

### Plan ⇄ shipped byte-sync protocol (same as Plans A+B+C+D)

The code blocks below are the planned text. If shipped code lands byte-different from a block (review repair, lint normalization, API correction), the implementer appends a `> **Amendment (Task N, <who/what>):** …` blockquote to that task's section in THIS file, quoting what changed (with `git show <hash>` for review repairs) and re-labels the block `sync = shipped form` once identical. Never leave the plan silently describing code that does not exist. A commit cannot quote its own hash — amendments land in the child fix commit. A pin that passes first-run says so: "there is no RED phase to claim and none is claimed."

### QUEUED (HUMAN) — never blocks tonight

| Item                                                                    | Route-around for tonight                                              |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Real Pocket ID base URL / client id / client secret                     | stub IdP + optional env keys; OIDC legs dormant without them (pinned) |
| `removeAdditional` 400-flip (Plan B lineage)                            | untouched; status quo strips                                          |
| `nightshift-client` npm publish                                         | module stays in-repo (D-kk)                                           |
| Docker/homelab deploy, `openapi/` asset-shipping, FTS deploy-smoke arms | Plan F (ticket: state frozen)                                         |
| Browser binaries for §11.5 (operator install)                           | D-xx honest posture recorded either way                               |

---

## Decision records (Plan E — D-pp … D-zz; letters continue Plan D's D-oo; **`D-uu` intentionally skipped** — it appears as a dangling citation at Plan D line 37 with no defining record anywhere in the repo; E does not define a second `D-uu` and does not edit the merged Plan D doc)

**D-pp — OIDC RP line: `jose@6.2.12` as the sanctioned runtime-dep exception; authorization-code + PKCE(S256) against Pocket ID; ALL RP traffic behind an injectable fetch seam; tests are in-process `inject()` only.** Pocket ID v2.14 facts pinned from vendor docs/source (lib-1): discovery at `{issuer}/.well-known/openid-configuration`; **single active signing key, default RS256** (`id_token_signing_alg_values_supported` contains exactly one value); `at_hash` IS emitted with the digest derived from the id_token header `alg`; RFC 9207 `iss` on the authorization redirect (`authorization_response_iss_parameter_supported: true`); PKCE is enforced for public clients; confidential clients use `client_secret_post`; `code_challenge_methods_supported` includes S256. Why jose and not hand-rolled `node:crypto`: JWT BCP (`draft-ietf-oauth-rfc8725bis-10`, Aug 2026, obsoletes RFC 8725) and OWASP WSTG both land on "use a maintained library, restrict algorithms explicitly"; the hand-rolled path's ES256 raw⇄DER footgun class and `alg`-confusion history is exactly the risk a self-hosted security boundary must not own. `jose` is MIT, **zero runtime dependencies**, tree-shakeable (~19 kB gzip used); it joins `openapi-fetch` and `@modelcontextprotocol/server` as the THIRD and FINAL sanctioned runtime exception under the inherited "no new runtime deps" posture (D-hh/D-kk precedent; D14 license check: MIT). Usage is two subpaths only: `jose/jwt/verify` (`jwtVerify` with `{issuer, audience, algorithms:['RS256'], clockTolerance: 60}`) and `jose/jwks/remote` (`createRemoteJWKSet(new URL(jwks_uri), { [customFetch]: (url, options) => deps.fetch(url, options) })` — PREFLIGHT-PROBED (P1/fix1): jose@6.2.12's fetch seam is the exported `customFetch` SYMBOL; a plain `fetch` option key does not exist and is silently ignored — jose would fall through to `globalThis.fetch` and open real sockets in tests). **The `deps.fetch` seam is the test-safety mechanism:** `AppDeps.fetch` defaults to `globalThis.fetch`; `makeTestApp` injects an inject-backed fetch that routes the configured issuer to an in-process `Fastify.inject()` stub IdP (librarian-verified pattern — Plan D's client smoke already ships `injectFetch`); **no test ever opens a socket** (ticket: "never network"). Additional validations the RP performs beyond jose's (each pinned by a stub-IdP negative test): state match (timingSafe), RFC 9207 `iss` parameter when present, `nonce` byte-match against the flow cookie, `at_hash` (half-hash of access_token under the **signing alg's** hash — SHA-256 for RS256), `sub` present, `email_verified === true` when the allow-list path reads email. Config (config.ts zod style, Task 1): `NS_OIDC_ISSUER` (string, `.endsWith('/')` → strip; optional), `NS_OIDC_CLIENT_ID` (optional), `NS_OIDC_CLIENT_SECRET` (optional — absent ⇒ `token_endpoint_auth_method: none` public client + PKCE, present ⇒ `client_secret_post` in the BODY only, never the URL, never logged — D-ff posture stated), `NS_OIDC_SCOPE` default `'openid profile email'`, `NS_PUBLIC_URL` (our own origin; redirect_uri = `NS_PUBLIC_URL + /auth/callback`). OIDC-DORMANT rule: issuer or client-id absent ⇒ `/auth/login` and `/auth/callback` answer the pinned `500 internal_error` + detail `'oidc not configured'` (Task 5) — routes EXIST regardless of config so the drift ⇄ yaml set stays config-invariant (no conditional registration). Pocket-ID-ops note (QUEUED HUMAN): `INTERNAL_APP_URL`, when set on the IdP, rewrites `jwks_uri`/`token_endpoint` to a host only reachable from the IdP's network — the operator either leaves it unset or moves the RP closer to the IdP; stated here so the morning operator is not surprised. `nonce` echo is Fosite-conformant but was NOT confirmed in Pocket ID's repo (lib-1 flag 1): the stub asserts it, the RP requires it, and a verify-once against the real instance is QUEUED (HUMAN).

**D-qq — Session store: server-side `sessions` table is authoritative; the cookie is a signed envelope carrying `{sid, exp}`; NO sweeper loop.** Spec §10 says "signed httpOnly cookies"; OWASP's session-management sheet says server-side state for anything meaningful, ≥128-bit entropy id, expiry inside the signed payload, `timingSafeEqual`, `__Host-` prefix (Secure, `Path=/`, no `Domain`), `SameSite=Lax`, HttpOnly. Reconciled: cookie value = `base64url(json({sid, exp}))` + `.` + `HMAC-SHA256(NS_SESSION_KEY, payload)`; the hook verifies the signature (constant-time) BEFORE any db touch (cheap reject for garbage cookies — never-lower coverage: both arms tested), then loads the row; the table is the revocation truth (`revoked_at` + lazy `expires_at` expiry checked per read — an expired/revoked row 401s regardless of what the cookie claims; the signed `exp` is the outer bound). `NS_SESSION_KEY: z.string().min(32).optional()` (env-only; with OIDC configured but no key, boot FAILS with the pinned loadConfig `/invalid env/` story — a config matrix test pins the three legs: no-oidc⇒no-key-ok, oidc⇒key-required, key-alone-ok) + `NS_SESSION_TTL_S` default `28800` (8 h absolute, no idle-refresh in v1 — stated). Logout revokes the row (audited) + clears both cookies (`Max-Age=0`, same attributes); restart does NOT invalidate sessions (table survives — stated). Key rotation is deliberately deferred: single active key, env-keyed, rotation story = operator reissues key ⇒ all sessions die on the exp bound — QUEUED (HUMAN) if the operator wants dual-key rotation. Session rows carry `actor_id`, `csrf` (D-rr), `created_at`, `expires_at`, `revoked_at`; a session is valid iff `revoked_at IS NULL AND expires_at > now` (via `Clock` port).

**D-rr — CSRF: session-bound synchronizer token delivered via a JS-readable companion cookie, ENFORCED INSIDE the existing `auth.ts` onRequest hook — recorded deviation-adjacent, not a new hook (D-ii's idempotency-skip precedent).** OWASP 2026: naive random double-submit is DISCOURAGED; the token MUST be session-bound ("signed double-submit" = recommended). Shape: at login the session row gets `csrf = randomBytes(32).base64url`; `Set-Cookie: __Host-ns_csrf=<csrf>; Secure; SameSite=Lax; Path=/` (deliberately NOT HttpOnly — the SPA must read it and mirror it into `X-CSRF-Token`). Enforcement arm in the hook (after a SESSION actor resolves; bearer actors skip CSRF — no ambient-credential attack surface): if `request.method ∈ {POST,PATCH,PUT,DELETE}` (same `MUTATING` vocabulary as idempotency) AND `authVia === 'session'` ⇒ require header `X-CSRF-Token` timingSafe-equal to the row's token; mismatch ⇒ `DomainError('forbidden', 'missing or invalid CSRF token (D-rr)')` — EXISTING code, zero taxonomy move. Exempt: `/auth/logout` needs it (state-changing, session actor — uniform); `/auth/login`/`/auth/callback` are actor-LESS (the OIDC `state` parameter is their CSRF). `Sec-Fetch-Site` second-layer rejection: explicitly NOT built (YAGNI stated + fail-closed fallback complexity; SameSite=Lax + token is the v1 posture — §12 candidate). Companion cookie is set ONLY at login (never re-derived — the CSRF row value is truth), cleared at logout with the session cookie. **Credential precedence (review R1, probe-recorded):** a VALID session cookie resolves BEFORE the bearer header is read — cookie+bearer ⇒ SESSION wins; an explicit bearer does NOT preempt an ambient cookie. Stated consequences: a human browser carrying both cannot bypass CSRF, and agents never hold a session cookie, so bearer paths are unaffected (the `/mcp` both-credentials shape rides D-ww: the 403 session rejection answers).

**D-ss — Roles: `actors` gains `role` + `oidc_subject` via in-place ADD COLUMN + a unique index (NOT the `_v2` exemplar — the why is below); enforcement is a new `requireAdmin` preHandler attached to EXACTLY the ten `/admin/*` ops; `requireHuman` stays and stays green.** There is no role concept today (lib-2: zero `role` matches in `src`; `requireHuman` = kind gate only). Storage choice A (actors columns) over choice B (side table): the auth hot path already loads the actor row per request, role must ride `ActorRef` into every gate, and a second table would fork actor truth (audit is the one spine — actor identity is too). One migration `2026-09-13_human_identity` adds the columns IN PLACE: `ALTER TABLE actors ADD COLUMN role text CHECK (role in ('admin','member'))` + `ADD COLUMN oidc_subject text` plus a UNIQUE INDEX on `actors(oidc_subject)` (subject nullable — agents and pre-E humans have none; a unique index permits multiple NULLs), humans backfill **`'admin'`** (every pre-E human created the board or was admin-created with a login token; MEMBERS arrive only via D-tt provisioning), agents stay `NULL`; plus `sessions` + `oidc_allowlist` tables + `policy` seed `('oidc_provisioning','off')` in the SAME migration. The `_v2` CHECK-widening exemplar (`migrations.ts:181-207`) is deliberately NOT followed — honest why: that exemplar drops a CHILD table, while `actors` is a PARENT (eight pre-E tables carry `references actors(id)`), and under the repo's `foreign_keys=ON` a parent DROP throws `FOREIGN KEY constraint failed` inside the migration transaction on any deployed DB with child rows (preflight P4: `defer_foreign_keys` still fails at COMMIT even with the parent restored by name; `foreign_keys=OFF` is a no-op mid-transaction — probe-recorded, amendment ledger); `schema.ts` interfaces + `DB` registry + the `migrations.test.ts:6-30` `TABLES` exact-set grows by exactly `['oidc_allowlist','sessions']`. Vocabulary lives domain-side next to `ACTOR_KINDS` (`domain/task.ts`): `HUMAN_ROLES = ['admin','member'] as const` (domain 100×4 duty — the tests cover it). `ActorRow`/`ActorRef` gain `role: HumanRole | null`; ripple: `actor-repo` explicit mappings (`findActiveTokenByHash`'s trimmed actor — role rides; `create()` input gains `role`), `test-app.ts`/`fixtures.ts` seeds set it, and the **yaml `Actor` schema gains `role: { type: ["string","null"], enum: ['admin','member','null'] }`-honest shape + `pnpm gen:client` regen + committed artifact** (D-zz). Enforcement: `requireAdmin` (async — R4 shape identical to `requireHuman`) throws `DomainError('forbidden', 'this endpoint requires the admin role (spec §5)')`; attached as `preHandler: [requireHuman, requireAdmin]` to EXACTLY the ten existing admin ops (`admin.ts` ×6, `webhooks.ts` ×4 — enumerated) plus the three new allow-list ops (D-tt); member matrix pinned per-op (10×2 + 3×2), `requireHuman` agent-rejection pins byte-untouched; NO silent narrowing (GET-list/policy reads do NOT become member-readable — the ticket's "do not silently widen or narrow /admin/\* acceptance", both directions pinned by the matrix). Bootstrap `a_bootstrap` and test `a_nils` are `'admin'` (seeded); member actors are provisioned-only.

**D-tt — First-login/allow-list: fail-closed policy `oidc_provisioning` (`off|allowlist`, default `off`) + `oidc_allowlist` email table managed by admins; unrecognized ⇒ pinned 403 deny + audit; login outcomes are audited.** §8.4 "admin enables accounts on first login or by allow-list" realized as the allow-list leg (a UI approval queue would widen admin surface beyond the ten ops +3 pinned ones — YAGNI). The decision tree inside `/auth/callback` AFTER id*token verification (Task 5): (1) actor found by `oidc_subject` → login (session mint). (2) none: read policy `oidc_provisioning` fail-closed `(gate ?? 'off')` (the `update-status.ts:72-79` lineage). (3) `off` → DENY: no session, 302 `/ui/login?error=pending` for browser navigation, `403 forbidden` problem+json for `accept: application/json` requests — pinned detail string `'oidc identity not recognized (allow-list first)'`; audit `login_denied`. (4) `allowlist`: `email_verified === true` AND `email` ∈ `oidc_allowlist` ⇒ PROVISION via new use-case `ProvisionHumanFromOidc`: handle derivation is a PINNED algorithm — `preferred_username` → else email local-part → sanitize to the D-q mention grammar — `[A-Za-z0-9][A-Za-z0-9_-]*`with lowercase normalization (strip every char outside`[a-z0-9_-]`, strip leading chars until alphanumeric, lowercase, max 60; Task 7's sanitize governs) — then collisions append `-2`, `-3`, … (`handle_taken`NEVER thrown at provision time; exhaustion >20 →`invalid_request`arm tested); actor row`kind:'human', role:'member', oidc_subject=sub`, audits `human_provisioned`(reason`'oidc first-login allow-list'`) then login; email not listed ⇒ same DENY as (3). Login SUCCESS audits `login_success`(entity actor, after`{sub}`) — the §14-7 "audit reconstructs the whole story" demands auth events on the spine; **bootstrap stays unaudited by inherited ruling** (`bootstrap.ts:4`) and the distinction is stated, not silently crossed. New audit ACTIONS (`login_success`, `login_denied`, `human_provisioned`, `session_revoked`) are audit vocabulary like `actor_created`/`policy_set`— grep-pinned in their tests, ZERO new`DomainErrorCode`/adapter codes. Allow-list admin ops (all `requireHuman + requireAdmin`): `GET /admin/allowlist`(200 array),`POST /admin/allowlist`body`{email}`(201; the email rule is DECLARED here — no repo validator pre-exists (lib-2 zero matches): JSON-schema`{type:'string', minLength: 3, maxLength: 254, pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'}`on the route schema, stored LOWERCASED by the use-case — the matching side lowercases id_token emails identically, pinned both sides),`DELETE /admin/allowlist/{email}`(204 ghost-404 doctrine verbatim; no-entry ⇒`not_found`ghost-404 verbatim). Duplicate POST is idempotent **200** with the existing row (data, not error — a`409`would need a new code: forbidden), PINNED. Policy flip rides the EXISTING`PUT /admin/policy/:key`—`POLICY_ALLOWLIST`gains`oidc_provisioning: ['off','allowlist']`(one line;`manage-policy.test.ts` extends).

**D-vv — UI: SvelteKit-2 static SPA at repo-root `adapters/sveltekit/` (NOT under `src/`), served under `/ui` by `@fastify/static` in its own encapsulated scope; two NEW exact-set pins; `/` and PUBLIC_PATHS byte-untouched.** Toolchain-boundary: `tsc -p tsconfig.json` (`include:["src"]`), `eslint src`, and vitest (`src/**/*.test.ts`) would ALL capture a UI inside `src/` — Kit's generated `.svelte-kit/` tree and untested `.ts` helpers would poison typecheck/lint/coverage. Repo-root `adapters/sveltekit/` (spec §9's placement literal) sits OUTSIDE all three (verified: vitest include `src/**`, eslint `pnpm lint` = `eslint src`, tsc include `src`) while prettier still formats it (`--write .`; `.svelte` unknown-extension → prettier's glob skips unsupported files — honest statement; adding `prettier-plugin-svelte` is a plan-pinned devDep so `format:check` covers `.svelte` too — MIT, devDep, decided HERE). Kit 2.70.3 + `adapter-static@3.0.10` (both MIT), SPA mode (`+layout.ts` `ssr=false, prerender=false`), `fallback:'index.html'`, `kit.paths.base='/ui'`, `precompress:true`, system-font stack, no external URLs in build (pinned by a build-output grep test), vite 8.2.2 (already the repo's transitive vite via vitest — dedupe stated). Serving: `@fastify/static@10.1.3` (MIT, fastify-5-compatible ≥8.x per its compat table) registered via `mountUi(server, deps)` AFTER `mountMcp` (last mount, mirrors D-ii's mount posture): encapsulated scope `{ prefix: '/ui' }`, `root: join(process.cwd(),'adapters','sveltekit','build')` — the SAME cwd-relative asset story as `/openapi.yaml` (`app.ts:45-48`; Docker asset-shipping stays F), `wildcard: true` INSIDE the scope only (registers exactly `GET /ui/*` — the scope's `setNotFoundHandler` answers scope-404s with `sendFile('index.html')` ⇒ SPA deep-links, while the ROOT `notFound` stays problem+json byte-untouched and API ghost-404s keep their doctrine), `preCompressed: true` (pairs `precompress`), hashed assets `immutable, maxAge 30d`, `index.html` `no-cache`. Missing build dir ⇒ mount SKIPS with a logged notice + `/ui/*` 404s as normal (pinned — dev/test without a build never crashes boot; the Playwright smoke builds first). **Exact-set ruling #1 (auth):** the hook gains TWO new pinned exemption arms, both recorded here, never widened silently: (a) `isUiPath` — `GET/HEAD` only, under the `/ui` root (single-member exact set, same fail-closed normalization as PUBLIC_PATHS' slash-collapse); (b) `AUTH_PRE_SESSION = ['/auth/login', '/auth/callback']` — `GET`-only exact set (D-pp: these legs run BEFORE any identity exists; every other method on those paths keeps the bearer requirement and answers the byte-identical missing-bearer 401 — pinned). `/auth/logout` is deliberately NOT exempt (state-changing, session actor — CSRF-guarded like every session mutation). PUBLIC_PATHS literal stays EXACTLY `{/ping,/openapi.yaml}` and its pin test byte-untouched; matrix pinned (GET exempt, POST not, `/auth/login/..` not, `/uiz` not). **Exact-set ruling #2 (drift, D-ll precedent; AMENDED pre-dispatch, preflight P7/fix12):** registering `GET /ui/*` prints in find-my-way's pretty-print as a BARE wildcard leaf (`*`) with NO path segment — served-keys therefore carries the sentinel `GET *`, not `GET /ui/*`; the routeKeys grammar learns that leaf, served-keys minus `MCP_ROUTES` minus the sentinel set must equal yaml keys EXACTLY, and `app.hasRoute({ method: 'GET', url: '/ui/*' }) === uiBuildPresent()` (plus `POST ⇒ false`) pins the exact spelling the printer cannot show; the yaml never mentions `/ui`; a second wildcard or a non-`/ui` mount spelling fails the pin. Human sessions reach `/ui` only as statics (no data); data flows through the API with cookies. Five §8 views are file-based routes (`board`, `tasks/[id]` with the six §8-2 tabs, `inbox`, `admin` (renders a member-visible 403 state), `login`) — structure is the requirement; the plan pins component boundaries + the `client.ts` cookie/CSRF fetch wrapper + `/events?cursor=` poll loop (2 s, cursor monotonic, backoff to 10 s on error — constants named, tests pin the reducer not the clock). Design polish is explicitly NOT tonight (spec §8; @designer is a human-hours concern — structural fidelity only, stated honestly in the final record). **Contract addendum (review R3/B12):** the §8-1 label chip REQUIRES the board DTO to carry `labels` — the Task 9 Step 0 read-side expansion is a recorded contract addition (D-zz duty), not a silent widening.

**D-ww — `/mcp` stays bearer-only: the auth hook decorates `authVia: 'bearer' | 'session' | null` (set where identity resolves, zero re-lookup) and the `/mcp` handler refuses `session` with a pinned `403 forbidden` `'mcp requires a bearer token (D-ww)'`.** Spec §5/§10 bind agents to bearer; the 35-tool parity harness pins BEARER semantics end-to-end; a cookie identity inside `/mcp` would fork the identity posture the entire D-mm transcription doctrine rests on. Defense-in-depth: the hook arm ALSO refuses `session`-actor requests to `/mcp` up front, and the mount-level check remains as the pinned second layer (a future hook refactor cannot silently open `/mcp`) — the mount.ts test proves the arm is REACHABLE (mount-level pin) and the hook test proves it never fires first. Session-actor `GET/POST /mcp` → 403; bearer byte-unchanged; 35-tool snapshot unmoved.

**D-xx — §11.5 Playwright: the smoke suite SHIPS and is REAL; tonight's gate attempts a real headless run and records the honest result — `pnpm test:e2e` is NOT part of the lefthook/CI gates (untouched files stay untouched).** Runner reality (measured): `~/.cache/ms-playwright` absent; Playwright 1.63 does not support Arch (`playwright install-deps` shells `apt-get` → 127; browsers need pacman-shared-libs = root = impossible unattended; the Night-shift rule "no global installs" bars any pacman call). Protocol: `pnpm exec playwright install chromium --only-shell` (project-local binaries into `~/.cache/ms-playwright` — NOT a global install; registry-free CDN fetch), then a screenshot-launch probe (review R5/B11: the 1.63 CLI has NO `launch` command — `pnpm exec playwright screenshot --browser chromium about:blank <tmp png>` IS a real headless launch); iff the probe exits 0 ⇒ run the smoke (stub IdP + app both `webServer`-spawned; setup project authenticates once through `/auth/login` ⇄ stub-IdP page interactions, saves `storageState`, `__Host-` cookies survive in the context; asserts `X-CSRF-Token` companion presence + a full comment/status mutation round-trip); iff launch fails (missing shared libs) ⇒ NO system-package surgery tonight: record `E2E NOT RUN: <captured probe error>`, the suite ships green-by-construction in CI-shape (ubuntu runners can run it — QUEUED (HUMAN): operator adds the CI job + any `pacman -S` libs), and the final-gate record states the posture with the probe output quoted (ticket: "states the honest posture either way"). Suite lives at repo-root `e2e/` (vitest `src/**` includes never see it; `playwright.config.ts` root-level, eslint ignores `*.config.ts`); `*.e2e.ts` naming + `testDir: 'e2e'`.

**D-yy — CLI (D-oo handoff): SLICED to F — explicit, not orphaned.** Plan D deferred `nightshift claim|report|next` to E "with the OIDC/UI wave"; ticket #9 explicitly opens the slice choice. Decision: slice. Tonight's critical path is a security boundary (RP + sessions + CSRF + a new public surface) — mixing in a human-facing CLI multiplies review surface with zero board value while nobody's awake; the substrate is DONE and stays done (D-kk generated client, drift-pinned); §12's CLI entry stays listed; **F's plan owns the CLI** (with the deploy work it rides), stated in this plan AND restated in the final-gate record + PR body so the handoff chain shows no break. Nothing in tonight's scope is CLI-shaped except the Playwright smoke, which rides the UI.

**D-zz — Contract-regen duty: seven new yaml operations (4 `auth` incl. `GET /auth/me` + 3 `admin`), the `Actor.role` addition, and the regenerated committed client artifact are ONE recorded contract move.** New documented ops (`tag: auth`): `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout` (3xx/redirect ops documented with their problem+json `default`; `security: []` — pre-session/cookie-posture stated in descriptions; `[]` on logout is DELIBERATE — the drift test pins path×method only and cannot see the security field, so that is honest documentation, not a machine pin — review note (j)) and `GET /auth/me` (identity echo for the SPA shell: returns the caller's `ActorRef` incl. role — any authenticated actor; the UI nav/admin-gate need it and inventing a UI-only endpoint would fork identity truth); `tag: admin`: `GET/POST /admin/allowlist`, `DELETE /admin/allowlist/{email}` (`requireHuman+requireAdmin` — `security: bearerAuth` global default). `Actor` schema gains `role` (`type: ["string","null"], enum: ['admin','member',null]`). Every addition lands in the SAME commit as the route that serves it (drift `toEqual(documented)` is the machine enforcer — a yaml entry without a route or a route without yaml is RED), and every such commit ALSO runs `pnpm gen:client` and commits the regenerated `src/client/schema.d.ts` byte-clean (the D-kk drift test byte-compares regen+repo-prettier against the artifact — a stale artifact breaks the suite, same load-bearing posture Plan D shipped). STATIC_ROUTES/MCP_ROUTES are the ONLY undocumentable served keys, both exact-set-pinned (D-ll precedent; D-vv). `Problem.code` enum byte-untouched (zero new codes across all of Plan E — D-tt/D-ss/D-ww all reuse `forbidden`/`invalid_request`/`not_found`/`unauthenticated`).

## Backlog disposition (ticket #9 scope table → tasks)

| Ticket item                                                                                                                | Where                                                                     |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1. OIDC RP PKCE + stub IdP + `NS_OIDC_*` config + D-ff secret posture                                                      | Task 1 (config), Task 5 (RP core + stub IdP), Task 6 (routes)             |
| 2. Signed httpOnly cookie sessions inside existing auth hook + store shape + CSRF placement                                | Task 3 (codec+store), Task 4 (hook arm + CSRF), D-qq/D-rr                 |
| 3. `admin`/`member` roles, `requireHuman` pins stay green, separately pinned gate                                          | Task 2 (storage), Task 4 (requireAdmin + matrix)                          |
| 4. First-login / allow-list enablement + deny posture pinned                                                               | Task 6 (allow-list surface), Task 7 (decision tree in the callback route) |
| 5. SvelteKit static UI `adapters/sveltekit/`, five §8 views, `/events` polling, PUBLIC_PATHS exact-set ruling              | Tasks 8–10 (D-vv exact-sets)                                              |
| 6. §11.5 Playwright smoke + honest runner posture                                                                          | Task 11 (D-xx)                                                            |
| 7. CLI decision (D-oo)                                                                                                     | **D-yy: sliced to F — decided here, restated in final record + PR body**  |
| SSE / search UI / undo / keepalive enforcement / capability scopes / Docker / `openapi/` shipping / FTS deploy-smoke / §13 | **Untouched — frozen (ticket "Explicitly sliced out")**                   |

## File structure (created / modified / why)

**Create (production, `src/`):** `src/adapters/shared/session-codec.ts` (pure cookie sign/verify/parse — D-qq), `src/infra/sqlite/session-repo.ts` + `src/infra/sqlite/allowlist-repo.ts`, `src/adapters/shared/oidc-rp.ts` (discovery/token/verify + flow cookie — D-pp), `src/application/usecases/provision-human.ts` + `src/application/usecases/manage-allowlist.ts`, `src/adapters/rest/routes/auth.ts`, `src/adapters/rest/ui.ts` (static mount — D-vv).
**Create (test-side):** `src/testing/stub-idp.ts` (+ `src/testing/stub-idp-main.ts` runner for e2e), `src/adapters/shared/session-codec.test.ts`, `src/adapters/shared/oidc-rp.test.ts`, `src/adapters/rest/routes/auth.test.ts`, `src/adapters/rest/scenarios-auth.test.ts`, `src/adapters/rest/ui.test.ts`, `src/infra/sqlite/session-repo.test.ts` + allowlist-repo test, usecase tests colocated, `e2e/*.e2e.ts` + `playwright.config.ts`.
**Create (UI, outside `src/`):** `adapters/sveltekit/{package.json,svelte.config.js,vite.config.ts,src/**,static/**}` (Task 8 scaffold, Task 9 views).
**Modify:** `package.json` (deps + `ui:*`/`test:e2e` scripts), `pnpm-workspace.yaml` (`packages:` gains `adapters/sveltekit`), `.prettierrc` (svelte override), `src/main/config.ts`+test, `src/main/deps.ts` (`sessionsRoot`, `allowlistRoot`, `fetch` seam, 2 use-cases), `src/domain/task.ts` (`HUMAN_ROLES`), `src/main/bootstrap.ts` + its test (bootstrap `role:'admin'`; the ActorRef/ActorRow typecheck ripple enumerated in Task 2 Step 4 also hits `actor-repo.test.ts`, `bridge.test.ts` and usecase ctx test files — R7), `src/infra/sqlite/migrations.ts`+`schema.ts`+`migrations.test.ts`, `src/application/ports.ts`, `src/infra/sqlite/actor-repo.ts`, `src/adapters/rest/auth.ts` (role on bearer ActorRef in Task 2; session arm + CSRF + `requireAdmin` + `authVia` + UI-path arm in Tasks 4/10), `src/adapters/rest/app.ts` (`registerAuthRoutes`, `mountUi`), `src/adapters/rest/routes/admin.ts` + `webhooks.ts` (`requireAdmin` attach), `src/adapters/mcp/mount.ts` (D-ww defensive arm), `src/testing/test-app.ts` (+role seed, optional `fetch`), `src/testing/fixtures.ts`, `openapi/openapi.yaml` (D-zz), `src/client/schema.d.ts` (regen, D-zz).
**Untouched (pinned):** `vitest.config.ts`, `lefthook.yaml`, `.github/workflows/ci.yaml`, `src/domain/errors.ts`, `mount.test.ts` 35-snapshot, PUBLIC_PATHS literal + its test arm, root `setNotFoundHandler`, `problem.ts`, idempotency/rate-limit hooks.

## Task 1: Runtime deps + OIDC/session config seams

**Files:**

- Modify: `package.json` (deps via pnpm), `pnpm-lock.yaml` (ships as installed), `src/main/config.ts`, `src/main/config.test.ts`

- [ ] **Step 1: Install the two sanctioned runtime exceptions (D-pp/D-vv) — exact versions, no caret**

```bash
pnpm add jose@6.2.12 @fastify/static@10.1.3
```

Both MIT, permissive per D14. Neither builds native code ⇒ `pnpm-workspace.yaml` `onlyBuiltDependencies` stays `{esbuild, better-sqlite3}` untouched.

- [ ] **Step 2: Write the failing config tests (extend `src/main/config.test.ts`)**

The defaults `toEqual` block (config.test.ts:6-16) gains the new members; the matrix tests pin D-qq's config triad and D-pp's trailing-slash strip:

```ts
// appended to the existing describe in src/main/config.test.ts — the defaults
// toEqual block ABOVE gains these keys (undefined members listed for grep-visibility
// + future-default tripwire; vitest toEqual tolerates undefined either way):
//   oidcIssuer: undefined, oidcClientId: undefined, oidcClientSecret: undefined,
//   oidcScope: 'openid profile email', publicUrl: undefined,
//   sessionKey: undefined, sessionTtlS: 28_800,

describe('plan E config seams (D-pp/D-qq)', () => {
  const oidcEnv = {
    NS_DB_PATH: ':memory:',
    NS_OIDC_ISSUER: 'https://id.example.com/',
    NS_OIDC_CLIENT_ID: 'nightshift',
    NS_PUBLIC_URL: 'http://localhost:3123/',
    NS_SESSION_KEY: 'k'.repeat(32),
  }

  it('strips trailing slashes from issuer and public URL', () => {
    const c = loadConfig(oidcEnv)
    expect(c.oidcIssuer).toBe('https://id.example.com')
    expect(c.publicUrl).toBe('http://localhost:3123')
  })

  it('OIDC configured WITHOUT a session key is invalid env', () => {
    const { NS_SESSION_KEY: _drop, ...env } = oidcEnv
    expect(() => loadConfig(env)).toThrow(/invalid env/)
  })

  it('OIDC configured WITHOUT NS_PUBLIC_URL is invalid env', () => {
    const { NS_PUBLIC_URL: _drop, ...env } = oidcEnv
    expect(() => loadConfig(env)).toThrow(/invalid env/)
  })

  it('session key WITHOUT OIDC is legal (dormant); issuer WITHOUT client id is dormant', () => {
    expect(() =>
      loadConfig({ NS_DB_PATH: ':memory:', NS_SESSION_KEY: 'k'.repeat(32) })
    ).not.toThrow()
    expect(() =>
      loadConfig({ NS_DB_PATH: ':memory:', NS_OIDC_ISSUER: 'https://id.example.com' })
    ).not.toThrow()
  })

  it('oidcEnabled is the single truth for the enabled posture', () => {
    expect(oidcEnabled(loadConfig(oidcEnv))).toBe(true)
    expect(oidcEnabled(loadConfig({ NS_DB_PATH: ':memory:' }))).toBe(false)
  })
})
```

- [ ] **Step 3: Run to verify RED**: `pnpm test src/main/config.test.ts` → FAIL (unknown keys' defaults + missing `oidcEnabled` export).

- [ ] **Step 4: Implement (`src/main/config.ts`)** — EnvSchema gains, in declaration order after the webhook keys, plus the object-level fail-closed matrix BEFORE `.safeParse` usage (superRefine on `EnvSchema` via `.superRefine`). Shipped form below: prettier merged the gains block and the superRefine block into ONE `EnvSchema` const chain (see Amendment):

```ts
// src/main/config.ts — EnvSchema (gains + fail-closed matrix, chain merged by prettier) — sync = shipped form (see Amendment)
const EnvSchema = z
  .object({
    NS_PORT: z.coerce.number().int().min(1024).max(65535).default(3123),
    NS_DB_PATH: z.string().min(1).default('./nightshift.db'),
    NS_BOOTSTRAP_TOKEN: z.string().min(32).optional(),
    NS_DATA_DIR: z.string().min(1).default('./data'),
    NS_MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).default(20_971_520),
    NS_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(0).default(120),
    NS_WEBHOOK_INTERVAL_MS: z.coerce.number().int().min(0).default(1_000),
    NS_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),
    NS_WEBHOOK_MAX_BACKOFF_MS: z.coerce.number().int().min(1_000).default(300_000),
    // Plan E (D-pp/D-qq): OIDC RP + cookie sessions. All optional — the suite and
    // every pre-E deployment stays byte-identical when absent (dormant). Trailing
    // slashes are STRIPPED here once: issuer string-equality (D-pp) and the
    // redirect_uri are built from these exact values.
    NS_OIDC_ISSUER: z
      .string()
      .min(1)
      .optional()
      .transform((v) => v?.replace(/\/+$/, '')),
    NS_OIDC_CLIENT_ID: z.string().min(1).optional(),
    // D-ff posture: env-only, never logged, never printed in tests; sent in the
    // token-endpoint BODY only (client_secret_post), never the URL.
    NS_OIDC_CLIENT_SECRET: z.string().min(8).optional(),
    NS_OIDC_SCOPE: z.string().min(1).default('openid profile email'),
    NS_PUBLIC_URL: z
      .string()
      .min(1)
      .optional()
      .transform((v) => v?.replace(/\/+$/, '')),
    NS_SESSION_KEY: z.string().min(32).optional(),
    NS_SESSION_TTL_S: z.coerce.number().int().min(60).max(2_592_000).default(28_800),
    // fail-closed matrix (D-qq): once OIDC is configured (issuer AND client id),
    // the session key and our own public URL are REQUIRED — a half-configured
    // login surface is worse than no login surface.
  })
  .superRefine((e, ctx) => {
    if (e.NS_OIDC_ISSUER && e.NS_OIDC_CLIENT_ID) {
      if (!e.NS_SESSION_KEY) {
        ctx.addIssue({
          code: 'custom',
          message: 'NS_SESSION_KEY is required when OIDC is configured',
          path: ['NS_SESSION_KEY'],
        })
      }
      if (!e.NS_PUBLIC_URL) {
        ctx.addIssue({
          code: 'custom',
          message: 'NS_PUBLIC_URL is required when OIDC is configured',
          path: ['NS_PUBLIC_URL'],
        })
      }
    }
  })
```

`Config` gains `oidcIssuer?: string; oidcClientId?: string; oidcClientSecret?: string; oidcScope: string; publicUrl?: string; sessionKey?: string; sessionTtlS: number` + return-map entries, and the export:

```ts
/** The SINGLE enabled-truth (D-pp/D-qq): superRefine above guarantees the other
 * three members whenever issuer+clientId are set, so this guard is complete. */
export const oidcEnabled = (
  c: Config
): c is Config & {
  oidcIssuer: string
  oidcClientId: string
  publicUrl: string
  sessionKey: string
} => Boolean(c.oidcIssuer && c.oidcClientId && c.publicUrl && c.sessionKey)
```

- [ ] **Step 5: Full gates + commit** (`pnpm test && pnpm lint && pnpm typecheck`; the suite-wide `toEqual` defaults pin proves zero behavior drift for pre-E env):

```bash
git add package.json pnpm-lock.yaml src/main/config.ts src/main/config.test.ts
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(config): OIDC/session env seams with fail-closed matrix (D-pp/D-qq)"
```

> **Amendment (Task 1, @implementer — prettier merged the Step-4 blocks; sync = shipped form):** (1) The two Step-4 code blocks ship as ONE `EnvSchema` const: prettier (printWidth 100) reflows `z.object({...}).superRefine(...)` as the chain `z\n  .object({…})\n  .superRefine(…)`, so the gains sit at +2 indent inside the object and the planned single-line `ctx.addIssue({ code: 'custom', … })` arms (118/112 chars) exceed printWidth and ship multi-line. The block above was replaced with the shipped bytes verbatim and labeled `sync = shipped form`; key order, transforms, messages and paths are byte-verbatim from the plan. (2) Step 2's test additions ship byte-verbatim — the appended `describe` block and the `oidcEnabled` export block are identical to their planned text (`prettier --check`: unchanged); the defaults-`toEqual` gains landed as the comment's listed keys in `Config` return-order. (3) Step 3 RED honestly measured: **5 failed / 9 passed** — defaults `toEqual` (missing `oidcScope`/`sessionTtlS` values), trailing-slash strip, both fail-closed arms, and `TypeError: oidcEnabled is not a function` — exactly the step's predicted "unknown keys' defaults + missing `oidcEnabled` export"; honest footnote: the fourth new test ("session key WITHOUT OIDC is legal (dormant)") PASSED pre-implementation because the pre-E schema already ignores unknown env keys — it is a dormant-legality pin, not RED evidence, and none is claimed from it. (4) Step 1 installs first-run clean: `jose@6.2.12` + `@fastify/static@10.1.3` exact-pinned (no carets); `@fastify/static` sorts alphabetically above `@modelcontextprotocol/server` in `dependencies` — pnpm placement, not a divergence; `pnpm-workspace.yaml` `onlyBuiltDependencies` untouched (`{esbuild, better-sqlite3}`); the `openapi-typescript ✕ unmet peer typescript@^5.x` warning PRE-DATES this task (repo pins TS 6.0.3) and is unrelated. (5) zod@4.5.4 nuance: `ctx.addIssue({ code: 'custom', … })` compiles and runs green as planned — no repair needed. **Gates:** `pnpm test` **517→522 passed / 74 files** (+5, all in `config.test.ts`; no other test file added/edited); `pnpm lint` 0 issues; `pnpm typecheck` clean; the suite-wide defaults `toEqual` pin proves zero behavior drift for pre-E env.

## Task 2: Identity persistence — roles, oidc_subject, sessions, allow-list, contract + client regen

**Files:**

- Modify: `src/domain/task.ts` (+`HUMAN_ROLES`), `src/infra/sqlite/migrations.ts` (ONE new migration), `src/infra/sqlite/schema.ts`, `src/infra/sqlite/migrations.test.ts` (`TABLES` pin), `src/application/ports.ts` (`ActorRow`/`ActorRef` +role), `src/infra/sqlite/actor-repo.ts`, `src/adapters/rest/auth.ts` (bearer ActorRef +role), `src/adapters/rest/routes/admin.ts` (createActor body `role`), `src/application/usecases/manage-actors.ts` (role input), `openapi/openapi.yaml` (`Actor.role`, createActor body), `src/client/schema.d.ts` (regen), `src/testing/test-app.ts` + `src/testing/fixtures.ts` (role in seeds), `src/main/bootstrap.ts` (bootstrap `role: 'admin'` — R7) + the Step-4 typecheck-ripple test files (`bootstrap.test.ts`, `actor-repo.test.ts`, `bridge.test.ts`, usecase ctx test files)

- [ ] **Step 1: Failing migration tests** (`src/infra/sqlite/migrations.test.ts`): `TABLES` gains `'oidc_allowlist'` and `'sessions'` (sorted-exact pin ⇒ RED first run); plus the backfill test — run the migrator to the PRE-E head, insert humans+agents, then `migrateToLatest` (requires the one-line `export const MIGRATIONS = migrations` added beside the provider at the top of `migrations.ts` — the test uses it to stop at the PRE-E HEAD (fix6: `'2026-09-12_webhooks'` — kysely sorts migration names LEXICOGRAPHICALLY: `2026-09-12_fts_search < 2026-09-12_inbox_claim_conflict < 2026-09-12_webhooks`, so fts_search is NOT the head)):

```ts
it('human-identity migration: humans pre-E backfill to admin, agents NULL; tables exist', async () => {
  const db = makeDb(':memory:')
  const { MIGRATIONS } = await import('#root/infra/sqlite/migrations')
  const migrator = new Migrator({ db, provider: { getMigrations: async () => MIGRATIONS } })
  // PRE-E HEAD = webhooks (fix6): kysely sorts names lexicographically; fts_search is NOT the head
  const { error } = await migrator.migrateTo('2026-09-12_webhooks')
  expect(error).toBeUndefined()
  await db
    .insertInto('actors')
    .values([
      {
        id: 'a_pre_human',
        kind: 'human',
        handle: 'prehum',
        display_name: 'Pre',
        description: '',
        created_at: '2026-09-01T00:00:00.000Z',
      },
      {
        id: 'a_pre_agent',
        kind: 'agent',
        handle: 'preagent',
        display_name: 'PreA',
        description: '',
        created_at: '2026-09-01T00:00:00.000Z',
      },
    ])
    .execute()
  await migrateToLatest(db)
  const rows = await db
    .selectFrom('actors')
    .select(['id', 'role', 'oidc_subject'])
    .orderBy('id') // fix7: no implicit row order after the migration — pin the array's order
    .execute()
  expect(rows).toEqual([
    { id: 'a_pre_agent', role: null, oidc_subject: null },
    { id: 'a_pre_human', role: 'admin', oidc_subject: null },
  ])
  const pol = await db
    .selectFrom('policy')
    .where('key', '=', 'oidc_provisioning')
    .select('value')
    .executeTakeFirst()
  expect(pol?.value).toBe('off')
  await db.destroy()
})
```

(`migrations.ts` therefore gains `export const MIGRATIONS = migrations` — one line, pinned used.)

- [ ] **Step 2: Run** → RED (`TABLES` exact-set fail; unknown `role` column fail).

- [ ] **Step 3: The migration** (`migrations.ts`, appended to the record AFTER `'2026-09-12_fts_search'` so it sorts last; `migrations.ts` top gains `export const MIGRATIONS = migrations` beside the provider):

```ts
  '2026-09-13_human_identity': {
    up: async (db: Kysely<DB>) => {
      // D-ss (AMENDED pre-dispatch, preflight P4/fix5 — amendment ledger): ADD
      // COLUMN, NOT a _v2 rebuild. The 2026-09-12_inbox_claim_conflict exemplar
      // drops a CHILD table; actors is a PARENT — eight pre-E tables carry
      // references actors(id) — and with makeDb's foreign_keys=ON a parent DROP
      // throws FOREIGN KEY constraint failed inside the migration transaction on
      // any deployed DB with child rows (defer_foreign_keys still fails at COMMIT
      // even with the parent restored by name; foreign_keys=OFF is a no-op
      // mid-transaction — both probe-recorded; actors-only test fixtures cannot
      // see it). ADD COLUMN + a UNIQUE INDEX enforce the identical semantics: the
      // CHECK rejects non-vocabulary roles; the index rejects duplicate subjects
      // and permits many NULLs. Roles + subject ride the actors row itself (the
      // auth hot path already loads it; a side table would fork actor truth).
      await sql`alter table actors add column role text check (role in ('admin','member'))`.execute(db)
      await sql`alter table actors add column oidc_subject text`.execute(db)
      await sql`create unique index actors_oidc_subject_u on actors (oidc_subject)`.execute(db)
      // Backfill: every PRE-E human created the board or was admin-created with a
      // login token => 'admin'; MEMBERS arrive only via the D-tt provisioning path.
      await sql`update actors set role = 'admin' where kind = 'human'`.execute(db)

      // D-qq: server-side sessions are the revocation truth; the cookie is a
      // signed pointer, not the state. Lazy expiry on read — no sweeper loop.
      await sql`create table sessions (
        id text primary key,
        actor_id text not null references actors(id),
        csrf text not null,
        created_at text not null,
        expires_at text not null,
        revoked_at text
      )`.execute(db)

      // D-tt: admin-managed first-login allow-list (email = lowercased identity email)
      await sql`create table oidc_allowlist (
        email text primary key,
        added_by text not null references actors(id),
        created_at text not null
      )`.execute(db)

      // fail-closed default (update-status.ts:72-79 lineage): off = deny all first-logins
      await sql`insert into policy (key, value) values ('oidc_provisioning', 'off')`.execute(db)
    },
  },
```

- [ ] **Step 4: Schema + ports + repo + seeds ripple.** `schema.ts`: `ActorsTable` gains `role: 'admin' | 'member' | null; oidc_subject: string | null`; new `SessionsTable`/`OidcAllowlistTable` interfaces + `DB` registry entries (`sessions: SessionsTable`, `oidc_allowlist: OidcAllowlistTable`) (NO table rebuild — the migration ADDs the two columns to `ActorsTable` in place; the interfaces just grow). `domain/task.ts` beside `ACTOR_KINDS`:

```ts
export const HUMAN_ROLES = ['admin', 'member'] as const
export type HumanRole = (typeof HUMAN_ROLES)[number]
```

`ports.ts`: `import type { HumanRole } from '#root/domain/task'`; `ActorRow` and `ActorRef` gain `role: HumanRole | null`. `actor-repo.ts`: `create` input gains `role: HumanRole | null` (into the insert), `findActiveTokenByHash`'s trimmed-actor literal gains `role: <row>.role` (the explicit-mapping site — read the file, add the ONE field, nothing else), and any `selectAll('actors')`-backed mapping rides role automatically. `test-app.ts` human seed values gain `role: 'admin'` (the actors insert); `fixtures.ts` `seedActor` gains a `role` param defaulting `kind === 'human' ? ('admin' as const) : null`. `bootstrap.ts`'s `ensureBootstrapAdmin` create literal gains `role: 'admin'` — comment it `bootstrap IS the admin — D-ss fresh-row rule; role-NULL would 403 the first boot` (review R7/B2). TYPECHECK RIPPLE (review R7/B3): after the ports change run `pnpm typecheck` and fix EVERY failing literal — `role: null` for agent ctx, `role: 'admin'` for human ctx; expected sites: `src/main/bootstrap.test.ts` (if its create-literal needs the field), `src/infra/sqlite/actor-repo.test.ts`, `src/adapters/mcp/bridge.test.ts`, and the application-usecase test files holding ActorContext literals — enumerate the files the sweep found in this task's amendment note and add them all to the commit. `auth.ts` bearer leg ActorRef literal gains `role: hit.actor.role`. `manage-actors.ts` `CreateActorInput` gains `role?: 'admin' | 'member'`; `CreateActor.run` human creations take `input.role ?? 'member'` (members are the default — admins stay an explicit decision), agents force `null`. `routes/admin.ts` createActor body schema gains `role: { type: 'string', enum: ['admin', 'member'], description: 'humans only; default member' }` (dropped for agents by the use-case, never an error).

- [ ] **Step 5: Contract + regen (D-zz).** `openapi.yaml` `Actor` schema gains `role: { type: ['string', 'null'], enum: ['admin', 'member', null] }`; the `createActor` requestBody properties gain `role: { type: string, enum: [admin, member] }` (optional). Then:

```bash
pnpm gen:client
git diff --stat src/client/schema.d.ts   # MUST show the role addition; the drift test pins byte-parity
```

- [ ] **Step 6: Run the touched files green** — `pnpm test src/infra/sqlite/migrations.test.ts src/adapters/rest && pnpm test && pnpm lint && pnpm typecheck && pnpm build` (the build proves declaration emit through the new ports types).

- [ ] **Step 7: Commit:**

```bash
git add src/main/bootstrap.ts src/main/bootstrap.test.ts src/infra/sqlite/actor-repo.test.ts src/adapters/mcp/bridge.test.ts src/domain/task.ts src/infra/sqlite/migrations.ts src/infra/sqlite/schema.ts src/infra/sqlite/migrations.test.ts src/infra/sqlite/actor-repo.ts src/application/ports.ts src/application/usecases/manage-actors.ts src/adapters/rest/auth.ts src/adapters/rest/routes/admin.ts src/testing/test-app.ts src/testing/fixtures.ts openapi/openapi.yaml src/client/schema.d.ts
# + every typecheck-ripple file the Step-4 sweep enumerated (review R7/B3)
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(identity): roles, oidc_subject, sessions, allow-list tables"
```

> **Amendment (Task 2, @implementer — Step-4 ripple enumeration + shipped details):** The Step-3 migration and the Step-1 test blocks are diff-verified byte-identical EXCEPT one lint normalization: the `alter table actors add column role …` statement exceeds printWidth 100 and ships in prettier's wrapped `.execute(⏎ db ⏎ )` form (the `2026-09-12_inbox_claim_conflict` insert precedent) — **Step-3 block: sync = shipped form** (the test block rides the file's describe-indent like every sibling test). Shipped notes: (1) the `pnpm typecheck` sweep found **27 failing ActorRef/ActorContext literals in 12 files**, all fixed (`role: null` agents, `role: 'admin'` humans): `usecases/answer-question.test.ts`, `usecases/claim-task.test.ts` (×2), `usecases/create-task.test.ts` (the exported `human` ctx — the shared driver for the other usecase tests), `usecases/create-thread.test.ts` (×2), `usecases/manage-webhooks.test.ts` (11 call sites flow through ONE shared `actor` const — fixed at the definition), `usecases/mark-inbox-read.test.ts`, `usecases/queries.test.ts`, `usecases/split-task.test.ts` (×4 inline), `usecases/update-question.test.ts`, `usecases/update-status.test.ts`, plus `sqlite/actor-repo.test.ts` (create-input) and `adapters/mcp/bridge.test.ts`. **`bootstrap.test.ts` needed NO field** (it carries no create literal — `ensureBootstrapAdmin` is the only create site; the plan's "if its create-literal needs the field" resolved to false) and is NOT in the commit. (2) `ports.ts` `ActorRepo.create` input gains `role: HumanRole | null` — the interface must carry what the repo class accepts (manage-actors/bootstrap call through the port). (3) `findActiveTokenByHash` "the ONE field" lands as select-alias `actors.role as a_role` + literal `role: r.a_role` (the trimmed mapping reads aliases). (4) `manage-actors.ts` types the input `role?: HumanRole` — the domain alias IS exactly `'admin' | 'member'`; the ternary `kind === 'human' ? (input.role ?? 'member') : null` ships as specified. (5) openapi role properties ship with the repo's YAML prettier style (`type: ["string", "null"]`, unquoted enum members — the existing `AuditEntry`/`kind` normalization). (6) COVERAGE-DUTY test added: `usecases/manage-actors.test.ts` gains a role test (member default / admin explicit / agents forced null) — the `input.role` arm has no other driver; file joins the commit list. (7) Documented-uncovered set unchanged; the `migrations.ts` error arm moved :274→:324 by the appended migration (pure line-shift, same documented arm — cite-nit fixed in the BL1 round: the first coverage read ran BEFORE the prettier wrap added two lines, so :322 was stale). (8) **BL1 (review round on `ffc93c0`, document-don't-trim per §5 nothing-hidden + D-zz):** `GET /admin/actors` (`selectAll`) and `POST /admin/actors` (`.returningAll()`) serialize BOTH new columns, but the committed `Actor` schema carried only `role` — a half-documented contract on the admin identity surface. Repair: the yaml `Actor` gains `oidc_subject` (`type: ["string", "null"]`, description `internal OIDC subject binding; admin-visible`, prettier-wrapped flow form) and `schema.d.ts` regens (+2 lines); TRIM was rejected — the surface hides nothing (§5), the column is admin-visible by D-ss, and a projection trim would ripple existing response pins. Drift byte-pin stays green; zero behavior/test change. All axes ≥ the Plan D record: **99.37 / 97.86 / 99.74 / 99.61** at 524 tests / 74 files.

## Task 3: Session codec + session store (pure seams)

**Files:**

- Create: `src/adapters/shared/session-codec.ts` + `.test.ts`, `src/infra/sqlite/session-repo.ts` + `.test.ts`
- Modify: `src/application/ports.ts` (`SessionRow`/`SessionLookup`/`SessionRepo`), `src/main/deps.ts` (`sessionsRoot`)

- [ ] **Step 1: Failing codec tests** (`src/adapters/shared/session-codec.test.ts` — the never-lower bar wants every arm):

```ts
import { describe, expect, it } from 'vitest'
import {
  clearSessionCookies,
  decodeSessionCookie,
  encodeSessionCookie,
  parseCookies,
  sessionCookieSet,
} from '#root/adapters/shared/session-codec'

const KEY = 'k'.repeat(32)
const NOW = '2026-09-09T12:00:00.000Z'
const FUT = '2026-09-09T20:00:00.000Z'
const PAST = '2026-09-09T11:00:00.000Z'

describe('session codec (D-qq)', () => {
  it('roundtrips a signed payload', () => {
    const raw = encodeSessionCookie({ sid: 's1', exp: FUT }, KEY)
    expect(decodeSessionCookie(raw, KEY, NOW)).toEqual({ sid: 's1', exp: FUT })
  })
  it('rejects a tampered payload and a tampered signature', () => {
    const raw = encodeSessionCookie({ sid: 's1', exp: FUT }, KEY)
    expect(
      decodeSessionCookie(raw.slice(0, -1) + (raw.endsWith('A') ? 'B' : 'A'), KEY, NOW)
    ).toBeNull()
    const [p] = raw.split('.')
    expect(decodeSessionCookie(`${p}.${p}`, KEY, NOW)).toBeNull()
  })
  it('rejects the wrong key, garbage shapes, and a past exp', () => {
    const raw = encodeSessionCookie({ sid: 's1', exp: FUT }, KEY)
    expect(decodeSessionCookie(raw, 'j'.repeat(32), NOW)).toBeNull()
    expect(decodeSessionCookie('nodothere', KEY, NOW)).toBeNull()
    expect(decodeSessionCookie('..', KEY, NOW)).toBeNull()
    expect(
      decodeSessionCookie(encodeSessionCookie({ sid: 's1', exp: PAST }, KEY), KEY, NOW)
    ).toBeNull()
    expect(
      decodeSessionCookie(
        `${Buffer.from(JSON.stringify({ sid: 7, exp: 3 })).toString('base64url')}.x`,
        KEY,
        NOW
      )
    ).toBeNull()
  })
  it('cookie attributes are byte-pinned (__Host-, Secure, Lax, Path=/; HttpOnly on the session leg only)', () => {
    const [sess, csrf] = sessionCookieSet({ sid: 's1', exp: FUT }, 28_800, 'csrfval', KEY)
    expect(sess).toMatch(
      /^__Host-ns_sess=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=28800$/
    )
    expect(csrf).toBe('__Host-ns_csrf=csrfval; Secure; SameSite=Lax; Path=/; Max-Age=28800')
    const [c1, c2] = clearSessionCookies()
    expect(c1).toBe('__Host-ns_sess=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0')
    expect(c2).toBe('__Host-ns_csrf=; Secure; SameSite=Lax; Path=/; Max-Age=0')
  })
  it('parseCookies: absent/empty header, padding, duplicates-first-wins, no-value entries', () => {
    expect(parseCookies(undefined)).toEqual({})
    expect(parseCookies('')).toEqual({})
    expect(parseCookies('  a=1;  b=2 ; a=9 ;flag ;')).toEqual({ a: '1', b: '2' })
  })
})
```

- [ ] **Step 2: Run** → RED (module absent). **Step 3: Implement** (`src/adapters/shared/session-codec.ts`):

```ts
// D-qq: signed envelope cookie codec — pure crypto + strings, no db, no fastify.
// The TABLE is the revocation truth; the cookie is a signed pointer that cannot
// outlive its own signed exp (OWASP session-management: sid>=128-bit entropy,
// expiry inside the payload, constant-time verify, __Host- prefix).
import { createHmac, timingSafeEqual } from 'node:crypto'

export interface SessionCookieValue {
  sid: string
  exp: string // ISO — the OUTER bound; the sessions row is authoritative (D-qq)
}

const mac = (payload: string, key: string): string =>
  createHmac('sha256', key).update(payload, 'utf8').digest('base64url')

export const encodeSessionCookie = (v: SessionCookieValue, key: string): string => {
  const payload = Buffer.from(JSON.stringify(v), 'utf8').toString('base64url')
  return `${payload}.${mac(payload, key)}`
}

export const decodeSessionCookie = (
  raw: string,
  key: string,
  nowIso: string
): SessionCookieValue | null => {
  const dot = raw.lastIndexOf('.')
  if (dot < 1) return null
  const payload = raw.slice(0, dot)
  const want = Buffer.from(mac(payload, key), 'utf8')
  const got = Buffer.from(raw.slice(dot + 1), 'utf8')
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  let v: unknown
  try {
    v = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  const c = v as SessionCookieValue
  if (typeof c.sid !== 'string' || typeof c.exp !== 'string') return null
  if (c.exp <= nowIso) return null // ISO-strings sort lexicographically
  return { sid: c.sid, exp: c.exp }
}

// Byte-pinned attribute strings (D-rr companion leg is deliberately NOT HttpOnly —
// the SPA must read it into X-CSRF-Token). __Host- demands Secure+Path=/+no Domain;
// on inject the attributes ride as inert strings — homelab runs behind https.
const ATTRS = 'Secure; SameSite=Lax; Path=/'
export const sessionCookieSet = (
  v: SessionCookieValue,
  ttlS: number,
  csrf: string,
  key: string
): [session: string, csrf: string] => [
  `__Host-ns_sess=${encodeSessionCookie(v, key)}; HttpOnly; ${ATTRS}; Max-Age=${ttlS}`,
  `__Host-ns_csrf=${csrf}; ${ATTRS}; Max-Age=${ttlS}`,
]

export const clearSessionCookies = (): [session: string, csrf: string] => [
  `__Host-ns_sess=; HttpOnly; ${ATTRS}; Max-Age=0`,
  `__Host-ns_csrf=; ${ATTRS}; Max-Age=0`,
]

export const parseCookies = (header: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const pair = part.trim()
    const eq = pair.indexOf('=')
    if (eq < 1) continue
    const name = pair.slice(0, eq)
    if (!(name in out)) out[name] = pair.slice(eq + 1) // first wins (RFC 6265 §5.4)
  }
  return out
}
```

- [ ] **Step 4: Failing repo tests, then implement.** Ports (`ports.ts`, after `ActorRepo`):

```ts
export interface SessionRow {
  id: string
  actor_id: string
  csrf: string
  created_at: string
  expires_at: string
  revoked_at: string | null
}
export interface SessionLookup {
  session: SessionRow
  actor: ActorRow
}
/** D-qq: server-side truth for cookie sessions; lazy expiry on read, no sweeper. */
export interface SessionRepo {
  create(input: {
    id: string
    actor_id: string
    csrf: string
    created_at: string
    expires_at: string
  }): Promise<void>
  findValid(id: string, now: string): Promise<SessionLookup | null>
  revoke(id: string, at: string): Promise<void>
}
```

`src/infra/sqlite/session-repo.ts` — `class SqliteSessionRepo implements SessionRepo`, constructor `(private readonly db: Kysely<DB>)`; `findValid` is the actor-repo.ts:63-97 join exemplar VERBATIM in shape (explicit alias columns — never bare `selectAll()` on joins, the bug pinned at `:33-47`; trimmed-actor posture: `description: ''`, `created_at: ''`):

```ts
  async findValid(id: string, now: string): Promise<SessionLookup | null> {
    const row = await this.db
      .selectFrom('sessions')
      .innerJoin('actors', 'actors.id', 'sessions.actor_id')
      .selectAll('sessions')
      .select([
        'actors.id as a_id',
        'actors.kind as a_kind',
        'actors.handle as a_handle',
        'actors.display_name as a_display_name',
        'actors.role as a_role',
      ])
      .where('sessions.id', '=', id)
      .where('sessions.revoked_at', 'is', null)
      .where('sessions.expires_at', '>', now) // ISO lexicographic — same story as every timestamp here
      .executeTakeFirst()
    if (!row) return null
    const { a_id, a_kind, a_handle, a_display_name, a_role, ...session } = row
    return {
      session: { ...session, revoked_at: null }, // the where-arm guarantees null; shape kept total
      actor: {
        id: a_id,
        kind: a_kind,
        handle: a_handle,
        display_name: a_display_name,
        role: a_role,
        description: '',
        created_at: '',
      },
    }
  }
  async revoke(id: string, at: string): Promise<void> {
    await this.db.updateTable('sessions').set({ revoked_at: at }).where('id', '=', id).execute()
  }
```

(`create` is a plain insert — 3 lines.) Tests: valid lookup rides `csrf`+`role`; expired row (expires_at past) → null; revoked row → null; unknown id → null; revoke then findValid → null. `deps.ts`: `sessionsRoot: SqliteSessionRepo` (root connection, beside `actorsRoot` — `new SqliteSessionRepo(db)`; auth-path repo, NOT in the tx `Repos` seam — same dual-wiring rationale as `actorsRoot`, stated in the one-line comment).

- [ ] **Step 5: Gates + commit:**

```bash
git add src/adapters/shared/session-codec.ts src/adapters/shared/session-codec.test.ts src/infra/sqlite/session-repo.ts src/infra/sqlite/session-repo.test.ts src/application/ports.ts src/main/deps.ts
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(sessions): signed cookie codec + sessions store (D-qq)"
```

> **Amendment (Task 3, @implementer — Step-1 pins byte-clean; Step-3 ships in the generic-delegate form; measured REDs honest):** (1) **Step-1 test block: sync = shipped form** — diff-verified byte-identical (imports region and body) inside the shipped test file. The file ADDS a second describe (`session codec — valid-signature shape gate (never-lower arms)`, plus one `createHmac` import line placed AFTER the block's import so the block stays contiguous): every reject in the pinned block dies at the SIGNATURE gate, so the parse/shape arms were unreachable from it — the never-lower bar closes them with key-signed payloads (non-JSON `notjson`, non-object `7`, `null`, and `{sid:7,exp:FUT}` / `{sid:'s1',exp:3}` wrong-shape). (2) **Step-3 codec block: SUPERSEDED by the generic refactor, landed early per the Task-3 dispatch** (Task 5's Step-2 pair — `encodeSignedJson(obj: object, key)` / `decodeSignedJson<T>(raw, key, nowIso, validate: (v: unknown) => v is T): T | null`; `encodeSessionCookie`/`decodeSessionCookie` DELEGATE via an `isSessionCookieValue` guard). The verbatim block WAS landed first and measured GREEN against the pinned tests; the arm-coverage tests then went RED honestly against it — `decodeSessionCookie` on a key-signed `null` payload threw `TypeError: Cannot read properties of null (reading 'sid')` at the block's `v as SessionCookieValue` deref. The shipped `decodeSignedJson` therefore also rejects signed non-objects (`typeof v !== 'object' || v === null → null`) and enforces `exp:string + exp>nowIso` generically (every Plan E signed payload carries `exp`); `validate` owns the rest of the shape. One stated behavior delta: the delegate returns the parsed object itself (a key-holder's extra signed fields ride through; the pre-refactor copy stripped them) — no pinned observable moves; the refactor re-ran the Task-3 suite with ZERO test-file edits and it stayed green (7/7). **Task 5 Step 2 is consumed by this amendment: it ships the flow-cookie `validate` riding `decodeSignedJson` only — the codec Modify-line duty is DONE.** (3) **Step-4 ports block: sync = shipped form** — verbatim, placed after `ActorRepo`; one convention line `// ---- sessions (D-qq)` sits above the block (file-section header, surrounding placement, not block content). (4) **Step-4 repo block: sync = shipped form** — `findValid`/`revoke` byte-identical (only divergence: the shipped class separates methods with a blank line; the plan block abuts them — whitespace-only, prettier-clean); `create` is the 3-line plain insert; class gains the D-qq root-connection why-comment. Tests ride the `actor-repo.test.ts` style (`freshDb` + `seedActor`): valid lookup `toEqual`-pins the WHOLE session row and the WHOLE trimmed actor (csrf + role 'member' ride; `description:''`/`created_at:''` — never join bleed-through), expired→null, unknown→null, revoke-then-findValid→null. (5) **deps.ts shipped form:** `sessionsRoot: SqliteSessionRepo` on `AppDeps` beside `actorsRoot` with the one-line rationale `// D-qq: auth-path repo, NOT in the tx Repos seam — same dual-wiring rationale as actorsRoot`, wired `sessionsRoot: new SqliteSessionRepo(db)` on the root connection. (6) Never-lower: `session-codec.ts` and `session-repo.ts` are 100/100/100/100 each; globals MOVED UP: 99.39 / 97.95 / 99.75 / 99.63 vs the Plan D record 99.36 / 97.81 / 99.74 / 99.61. Counts 524/74 → **534/76**; lint 0, typecheck clean. There is no RED to claim for the repo/pins-first-run arms only where stated: the pinned codec block went RED first on module-absent, the repo tests RED first on module-absent, and the shape-gate block RED honestly on the signed-`null` TypeError — all measured, none claimed retroactively.

## Task 4: Auth-hook session arm + CSRF enforcement + `requireAdmin` + D-ww + the role/CSRF matrices

**Files:**

- Modify: `src/adapters/rest/auth.ts` (decorations + session arm + `requireAdmin`), `src/adapters/rest/idempotency.ts` (`export` the `MUTATING` set — one word), `src/adapters/rest/routes/admin.ts` + `webhooks.ts` (`requireAdmin` attach on all ten), `src/adapters/mcp/mount.ts` (defensive D-ww arm), `src/adapters/rest/auth.test.ts` (bearer ActorRef byte-pins ride role), new `src/adapters/rest/roles-matrix.test.ts` + `src/adapters/rest/session-auth.test.ts`

- [ ] **Step 1: Failing matrix tests FIRST.** `roles-matrix.test.ts` — a member human seeded via `seedActor` (role member) + `seedToken`, bearer headers, EVERY pinned op (this test IS the ticket's "role enforcement is an additional, separately pinned gate"):

```ts
// The ten admin ops + the exact rejection shape. Member => 403 with the pinned
// string; admin (t.adminToken) => today's behavior byte-unchanged (covered by
// the existing admin suites staying green). Members keep EVERYTHING else —
// the positive control is the same member 201 on POST /tasks.
const ADMIN_OPS: ReadonlyArray<{ m: string; url: string; body?: unknown }> = [
  { m: 'GET', url: '/admin/actors' },
  { m: 'POST', url: '/admin/actors', body: { kind: 'agent', handle: 'h', display_name: 'H' } },
  { m: 'POST', url: '/admin/actors/a_nils/tokens', body: { label: 'l' } },
  { m: 'POST', url: '/admin/tokens/tok_nils/revoke' },
  { m: 'GET', url: '/admin/policy/review_gate' },
  { m: 'PUT', url: '/admin/policy/review_gate', body: { value: 'on' } },
  { m: 'GET', url: '/admin/webhooks' },
  { m: 'POST', url: '/admin/webhooks', body: { agent_id: 'a_none', url: 'http://x.example/h' } },
  { m: 'POST', url: '/admin/webhooks/w_none/rotate-secret' },
  { m: 'DELETE', url: '/admin/webhooks/w_none' },
]
// member loop: expect(res.body.code).toBe('forbidden') +
//   detail 'this endpoint requires the admin role (spec §5)' — one string, pinned.
// positive control: member POST /tasks {title, status:'todo'} => 201.
```

`session-auth.test.ts` — cookie sessions handcrafted WITHOUT OIDC (the codec + `sessionsRoot` are tonight's seams): a helper mints `sessionsRoot.create({id:'s_1', actor_id:'a_nils', csrf:'c_1', created_at, expires_at: +8h})` + `encodeSessionCookie({sid:'s_1', exp}, config.sessionKey!)` via `makeTestApp({NS_SESSION_KEY:'k'.repeat(32)})`:

```ts
// arms pinned:
// 1  GET /tasks with a valid cookie (no bearer)            => 200 (session identity resolves)
// 2  POST /tasks cookie, NO X-CSRF-Token                   => 403 'missing or invalid CSRF token (D-rr)'
// 3  POST /tasks cookie + right X-CSRF-Token               => 201 (and GET /tasks/next-style reads unaffected)
// 4  POST /tasks cookie + WRONG X-CSRF-Token               => 403 (D-rr)
// 5  tampered cookie, no bearer                            => 401 detail 'missing bearer token (Plan E adds human cookie sessions)' (byte-identical fall-through — zero new strings)
// 6  valid signature, row revoked                          => 401 same
// 7  valid signature, row expires_at past (cookie exp future) => 401 same — TABLE is truth (D-qq)
// 8  valid cookie, GET /mcp (and POST)                     => 403 'mcp requires a bearer token (D-ww)'
// 9  cookie+bearer BOTH valid                              => SESSION identity wins (the
//    arm resolves BEFORE the bearer read — R1/D-rr precedence): POST /tasks
//    cookie+bearer NO X-CSRF-Token => 403 D-rr; +right X-CSRF-Token => 201 with
//    authVia 'session'. bearer ALONE (no cookie header)                    => 201
//    no-CSRF byte-path (bearer arm byte-untouched, authVia 'bearer'). Both-credentials
//    /mcp request                                          => the 403 session rejection
//    (D-ww — cookie resolves first; pinned alongside arm 8).
// 10 cookie without config.sessionKey (makeTestApp default) => ignored, falls through (401 as 5)
```

- [ ] **Step 2: Run** → RED. **Step 3: Implement `auth.ts`:** augmentation + decoration gain `authVia: 'bearer' | 'session' | null` and `sessionId: string | null`; import `{ parseCookies, decodeSessionCookie }` from the codec, `MUTATING` from `./idempotency` (Task 4 exports it — one word, `#root/adapters/rest/idempotency` under nodenext), `timingSafeEqual` from `node:crypto`. The session arm inserts INSIDE the existing hook between the PUBLIC_PATHS return and the bearer header read (the arm goes exactly between the PUBLIC_PATHS return and the bearer header read — `:52-54` is the throw the session arm falls through to, and it stays byte-identical), byte-shape:

```ts
// ---- Plan E session arm (D-qq/D-rr): IN THIS HOOK, at the commented seam — no
// new onRequest hook exists; hook order auth→idem→rate-limit is byte-unchanged.
// A garbage/expired/absent-key cookie FALLS THROUGH to the bearer arm: a
// caller without a bearer gets the byte-identical missing-bearer 401 —
// fail-closed, zero new machine strings.
// Precedence (R1/D-rr): a VALID cookie resolves FIRST — cookie+bearer ⇒ session;
// an explicit bearer does not preempt an ambient cookie.
const sessRaw = parseCookies(request.headers.cookie)['__Host-ns_sess']
if (sessRaw && deps.config.sessionKey) {
  const decoded = decodeSessionCookie(
    sessRaw,
    deps.config.sessionKey,
    deps.clock.now().toISOString()
  )
  if (decoded) {
    const hit = await deps.sessionsRoot.findValid(decoded.sid, deps.clock.now().toISOString())
    if (hit) {
      request.actorRef = {
        id: hit.actor.id,
        kind: hit.actor.kind,
        handle: hit.actor.handle,
        display_name: hit.actor.display_name,
        role: hit.actor.role,
      }
      request.authVia = 'session'
      request.sessionId = hit.session.id
      // D-ww: cookie identity has no MCP surface (spec §5/§10 bearer-only agents).
      if (path === '/mcp' || path.startsWith('/mcp/')) {
        throw new DomainError('forbidden', 'mcp requires a bearer token (D-ww)')
      }
      // D-rr: session-bound CSRF token on every state-changing browser request
      // (OWASP 2026: session-bound double-submit; SameSite is NOT the replacement).
      if (MUTATING.has(request.method)) {
        const hdr = request.headers['x-csrf-token']
        const want = Buffer.from(hit.session.csrf, 'utf8')
        const got = Buffer.from(typeof hdr === 'string' ? hdr : '\u0000no-header', 'utf8')
        if (want.length !== got.length || !timingSafeEqual(want, got)) {
          throw new DomainError('forbidden', 'missing or invalid CSRF token (D-rr)')
        }
      }
      return // session identity resolved; bearer never consulted
    }
  }
}
// ---- bearer arm: everything below this line is byte-unchanged from Plan D ----
```

The `path` constant at `:47` is REUSED (already normalized). `requireAdmin` beside `requireHuman` (same R4 async shape, its own why-comment):

```ts
// async on purpose (identical R4 rationale to requireHuman). D-ss: EXACTLY the
// admin ops carry it; the roles-matrix pins both directions (no widening AND
// no narrowing). requireHuman stays attached — role implies human, and the
// defense is deliberately redundant (a session on an agent actor is unshapeable,
// but the gate does not trust that).
export const requireAdmin = async (
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> => {
  if (request.actorRef?.role !== 'admin') {
    throw new DomainError('forbidden', 'this endpoint requires the admin role (spec §5)')
  }
}
```

All ten `preHandler: [requireHuman]` become `preHandler: [requireHuman, requireAdmin]` (admin.ts ×6, webhooks.ts ×4). `mount.ts` handler gains the defensive second layer as its first statement (same machine string; hook-level fires first — the observable pin is arm 8 above; this arm exists so a hook refactor cannot silently open `/mcp`):

```ts
// D-ww second layer (defense-in-depth): the auth hook already refuses
// session identities on /mcp; a future hook refactor must not silently
// open this surface. Same pinned string; reachable only past the hook.
if (request.authVia === 'session') {
  throw new DomainError('forbidden', 'mcp requires a bearer token (D-ww)')
}
```

- [ ] **Step 4: `idempotency.ts`** — `export const MUTATING = new Set([...])` (the word `export`; nothing else moves; the idempotency suite stays green untouched). **Step 5:** `pnpm test && pnpm lint && pnpm typecheck`; existing `auth.test.ts` bearer pins must ride `role` with NO assertion reword — if a `toEqual` on an ActorRef-derived body breaks, the FIX is the production literal (role rides), never the assertion. **Step 6: Commit:**

```bash
git add src/adapters/rest/auth.ts src/adapters/rest/auth.test.ts src/adapters/rest/roles-matrix.test.ts src/adapters/rest/session-auth.test.ts src/adapters/rest/idempotency.ts src/adapters/rest/routes/admin.ts src/adapters/rest/routes/webhooks.ts src/adapters/mcp/mount.ts
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(auth): cookie sessions, CSRF, admin gate, mcp bearer-only"
```

> **Amendment (Task 4, @implementer — arms landed as pinned; honest RED declared; four stated compositions):** (1) **Step-1 blocks shipped as executable files** — the `ADMIN_OPS` literal is byte-from-block; the member loop pins `{op, status, code, detail}` object-equal per op (a failure names the op that opened). The file ADDS a `requireAdmin` guard unit-suite (null/agent/member/admin, mirroring the auth.test.ts guards): the null-actorRef branch is route-unreachable (the auth hook 401s first), so it is pinned directly — same doctrine as `requireHuman`. `session-auth.test.ts` implements arms 1–10 as pinned; arm 4's wrong token is the EQUAL-LENGTH `'x_1'` vs the row's `'c_1'` — reaching the timingSafeEqual-false arm (the length short-circuit is arm 2's absent-header sentinel); arm 8 additionally pins `GET /mcp/anything` (the `startsWith('/mcp/')` arm — the auth.test.ts `/audit/` 401-wall is the proof the hook runs on unmatched URLs) and the both-credentials /mcp 403; arm 3's "GET /tasks/next-style reads unaffected" is pinned through `GET /tasks/next`; arm 9's authVia observation rides a test-local `/_authvia` probe route (pre-boot registration, same /idem-echo doctrine). **Honest RED: 9 of 14 measured RED; arms 5/6/7/10 and the member POST /tasks positive control passed pre-implementation BY DESIGN — they pin the byte-identical fall-through and the no-widening control, and there is no RED phase for them to claim, and none is claimed.** (2) **Step-3's bearer-divider comment ships with an inline honesty parenthetical** — below the `---- bearer arm … byte-unchanged from Plan D ----` line exactly ONE production line was added: `request.authVia = 'bearer'` at the bearer identity-resolution point (D-ww "set where identity resolves"; arm 9 pins `authVia: 'bearer'`). It cannot live above the divider — bearer identity is not resolved there; the claim is otherwise literally true (token-verify/ActorRef/touchToken lines byte-identical). (3) **D-ww mount-level reachability pin** — the plan block pins arm 8 as the observable and states the mount arm "exists so a hook refactor cannot silently open /mcp"; D-ww additionally requires "the mount.ts test proves the arm is REACHABLE". No block specified the mechanism, so it is pinned in `session-auth.test.ts` (ZERO edits to existing test files): a LATE-registered `onRequest` hook (fastify runs root hooks in registration order; the /mcp route registers at boot, so the late hook runs after the auth chain) stamps `authVia: 'session'` on a bearer-resolved request — exactly the future-hook-refactor world this layer guards — and the handler's first statement answers the same 403 `'mcp requires a bearer token (D-ww)'`. The RED measured 405 (handler served past the unguarded guard), proving the simulation reaches the handler. (4) **Authorized review nit applied-per-review (Task-3 reviewer note 3):** the Task 5 Step-2 heading now carries "— CONSUMED by the Task-3 amendment; ship only the flow-cookie validate". **Coverage:** no new unreachable arms (auth.ts stmts/funcs/lines 100, mount guard both-sided); Plan D's documented-uncovered `auth.ts:47` branch (the `?? '/'` nullish on the normalized-path line) is the same line renumbered `:69`; the mount.ts documented family (`:15`, `:45-48`, `:50`) is unchanged, shifted +6 (report: 51-54). Global axes after this task: 99.4 / 98.03 / 99.75 / 99.63 (never-lower floor 99.39 / 97.95 / 99.75 / 99.63 honored).

## Task 5: OIDC RP core + the in-process stub IdP (zero sockets)

**Files:**

- Create: `src/adapters/shared/oidc-rp.ts` + `.test.ts`, `src/testing/stub-idp.ts`
- Modify: `src/main/deps.ts` (`fetch` seam on `AppDeps`, third param on `makeDepsFromDb`), `src/testing/test-app.ts` (optional `fetchFn` passthrough), `src/adapters/shared/session-codec.ts` (generic `encodeSignedJson`/`decodeSignedJson`; session pair delegate — behavior byte-identical, Task 3 pins green untouched)

- [ ] **Step 1: The `fetch` seam.** `AppDeps` gains `/** D-pp: ALL OIDC-initiated HTTP goes here — tests route every call through fastify inject (zero sockets). */ fetch: typeof globalThis.fetch`; `makeDepsFromDb(db, config, fetchFn: typeof globalThis.fetch = globalThis.fetch)` stores it; `makeTestApp(overrides = {}, fetchFn?)` passes it through. No behavior change otherwise (production gets `globalThis.fetch`).

- [ ] **Step 2: Generic signed-JSON in the codec — CONSUMED by the Task-3 amendment; ship only the flow-cookie validate** — `encodeSignedJson(obj, key)` (same payload.sig shape as `encodeSessionCookie`), `decodeSignedJson<T>(raw, key, nowIso, validate: (v: unknown) => v is T): T | null` (constant-time verify, JSON parse, `validate` must enforce `exp`-string-future — the callback flow cookie carries `{state, nonce, verifier, returnTo, exp}`). The two session functions REFACTOR to delegate; Task 3's byte-pins stay green with zero test edits (if they move, the delegate is wrong — fix production, not the pin).

- [ ] **Step 3: Failing RP tests** (`src/adapters/shared/oidc-rp.test.ts`). The stub IdP (`src/testing/stub-idp.ts`) is test-side (coverage-excluded) and speaks ONLY `node:crypto` (hand-rolled compact JWS — deliberately NOT jose, so the RP's jose is the sole verifier under test):

```ts
// buildStubIdp(opts: { issuer: string; clientId: string; clientSecret?: string;
//   redirectUris: string[]; users: Record<string, {sub: string; email: string;
//   preferred_username: string; email_verified?: boolean; nonceAbsent?: boolean;
//   noAtHash?: boolean}> }) → { app: FastifyInstance; key: {kid, pub JWK}; }
// Routes: GET /.well-known/openid-configuration (issuer string-equality,
//   authorization_endpoint ${issuer}/authorize, token_endpoint
//   ${issuer}/api/oidc/token, jwks_uri ${issuer}/.well-known/jwks.json,
//   id_token_signing_alg_values_supported ['RS256'], code_challenge_methods ['S256'])
// GET /.well-known/jwks.json — one RSA-2048 public JWK, kid 'stub-key-1', alg RS256
// GET /authorize — validates client_id, EXACT redirect_uri, code_challenge_method
//   'S256', state+nonce present; user picked by query login_hint (test-only leg);
//   stores code → {userKey, challenge}; 302 `${redirect_uri}?code&state&iss` (RFC 9207)
// POST /api/oidc/token — form: grant_type, code, redirect_uri, client_id,
//   code_verifier (+client_secret when configured → mismatch ⇒ 401 {error:invalid_client});
//   S256 check b64u(sha256(verifier))===challenge; id_token = hand-rolled compact JWS
//   (header {alg:'RS256', kid:'stub-key-1'}) w/ claims iss, sub, aud=clientId, iat,
//   exp+300, nonce (dropped when users[].nonceAbsent — the Pocket-ID unconfirmed-echo
//   arm), email, email_verified (default true), preferred_username, at_hash
//   (half SHA-256 of access_token, omitted when users[].noAtHash); response
//   {access_token: b64u(randomBytes(24)), token_type 'Bearer', expires_in 300, id_token}
//   NOTE (preflight P2/fix2): fastify@5.12.3 has NO built-in urlencoded parser — buildStubIdp
//   MUST register one or every token POST answers 415 FST_ERR_CTP_INVALID_MEDIA_TYPE:
//   app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' },
//     (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))))
export const makeInjectFetch =
  (issuer: string, idp: FastifyInstance, log: string[] = []): typeof globalThis.fetch =>
  async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    log.push(url)
    if (!url.startsWith(issuer)) throw new Error(`stub-idp: refusing non-issuer fetch ${url}`) // THE zero-network pin
    const res = await idp.inject({
      method: (init?.method ?? 'GET') as InjectOptions['method'],
      url: url.slice(issuer.length) || '/',
      headers: (init?.headers ?? {}) as Record<string, string>,
      payload:
        typeof init?.body === 'string'
          ? init.body
          : init?.body instanceof URLSearchParams
            ? init.body.toString() // fix3: exchangeCode posts `body: form` (URLSearchParams) — plan form dropped it
            : undefined,
    })
    // TS6/@types-node-24 response adaptors (Plan D client-smoke precedent):
    // rawPayload→Uint8Array (Buffer≠BodyInit) + OutgoingHttpHeaders→string map (arrays ', '-joined)
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(res.headers))
      headers[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '')
    return new Response(new Uint8Array(res.rawPayload), { status: res.statusCode, headers })
  }
```

Tests (each an honest RED→GREEN against the module's exports — `discover`, `buildAuthorize`, `exchangeCode`, `verifyIdToken`, `oidcStrings` pinned):

```ts
// helper: makeOidcApp(userKey='alice', mutateEnv?) → {t, idp, log} with makeTestApp(
//   {NS_OIDC_ISSUER:'http://idp.test', NS_OIDC_CLIENT_ID:'ns', NS_OIDC_CLIENT_SECRET:'supersecret1',
//    NS_PUBLIC_URL:'http://board.test', NS_SESSION_KEY:'k'.repeat(32)}, makeInjectFetch('http://idp.test', idp.app))
it('discover: doc fields + 5-min cache + single-flight; second call = zero new fetches', ...)
it('buildAuthorize: exact query set (client_id, EXACT redirect_uri http://board.test/auth/callback, response_type=code, scope, state, nonce, S256 challenge=b64u(sha256(verifier))); flow cookie value decodes to the SAME triplet', ...)
it('exchangeCode: form-encodes body incl. client_secret; returns {access_token, id_token}', ...)
it('exchangeCode: non-2xx from the IdP ⇒ plain Error(/token exchange failed/), NEVER a DomainError (500 internal_error via the generic handler — D-tt/D-pp)', ...)
it('verifyIdToken: green path claims ride out; nonce match is constant-time compared', ...)
it('verifyIdToken negatives — each throws: bad nonce; tampered payload; alg none hand-compact (jose refuses outside RS256); second unknown kid signed id_token; expired (env-pinned clock: user stub signs exp-120s — MUST exceed the 60s clockTolerance or jose accepts it); aud mismatch (stub re-signed for other client); at_hash missing ⇒ throw; at_hash wrong ⇒ throw; iss mismatch ⇒ throw', ...)
it('injectFetch refuses ANY non-issuer URL (the /refusing non-issuer fetch/ pin is tonight zero-network guarantee)', ...)
```

- [ ] **Step 4: Implement** (`src/adapters/shared/oidc-rp.ts`; jose via subpaths `jose/jwt/verify`, `jose/jwks/remote` — proof of the minimal footprint; imports ordered for lint):

```ts
// D-pp: the OIDC relying-party core. Every HTTP egress goes through deps.fetch
// (tests: inject-backed, zero sockets). jose owns JWT verification (MIT, 0-dep,
// RFC 8725bis-conformant); at_hash + nonce are OURS (jose verifies neither).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createRemoteJWKSet, customFetch } from 'jose/jwks/remote'
import { jwtVerify } from 'jose/jwt/verify'
import type { AppDeps } from '#root/main/deps'

export interface OidcDiscovery {
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
}

// raw Date.now like rate-limit.ts (throttling decides on real elapsed time, T14 note).
const DISCOVERY_TTL_MS = 300_000
const cache = new Map<
  string,
  { doc: OidcDiscovery; fetchedAt: number; inflight?: Promise<OidcDiscovery> }
>()
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

export const discover = async (deps: AppDeps, issuer: string): Promise<OidcDiscovery> => {
  const hit = cache.get(issuer)
  if (hit && Date.now() - hit.fetchedAt < DISCOVERY_TTL_MS) return hit.doc
  if (hit?.inflight) return hit.inflight // single-flight: a stampede of unknown-kid logins fetches ONCE
  const inflight = (async (): Promise<OidcDiscovery> => {
    const res = await deps.fetch(`${issuer}/.well-known/openid-configuration`, {
      headers: { accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`oidc discovery failed: ${res.status}`)
    const doc = (await res.json()) as OidcDiscovery
    if (
      typeof doc.authorization_endpoint !== 'string' ||
      typeof doc.token_endpoint !== 'string' ||
      typeof doc.jwks_uri !== 'string'
    )
      throw new Error('oidc discovery: missing endpoints')
    cache.set(issuer, { doc, fetchedAt: Date.now() })
    return doc
  })()
  cache.set(issuer, {
    doc:
      hit?.doc ??
      ({ authorization_endpoint: '', token_endpoint: '', jwks_uri: '' } as OidcDiscovery),
    fetchedAt: hit?.fetchedAt ?? 0,
    inflight,
  })
  try {
    return await inflight
  } catch (e) {
    if (hit) cache.set(issuer, hit)
    else cache.delete(issuer)
    throw e
  }
}

const remoteJwks = (deps: AppDeps, jwksUri: string) => {
  let set = jwksCache.get(jwksUri)
  if (!set) {
    set = createRemoteJWKSet(new URL(jwksUri), {
      // PROBED (jose@6.2.12, P1/fix1): the fetch seam is the exported customFetch
      // symbol — a plain `fetch` option key does not exist and is silently IGNORED
      // (jose would fall through to globalThis.fetch and open real sockets in tests).
      [customFetch]: (url, options) => deps.fetch(url, options),
    })
    jwksCache.set(jwksUri, set)
  }
  return set
}
```

The RP surface then continues — `remoteJwks` ships in its PROBED form above (the preflight consumed this machine-check note; ledger P1/fix1):

```ts
export interface OidcFlow {
  state: string
  nonce: string
  verifier: string
  returnTo: string
  exp: string
}
const rnd = (): string => randomBytes(32).toString('base64url')
const s256 = (verifier: string): string =>
  createHash('sha256').update(verifier, 'ascii').digest('base64url')

export const buildAuthorize = (
  deps: AppDeps,
  returnTo: string
): { url: string; flow: OidcFlow } => {
  const cfg = deps.config // narrowed by oidcEnabled at the route (Task 6) — rp keeps the raw config
  const flow: OidcFlow = {
    state: rnd(),
    nonce: rnd(),
    verifier: rnd(),
    returnTo,
    exp: deps.clock.now().toISOString(), // FLOW exp = now + 600s — computed by the caller via clock; see shipped form
  }
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.oidcClientId as string,
    redirect_uri: `${cfg.publicUrl}/auth/callback`,
    scope: cfg.oidcScope,
    state: flow.state,
    nonce: flow.nonce,
    code_challenge_method: 'S256',
    code_challenge: s256(flow.verifier),
  })
  return { url: `${deps.config.oidcIssuer}/authorize?${q}`, flow }
}

export interface OidcTokenSet {
  access_token: string
  id_token: string
}
export const exchangeCode = async (
  deps: AppDeps,
  code: string,
  verifier: string
): Promise<OidcTokenSet> => {
  const doc = await discover(deps, deps.config.oidcIssuer as string)
  const cfg = deps.config
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: `${cfg.publicUrl}/auth/callback`,
    client_id: cfg.oidcClientId as string,
    code_verifier: verifier,
  })
  if (cfg.oidcClientSecret) form.set('client_secret', cfg.oidcClientSecret) // D-ff: body-only, never the URL
  const res = await deps.fetch(doc.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form,
  })
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`) // generic Error ⇒ 500 internal_error (pinned test)
  const body = (await res.json()) as Partial<OidcTokenSet> & { token_type?: string }
  if (typeof body.access_token !== 'string' || typeof body.id_token !== 'string')
    throw new Error('token exchange failed: malformed response')
  if (body.token_type !== 'Bearer' && body.token_type !== 'DPoP')
    throw new Error('token exchange failed: unexpected token_type')
  return { access_token: body.access_token, id_token: body.id_token }
}

export interface IdClaims {
  sub: string
  email?: string
  email_verified?: boolean
  preferred_username?: string
}
const ALG_HASH: Record<string, 'sha256' | 'sha384' | 'sha512'> = {
  RS256: 'sha256',
  RS384: 'sha384',
  RS512: 'sha512', // at_hash digest follows the SIGNING alg (Pocket ID derives it the same way)
}
const eq = (a: string, b: string): boolean => {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

export const verifyIdToken = async (
  deps: AppDeps,
  idToken: string,
  expectedNonce: string,
  accessToken: string
): Promise<IdClaims> => {
  const cfg = deps.config
  const doc = await discover(deps, cfg.oidcIssuer as string)
  // D-pp: algorithms PINNED — allow-list, never derived from the token (RFC 8725bis).
  const { payload, protectedHeader } = await jwtVerify(idToken, remoteJwks(deps, doc.jwks_uri), {
    issuer: cfg.oidcIssuer,
    audience: cfg.oidcClientId,
    algorithms: ['RS256'],
    clockTolerance: 60,
  })
  if (typeof payload.nonce !== 'string' || !eq(payload.nonce, expectedNonce))
    throw new Error('id_token nonce mismatch')
  const alg = protectedHeader.alg
  const hash = ALG_HASH[alg]
  if (!hash) throw new Error(`unexpected id_token alg: ${alg}`)
  if (typeof payload.at_hash !== 'string') throw new Error('id_token missing at_hash')
  const digest = createHash(hash).update(accessToken, 'ascii').digest()
  if (!eq(payload.at_hash, digest.subarray(0, digest.length / 2).toString('base64url')))
    throw new Error('id_token at_hash mismatch')
  if (typeof payload.sub !== 'string' || payload.sub.length === 0)
    throw new Error('id_token missing sub')
  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    email_verified: payload.email_verified === true,
    preferred_username:
      typeof payload.preferred_username === 'string' ? payload.preferred_username : undefined,
  }
}
```

(`buildAuthorize`'s `exp` ships as the real `now+600s` computed via `deps.clock` — the block's naive line is superseded at first run; measure-first, amend per byte-sync. The `discover` cache above ran GREEN AS-WRITTEN in the preflight harness (P2: per-process discovery fetch, inflight path exercised) — ship it unchanged.)

- [ ] **Step 5:** `pnpm test src/adapters/shared src/testing && pnpm test && pnpm lint && pnpm typecheck` (jose typecheck under TS6/nodenext is a WATCH item: the drift-style subpath resolution is probe-verified in the preflight; if TS6 rejects a subpath export, `jose` root import is the sanctioned fallback, recorded as an amendment). **Step 6: Commit:**

```bash
git add src/adapters/shared/oidc-rp.ts src/adapters/shared/oidc-rp.test.ts src/adapters/shared/session-codec.ts src/adapters/shared/session-codec.test.ts src/testing/stub-idp.ts src/main/deps.ts src/testing/test-app.ts
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(oidc): RP core (jose) + stub IdP + zero-socket fetch seam"
```

> **Amendment (Task 5, @implementer — Step 2 CONSUMED: only the flow validate ships; three machine-check repairs to the blocks; honest RED 27/27):** (1) **Step 2 shipped ONLY the flow-cookie `validate`** — `isOidcFlow` in `oidc-rp.ts` (the `{state,nonce,verifier,returnTo}` string gate; `exp` string+future is enforced by the shipped `decodeSignedJson`, which owns the outer bound); `session-codec.ts` and its test are BYTE-UNTOUCHED (the Task-3 delegate amendment already discharged the Modify-line — the codec pair of the Step-6 add-list staged nothing). (2) **`buildAuthorize`'s `exp` ships as the real now+600s via `deps.clock`**: `exp: new Date(deps.clock.now().getTime() + 600_000).toISOString()` — the block's self-marked "superseded at first run" line; the test pins it within 5s. (3) **`makeInjectFetch` normalizes `init.headers`** — jose's `customFetch` hands a `Headers` **instance** (jose `types.d` `FetchImplementation`), so the block's plain `as Record<string,string>` cast would hand light-my-request a non-plain object; shipped: `init?.headers instanceof Headers ? Object.fromEntries(init.headers) : (init?.headers … ?? {})` (fix3's URLSearchParams stringify and the zero-network throw ride byte-faithful). (4) **The stub ships `{ app, key: { kid, publicJwk }, signIdToken(overrides?, accessToken?) }`** — `signIdToken` re-signs a negative with the REAL stub key so every negative arm fails the check it pins (iss/aud/at_hash/exp/sub), never the signature gate; `null` deletes a claim. The users record grew the `expOffsetS` knob (fix4's exp-120s arm requires the stub to sign a past `exp`); `nonceAbsent`/`noAtHash`/`email_verified` are exactly as the block lists. (5) **The block's defensive `if (!hash)` arm does NOT ship** — unsatisfiable under the pinned `algorithms:['RS256']` (jwtVerify rejects every other alg upstream of the digest line) and this file is required 100×4; the ALG_HASH follow-the-alg table stays. Lint normalizations: `remoteJwks` gains its explicit return type; the stub's two GET handlers ship non-async (require-await). (6) **`oidcStrings` (Step-3 heading) ships as literal test-pins** — the name occurs once in the plan with no defining block; every RP error string is asserted exact in its own arm. (7) **Helper `makeOidcApp` ships as `{t, idp, log, fetch, authorizeOnly, runFlow}`** (the plan's `{t,idp,log}` plus the flow legs Task 7 reuses); each test re-imports the RP module fresh (`vi.resetModules`) because `cache`/`jwksCache` are module state and every test's stub signs with its OWN key; the cache arms ride `vi.useFakeTimers({toFake: ['Date']})` so inject keeps real timers. (8) **Honest RED: 27 failed / 27 (module-absent)** measured before Step 4 — no first-run-green claims to make. (9) **Gates:** `pnpm test` **548→575 / 78→79 files**; globals **99.43 / 98.18 / 99.75 / 99.65** (every axis ≥ the Task-4 record; documented-uncovered set unchanged); `oidc-rp.ts` 100×4 (funcs 11/11, branches 55/55, lines 71/71 — single-flight, rollback-restore, public-client, DPoP and every negative arm pinned each as its own test); lint 0, typecheck clean. All touched files prettier-clean; the repo-wide `format:check` residuals (git-ignored `.slim/` scratch + the spec md at `630fa16`) are untouched-until-HEAD, not this task's surface (lefthook formats staged files).

## Task 6: Allow-list surface — store, use-cases, three admin ops, policy flag, contract

**Files:**

- Create: `src/infra/sqlite/allowlist-repo.ts` + `.test.ts`, `src/application/usecases/manage-allowlist.ts` + `.test.ts`
- Modify: `src/application/ports.ts` (`AllowlistRow`/`AllowlistRepo`; `Repos` gains `allowlist`), the `SqliteUnitOfWork` tx-repo set (follow the `actors` member — one line + one import), `src/main/deps.ts` (`allowlistRoot` + `useCases` gains `addAllowlist`/`removeAllowlist`/`listAllowlist` — key spellings aligned with the Task 7 `useCases.provisionHumanFromOidc` convention), `src/adapters/rest/routes/admin.ts` (3 ops + the Step-4 policy-enum widening), `src/application/usecases/manage-policy.ts` (`POLICY_ALLOWLIST` line), `openapi/openapi.yaml` (3 ops + `AllowlistEntry` schema) → `pnpm gen:client` (D-zz), `src/adapters/rest/roles-matrix.test.ts` (`ADMIN_OPS` 10 → 13), `src/application/usecases/manage-policy.test.ts` (flag arms)

- [ ] **Step 1: Failing tests.** Usecase pins (the shape below IS the test list): email rule (`'not-an-email'` ⇒ `invalid_request` 'invalid email (D-tt)'; stored LOWERCASED: `'Alice@Example.COM'` → `alice@example.com`); duplicate add ⇒ `{created: false}` and NO second audit (the audit append count or `tail` length proves it); remove-missing ⇒ `not_found` with detail `` `allow-list entry 'ghost@x.example' not found` `` (ghost-404 doctrine verbatim); audits `allowlist_added`/`allowlist_removed` (actor = the admin ctx, after = `{email}`); route matrix: member ⇒ 403 on all three new ops (extend `ADMIN_OPS` verbatim-shape entries — the T4 loop then pins thirteen ops ×the one admin string); `PUT /admin/policy/oidc_provisioning` value `'allowlist'` ⇒ 200, `'on'` ⇒ 400 `invalid_request` (POLICY_ALLOWLIST `['off', 'allowlist']`); NEW arm (review R2/B10): `PUT /admin/policy/review_gate` value `'allowlist'` ⇒ STILL 400 — the transport enum widens, POLICY_ALLOWLIST stays the per-key semantic gate (no silent semantic widening).

- [ ] **Step 2: Run** → RED. **Step 3: Implement.** Ports:

```ts
export interface AllowlistRow {
  email: string
  added_by: string
  created_at: string
}
/** D-tt: admin-managed first-login allow-list rows (emails stored lowercased). */
export interface AllowlistRepo {
  list(): Promise<AllowlistRow[]>
  findByEmail(email: string): Promise<AllowlistRow | null>
  insert(input: { email: string; added_by: string; created_at: string }): Promise<void>
  remove(email: string): Promise<boolean>
}
```

`Repos` gains `allowlist: AllowlistRepo` and the `SqliteUnitOfWork` constructs `new SqliteAllowlistRepo(tx)` beside the actors repo (read the site, follow the pattern — tx-scoped like every use-case repo). Root-connection twin `allowlistRoot` in `AppDeps`/`makeDepsFromDb` (reads/admin path). Repo impl is plain Kysely single statements; `remove` returns `changed > 0`.

`manage-allowlist.ts` (three classes, `manage-actors.ts` file style — uow/clock/ids ctor shape):

```ts
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// AddAllowlist.run({email, addedBy, ...}): validate → lowercase/trim → tx { existing?
//   return {created:false, row} : insert + audit 'allowlist_added' } → {created, row}
// RemoveAllowlist.run({email, ...}): tx { remove? audit 'allowlist_removed'
//   : throw not_found(`allow-list entry '${email}' not found`) }
// ListAllowlist.run(): uow-read repos.allowlist.list()
```

(Audit drafts use `actor_id: input.actor.id, token_id: input.tokenId` exactly like `manage-actors.ts:43-52` — the ctx spread-LAST convention from the route.)

Routes (admin.ts, same 3-arg style + `preHandler: [requireHuman, requireAdmin]`): `GET /admin/allowlist` → `list.run({...actorCtx(request)})` 200 array; `POST /admin/allowlist` body `{email: {type:'string', minLength: 3, maxLength: 254}}` → `reply.code(res.created ? 201 : 200).send(row)`; `DELETE /admin/allowlist/:email` → 204. (Email path param arrives URL-decoded by fastify; the lowercase rule applies before lookup — pinned in the route test via `Alice@Example.COM`.)

- [ ] **Step 4: Contract (D-zz).** yaml: `AllowlistEntry` component `{email, added_by, created_at}`; three ops under tag `admin` with `operationId`s `listAllowlist`/`addAllowlist`/`removeAllowlist`, `201`/`200`/`204` + `default: Problem`; `removeAllowlist` path param `{name: email, in: path, required: true, schema: {type: string}}`. The `PUT /admin/policy/{key}` body schema `enum: ['on','off']` (routes/admin.ts:107) and the SAME enum in `openapi/openapi.yaml` (`setPolicy` requestBody, ~:466) widen to `['on','off','allowlist']` IN THIS TASK (review R2/B10) — the enum gates the wire, POLICY_ALLOWLIST gates the semantics (review_gate + 'allowlist' stays 400, pinned as a test arm above). `pnpm gen:client` + artifact ships in THIS commit.

- [ ] **Step 5: Gates + commit:**

```bash
git add src/infra/sqlite/allowlist-repo.ts src/infra/sqlite/allowlist-repo.test.ts src/application/usecases/manage-allowlist.ts src/application/usecases/manage-allowlist.test.ts src/application/ports.ts src/main/deps.ts src/adapters/rest/routes/admin.ts src/application/usecases/manage-policy.ts src/application/usecases/manage-policy.test.ts src/adapters/rest/roles-matrix.test.ts openapi/openapi.yaml src/client/schema.d.ts
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(admin): oidc first-login allow-list + policy flag"
```

> **Amendment (Task 6, @implementer — ports block byte-verbatim; manage-policy.test.ts is a CREATE; honest RED 4 assertions + 2 module-absent files, three declared first-run-green controls):** (1) **The Step-3 ports block: sync = shipped form** — byte-verbatim in `ports.ts`, placed under a new `// ---- allow-list (D-tt)` section header after the sessions section (header = file convention, not block content); `Repos.allowlist` and the `SqliteUnitOfWork` member follow the actors pattern (one import + one line each). (2) **`manage-policy.test.ts` is CREATED, not Modified** — the Files line and D-tt's "extends" presuppose an existing file; none ever landed (the review_gate on|off arms live in `manage-actors.test.ts` since Plan A and are byte-untouched). The new file owns the D-tt flag arms: seeded `off` (migration seed), `allowlist` accepted, `'on'` rejected for this key, review_gate still rejecting `allowlist` at the use-case. (3) **`manage-allowlist.ts` fleshings of the sketch (three):** the block's `addedBy` pseudo-input is NOT an edge input — the route spreads `{...body, ...actorCtx(request)}` only, and `added_by` = the admin-ctx actor id (audit actor = admin ctx, one spine). Audit fields the plan leaves open SHIP and are PINNED in the use-case test: `entity_type 'allowlist'`, `entity_id` = normalized email, `after: {email}` both actions, reasons `'allow-list entry added'`/`'allow-list entry removed'`. `RemoveAllowlist` normalizes (trim+lowercase) before lookup but does NOT re-validate format — ghost-404 doctrine: any absent email is the same verbatim 404. `ListAllowlist.run(_input: ActorContext)` takes the uniform ctx spread (underscore = deliberately unused, the eslint `argsIgnorePattern` convention). Lint normalization: the 4-name ports import fits one printWidth line (merged). (4) **Route body** ships `required: ['email']` + `additionalProperties: false` per the file-wide sibling convention, and the Step-3 abbreviated one-liner carries D-tt's FULL form — `pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'` (one ruling, the two plan lines; the yaml carries the same pattern; the use-case `EMAIL_RE` is the same language — `'not-an-email'` 400s at the edge, `'a@b'` pinned at the use-case). (5) **`list()` order is not plan-pinned** — ships emails-ascending, pinned in the repo test with a bob-first insert so the pin cannot be insertion order in disguise. (6) **roles-matrix:** the three ops join `ADMIN_OPS` (the plan's 10→13), the count pin and the file's "ten" wordings become thirteen; the member POST body is schema-VALID `{email:'x@y.example'}` because fastify validates before preHandler — the matrix pins the role gate, never an email-rule bypass. (7) **Honest RED:** two files failed module-absent (allowlist-repo 2 + manage-allowlist 6 tests, file-level) plus 4 measured assertion failures — policy seeded-off arm (`not_found`), the thirteen-loop matrix (404 where 403 pinned), the allow-list route suite (404), the `oidc_provisioning` PUT (400 vs 200). THREE arms passed pre-implementation BY DESIGN and no RED is claimed from them: route `review_gate`+`'allowlist'` ⇒ 400 (the schema rejected it pre-widening — that IS the no-widening control), route `oidc_provisioning`+`'on'` ⇒ 400 (unknown-key pre-widening), use-case `review_gate`+`'allowlist'` ⇒ 400. All green after Step 3 with the SAME pinned codes. (8) **Gates:** counts 575/79 → **598/82**; lint 0; typecheck clean; build exit 0; globals **99.45 / 98.2 / 99.76 / 99.66** — every axis above the Task-5 record (99.43/98.18/99.75/99.63) and moved UP; `manage-allowlist.ts` + `allowlist-repo.ts` 100×4 (the thin reporter lists only the UNcovered set — byte-unchanged: mount 51-54, auth :69, rate-limit :35, migrations :324, task-repo 151-164, thread-repo 96/132); the drift test proves served⇄yaml for the three new path×method pairs; `pnpm gen:client` artifact ships in this commit.

## Task 7: Auth routes, the first-login decision tree, login audits, contract

**Files:**

- Create: `src/adapters/rest/routes/auth.ts` + `.test.ts`, `src/adapters/rest/scenarios-auth.test.ts`, `src/application/usecases/provision-human.ts` + `.test.ts`
- Modify: `src/adapters/rest/auth.ts` (`AUTH_PRE_SESSION` GET-only arm — D-vv exact-set (b)), `src/application/ports.ts` (`ActorRepo.findByOidcSubject`), `src/infra/sqlite/actor-repo.ts` (+its test), `src/main/deps.ts` (use-case wiring), `src/adapters/rest/app.ts` (`registerAuthRoutes` — registered BEFORE the hook-reliant route blocks is irrelevant (hooks are app-level); place with the route block, after `registerAdminRoutes`), `openapi/openapi.yaml` (4 `auth` ops incl. `/auth/me`; `security: []` on login/callback/logout) → `pnpm gen:client`

- [ ] **Step 1: Provisioning use-case tests** (`provision-human.ts` — the D-tt handle algorithm, pinned):

```ts
// sanitize: lowercase → strip every char outside [a-z0-9_-] → strip leading chars
// until alnum → 'user' if empty → slice(0, 60). Source preference: username →
// email local-part → subject.
// arms: 'Alice.Smith' → 'alicesmith'; 'ünïcode ✓ user' → 'nicode user'-class
//   stripped result (byte-exact expectation in the test); collision: base taken →
//   base+'-2' → '-3'; exhaustion (seed base + -2..-20 first) ⇒ DomainError
//   invalid_request 'handle space exhausted (D-tt)';
// race guard: findByOidcSubject inside the tx returns an existing row → returned,
//   ZERO create/audit (a double callback cannot double-provision);
// audits: action 'human_provisioned', entity 'actor', reason 'oidc first-login
//   allow-list', after {handle, subject}; row: kind human, role member,
//   oidc_subject bound, description ''.
```

- [ ] **Step 2: Route tests** (`auth.test.ts`; OIDC-enabled app via the T5 stub harness — `makeOidcApp` helper gains an export for scenario reuse):

```ts
// /auth/login (GET exempt arm — D-vv(b)):
// L1 no config (default makeTestApp)                    => 500 problem internal_error 'oidc not
//    configured' — REQUIRES routes/auth.ts to call sendProblem(reply, 500, 'internal_error',
//    'oidc not configured') EXPLICITLY: the generic Error path answers detail 'internal error'
//    (problem.ts:59-65), so the pinned detail demands the explicit call (review note (c))
// L2 configured, no returnTo                            => 302 Location = stub authorize URL w/ exact query set; Set-Cookie __Host-ns_flow (HttpOnly attrs pinned)
// L3 returnTo=/tasks/NS-1 (not /ui/-prefixed)           => returnTo collapses to /ui/ inside the flow cookie
// L4 POST /auth/login                                   => 401 byte-identical missing-bearer (exempt arm is GET-only)
// /auth/callback:
// C1 full green stub round-trip (flow cookie from L2 + authorize inject + code) => 302 /ui/ + BOTH cookies set w/ pinned attrs; sessions row exists (csrf rides); audit login_success on the spine
// C2 state mismatch (forged cookie value)               => 403 forbidden 'oidc callback validation failed (D-pp)' (ONE string for ALL validation rejections — no oracle) + flow cookie cleared (Max-Age=0 in Set-Cookie)
// C3 missing flow cookie / expired flow                 => C2-shape
// C4 iss param ≠ issuer                                 => C2-shape
// C5 IdP returned error=access_denied                   => 302 /ui/login?error=idp + audit login_denied reason 'idp_error'
// C6 exchange throws (stub /api/oidc/token 500 arm)     => 500 internal_error (generic Error path — logged, NO detail leak)
// C7 green path BUT policy off                          => 302 /ui/login?error=pending + audit login_denied reason 'not allow-listed' + NO session row
// C8 policy off + accept: application/json              => 403 forbidden 'oidc identity not recognized (allow-list first)' (the API deny shape, same audit)
// C9 policy allowlist + email listed                    => login completes (member row provisioned — role member pinned via GET /admin/actors... as the NEW session? no — verify via t.deps db read; the member-403-admin fact is T4's matrix)
// C10 policy allowlist + email NOT listed               => C7-shape
// C11 email_verified false on a listed email            => C7-shape (deny, pinned)
// C12 subject already bound (second login)              => same actor session, ZERO new actor row, login_success audited again
// /auth/logout:
// O1 session actor + right CSRF                         => 204 + both cookies cleared + row revoked_at set + audit session_revoked
// O2 session actor, no CSRF                             => 403 D-rr (hook fires before the route — pin proves ordering)
// O3 bearer actor                                       => 400 invalid_request 'logout requires a cookie session (D-qq)'
// O4 no identity                                        => hook 401 (route never runs — pin statusCode+code)
// /auth/me (identity echo for the SPA shell — D-zz; NO new auth concept, reads actorCtx):
// M1 bearer token                                       => 200 ActorRef shape {id,kind,handle,display_name,role}
// M2 session cookie (CSRF-exempt GET)                   => 200, role rides ('member' after C9-provision)
// M3 none                                               => 401 hook 401 byte-identical
```

- [ ] **Step 3: Run RED. Step 4: Implement.** Hook arm (auth.ts, after the PUBLIC_PATHS return, BEFORE the session arm — GET-only exact set, D-vv(b)):

```ts
// D-vv(b) AUTH_PRE_SESSION: the two pre-session OIDC legs run with NO identity;
// GET-only, exact members (normalized path above). Every other method keeps the
// bearer requirement — POST /auth/login answers the byte-identical 401.
if (request.method === 'GET' && (AUTH_PRE_SESSION as readonly string[]).includes(path)) return
```

`export const AUTH_PRE_SESSION = ['/auth/login', '/auth/callback'] as const` sits beside `PUBLIC_PATHS` (the exact-set pin: membership equality test in auth.test.ts, D-ll spirit — a fourth member fails it).

`routes/auth.ts` — `registerAuthRoutes(server, deps)`; the callback decision tree (D-tt) in order: parse query (`code`, `state`, `error`, `iss`) → `error` leg → C5; decode flow cookie (`decodeSignedJson`, `deps.config.sessionKey`) else C2/3/4-class; `iss`-when-present `eq` check; `exchangeCode` → `verifyIdToken` (both throw → generic 500 via error handler); `deps.actorsRoot.findByOidcSubject(claims.sub)` → hit ⇒ mint-session; miss ⇒ `(await deps.actorsRoot.getPolicy('oidc_provisioning')) ?? 'off'` fail-closed: `'off'` ⇒ deny; `'allowlist'` ⇒ `email_verified===true && email` lowercased ∈ `allowlistRoot.findByEmail` ⇒ `useCases.provisionHumanFromOidc.run({...})` ⇒ mint-session; else deny. `mintSession` is ONE local function: `sid/csrf = randomBytes(32).b64url`, `sessionsRoot.create` (`expires_at` = `now + sessionTtlS` via `Clock`), `auditRoot.append` `login_success`, `reply.code(302).header('location', flow.returnTo).header('set-cookie', sessionCookieSet({sid, exp: expiresAt}, ttl, csrf, key))` (+ the cleared flow cookie as a second Set-Cookie array element — fastify `header('set-cookie', [..])`). `deny(...)`: same accept-shape (C7/C8) + `login_denied` audit (reason 'not allow-listed'). Every audit append here is a root-connection single statement (no tx — the delivery-loop doctrine; login is not a domain mutation).

`findByOidcSubject` in actor-repo: `selectAll('actors').where('oidc_subject', '=', sub).executeTakeFirst()` → `ActorRow | null` (full row, no trim — login path is not the token-lookup hot path).

- [ ] **Step 5: Scenario test** (`scenarios-auth.test.ts`, the §11 story shape): bootstrap-admin bearer adds `alice@example.test` to the allow-list → flips `oidc_provisioning` → drives L2/authorize/C9 via raw `inject` calls with a hand-rolled cookie jar (parse `set-cookie`, replay `cookie`) → member session GETs `/tasks` 200 → POSTs a task WITH the CSRF header 201 → POSTs `/admin/actors` 403 → logout 204 → GET `/tasks` 401. (This file is tonight's §14-1 human-loop skeleton; the Playwright twin rides the real UI in Task 11.)

- [ ] **Step 6: Contract (D-zz).** yaml `auth` tag: `GET /auth/login` (`security: []`, params `returnTo` query, `302` + `default: Problem`), `GET /auth/callback` (`security: []`, params `code/state/iss/error`, `302`/`403` arms documented as `default: Problem`), `POST /auth/logout` (`204` + `default: Problem`; `security: []` — deliberate (review note (j)): the op is cookie+CSRF and bearerAuth would misdescribe it; the drift test pins path×method only and cannot see the security field, so the honest posture lives in the op description, not a machine pin), `GET /auth/me` (global bearer security; `200` schema `{id, kind (enum human|agent), handle, display_name, role: {type: ['string','null'], enum: ['admin','member',null]}}` + `default: Problem` — inline schema, no new component). `pnpm gen:client` + artifact in THIS commit; drift `toEqual(documented)` green proves served⇄yaml.

- [ ] **Step 7: Gates + commit:**

```bash
git add src/adapters/rest/routes/auth.ts src/adapters/rest/routes/auth.test.ts src/adapters/rest/scenarios-auth.test.ts src/application/usecases/provision-human.ts src/application/usecases/provision-human.test.ts src/adapters/rest/auth.ts src/adapters/rest/app.ts src/application/ports.ts src/infra/sqlite/actor-repo.ts src/infra/sqlite/actor-repo.test.ts src/main/deps.ts openapi/openapi.yaml src/client/schema.d.ts
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(auth): login/callback/logout + first-login tree + audits"
```

> **Amendment (Task 7, @implementer — Step-4 arm block sync = shipped form; harness extraction is the Files-line growth; honest RED 21 measured, four declared controls):** (1) **Files line grew by exactly two test-side entries** — Step 2's "makeOidcApp helper gains an export for scenario reuse" ships as `src/testing/oidc-harness.ts` CREATED (coverage-excluded; lint/typecheck apply) + `src/adapters/shared/oidc-rp.test.ts` Modified: the helper body moved verbatim (shape stays the Task-5 pinned `{t, idp, log, fetch, authorizeOnly, runFlow}` + `close()`; the `rp` module instance is CALLER-injected so the RP suite keeps its `vi.resetModules` freshness discipline), and `ISSUER` became a parameter. The route tests take the static RP import and isolate the module caches with a **unique issuer per test** — the RP suite re-ran green 27/27 with zero test-body edits. (2) **Step-4 hook-arm block: sync = shipped form** — the arm line and the `AUTH_PRE_SESSION` const line are byte-verbatim (the exact-set membership pin lives in `routes/auth.test.ts`; a fourth member fails it). The documented-uncovered `auth.ts:69` arm (the `?? '/'` nullish, itself a renumber of Plan D's `:47` per the Task-4 note) renumbers to **`:76`** — pure line shift by the const+arm insertion; same arm, nothing new uncovered. (3) **Honest RED measured 21 failed / 29** across the three test files (`routes/auth.test.ts` per-arm failures 20, `actor-repo` `findByOidcSubject` 1; `provision-human.test.ts` failed at file level on module-absent — its 6 tests were never collected, no per-test RED claimed). FOUR arms passed pre-implementation BY DESIGN and there is no RED phase for them to claim, and none is claimed: L4, O2, O4, M3 pin the HOOK-FIRST 401/403 fall-throughs that byte-existed before any route registered (a route-first world would have answered 404 — the exact statuses ARE the ordering proof; O2 additionally pins hook-before-route at the logout CSRF interplay per the plan). Step 5's scenario test is written AFTER Step 4 per the plan's own order and passed first-run — declared, no RED claimed. (4) **Machine strings all pinned by their arms:** `'oidc not configured'` (500 `internal_error` problem, EXPLICIT `sendProblem` per review note (c)) — L1 extends the guard+pin to BOTH pre-session legs (`/auth/callback` unconfigured answers the SAME string; a dormant app must not hand a missing `sessionKey` to HMAC), driving both guard arms; `'oidc callback validation failed (D-pp)'` (403 `forbidden`, ONE string for C2/C3/C4 + missing-code); `'oidc identity not recognized (allow-list first)'` (403 `forbidden` API deny, C8); `'logout requires a cookie session (D-qq)'` (400 `invalid_request`, O3); `'handle space exhausted (D-tt)'` (400 `invalid_request`). Audit ACTIONS `login_success` / `login_denied` / `human_provisioned` / `session_revoked` with reasons `'login success'`, `'idp_error'`, `'not allow-listed'`, `'oidc first-login allow-list'` (D-tt verbatim), `'logout'`; the fields D-tt left open SHIP PINNED: `login_denied` `entity_id` is `'unknown'` on the error leg (unverified query data never enters the spine) and the VERIFIED `claims.sub` on policy denies; `entity_type` `'actor'` for the login events, `'session'` + the session id as `entity_id` for `session_revoked` (audit actor = the logged-out actor id); success `after` carries `{sub}` per D-tt. (5) **The D-tt handle algorithm pinned byte-exact:** `'Alice.Smith'` gives `'alicesmith'`; `'ünïcode ✓ user'` gives `'ncodeuser'` — the plan's "'nicode user'-class" was prose-class, the byte-exact stripped output is `'ncodeuser'` (ü, ï, spaces and ✓ are every char outside `[a-z0-9_-]`; the `'n'` survives); the collision space is `base` + `-2..-20` — exactly 20 candidates, exhaustion past them raises `invalid_request` (the first impl shipped `n <= 21` and the seeded-exhaustion pin caught it RED-then-green); the `'user'` fallback and the 60-cap ride their own drivers; the race guard pins ZERO create/audit via the tail-length count. (6) **Route fleshings the sketch leaves open (six, each pinned):** the `returnTo` rule = `/ui/` prefix REQUIRED (else collapse — L3 pins `/tasks/NS-1` and `https://evil.test/x` collapsing and `/ui/tasks/NS-1` riding through); the flow cookie attrs `; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600` (the shipped codec order; 600s = the `buildAuthorize` `flow.exp` — one constant, two uses), the clear `__Host-ns_flow=` is pinned byte-exact; the flow cookie is cleared on EVERY callback response — including the generic 500 (the exchange/verify `try`/`catch` sets the header and re-throws the SAME generic Error; C6 pins the single-element clear array — fastify preserves reply headers into the error handler, measured); `deny()` accept-shape = `accept` includes `application/json`; the fail-closed gate's nullish and unknown-value arms are driven FOR REAL in C7 (loop preps: seeded `'off'`, the policy row DELETED, raw-set `'on'` — a first draft that skipped the preps showed exactly this arm uncovered in the thin report, closed-by-test); logout's session requirement ships as a ternary `authVia` check plus an `if (!sid) throw` — the "authVia session + sessionId" requirement in one formulation whose arms are ALL reachable (a session actor with a null `sessionId` is hook-unshapeable; the ternary keeps the file 100-branch instead of parking an unreachable one). (7) **ports.ts Modify grows one field beyond the named `findByOidcSubject`:** `ActorRepo.create` input gains the optional `oidc_subject` string — the plan's own provisioning ("`oidc_subject` bound") is inexpressible without it (the repo insert cannot carry a field the port does not name); `ActorRow` itself stays trimmed (`findByOidcSubject` returns the FULL row at runtime, pinned via the direct-db `toEqual` in `actor-repo.test.ts`; NULL-subject rows never match). (8) **Coverage/gates:** `routes/auth.ts` + `provision-human.ts` 100×4 (the single new thin-report line `routes/auth.ts:167` was the C7-preps gap above); globals 598/82 → **636/85** (`provision-human.test.ts` collects 12 = its 6 + 6 re-collected through the `create-task.test.ts` shared-helpers import — the EXACT existing pattern `manage-allowlist.test.ts` shipped in Task 6) — **99.48 / 98.33 / 99.77 / 99.68**, every axis moved UP from the Task-6 record (99.45/98.2/99.76/99.66); lint 0, typecheck clean, build exit 0; drift green proves the four `auth` ops served⇄yaml (the D-zz 4-`auth`+3-`admin` set is now complete: Tasks 6+7 shipped all seven); `pnpm gen:client` artifact ships in this commit; the scenario spine pin quotes the T6 lineage strings `allowlist_added` + `policy_set` ahead of the four new actions in story order.

## Task 8: UI toolchain scaffold — Kit-2 static SPA at `adapters/sveltekit/` (outside `src/`)

**Files:**

- Modify: `pnpm-workspace.yaml`, `package.json` (root: `ui:*`/`test:e2e` scripts + root devDep `prettier-plugin-svelte@4.1.1`), `.prettierrc` (svelte override), `pnpm-lock.yaml`
- Create: `scripts/ui-offline-check.mjs`, `adapters/sveltekit/{package.json,svelte.config.js,vite.config.ts,.gitignore,src/**,static/favicon.svg}` (workspace member — never seen by `tsc -p tsconfig.json` (`include:["src"]`), `eslint src`, or vitest (`src/**/*.test.ts`) — D-vv's toolchain-boundary proof is that the FULL backend gates stay byte-green after this task)

- [ ] **Step 1: Workspace + root scripts.** `pnpm-workspace.yaml` ships:

```yaml
packages:
  - adapters/sveltekit
onlyBuiltDependencies:
  - esbuild
  - better-sqlite3
```

Root `package.json` scripts gain (in script order, before `gen:client`): `"ui:build": "pnpm --filter nightshift-ui build"`, `"ui:offline-check": "node scripts/ui-offline-check.mjs"`, `"test:e2e": "playwright test"` (used from Task 11). Root devDep: `pnpm add -w -D prettier-plugin-svelte@4.1.1` (peers match repo pins: prettier ^3, svelte ^5; MIT). `.prettierrc` overrides gains `{ "files": ["*.svelte"], "options": { "parser": "svelte" } }` so tonight's formatting rules cover the UI honestly.

- [ ] **Step 2: The UI package** `adapters/sveltekit/package.json`:

```json
{
  "name": "nightshift-ui",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "preview": "vite preview"
  },
  "devDependencies": {
    "@sveltejs/adapter-static": "3.0.10",
    "@sveltejs/kit": "2.70.3",
    "@sveltejs/vite-plugin-svelte": "7.3.0",
    "svelte": "5.57.0",
    "vite": "8.2.2"
  }
}
```

`adapters/sveltekit/.gitignore`: `.svelte-kit/` + `build/` + `node_modules/`.

- [ ] **Step 3: Kit config** — `svelte.config.js` (Kit 2: the adapter lives HERE, not in vite config — kit-3 moved it, and kit 3 is only `next`; `fallback:'index.html'` is safe because `prerender:false` everywhere makes the fallback THE page):

```js
import adapter from '@sveltejs/adapter-static'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // D-vv: the SPA shell is served by fastify under /ui; the static fallback answers
    // deep-links. precompress pairs @fastify/static preCompressed:true.
    paths: { base: '/ui' },
    adapter: adapter({
      pages: 'build',
      assets: 'build',
      fallback: 'index.html',
      precompress: true,
      strict: true,
    }),
  },
}

export default config
```

`vite.config.ts`:

```ts
import { sveltekit } from '@sveltejs/kit/vite'
import { defineConfig } from 'vite'

export default defineConfig({ plugins: [sveltekit()] })
```

- [ ] **Step 4: SPA skeleton** — `src/routes/+layout.ts`: `export const ssr = false` + `export const prerender = false` (two lines, the SPA-mode pair). `src/app.html`: the standard Kit shell with the CSP meta (D-vv offline/CSP posture — Svelte injects styles at runtime in SPA mode, hence `style-src 'unsafe-inline'`; images/connections self-only, scripts `'self' 'unsafe-inline'` for the adapter-generated bootstrap script — the script-src leg AMENDED via the Task 11 fix round, R-2):

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'"
    />
    <link rel="icon" href="%sveltekit.assets%/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    %sveltekit.head%
  </head>
  <body data-sveltekit-preload-data="hover">
    <div style="display: contents">%sveltekit.body%</div>
  </body>
</html>
```

(block sync = shipped form AS OF the Task 11 fix round: the `content` line carries the R-2 `script-src 'self' 'unsafe-inline'` addition — Kit's nonce/hash CSP applies only to server-rendered pages, the adapter-static fallback is static (per-request nonces impossible) and the inline bootstrap is adapter-generated; `default-src 'self'` + `connect-src 'self'` remain the load-bearing locks. Task 8's own amendment (1) "byte-identical" claim was TRUE at Task 8's commit and is superseded by this line.)

`src/app.css` — system-font stack, no external fonts (D-vv offline rule): body/nav/chips/columns/tab/card primitives (~60 lines of plain CSS, shipped in full at implement time — the ONE block this plan delegates to the implementer because CSS is presentation-only and Task 9's e2e pins structure, not pixels; every selector Task 9 uses is listed there or added by Task 9's diff). `static/favicon.svg`: one minimal `<svg>` square. `src/routes/+layout.svelte` + the five route pages arrive in Task 9 (Task 8 ships ONLY the layout shell + five one-line placeholder pages so `ui:build` proves the toolchain end-to-end TODAY, isolating toolchain risk from view code).

- [ ] **Step 5: The offline guard** `scripts/ui-offline-check.mjs`:

```js
// D-vv: the built shell must reference NO external host — no CDN, no fonts, no
// phoning home. DevDeps stay in node_modules; this proves the ARTIFACT is honest.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = 'adapters/sveltekit/build'
const urls = new Set()
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (!/\.(br|gz)$/.test(name))
      for (const m of readFileSync(p, 'utf8').matchAll(/https?:\/\/[A-Za-z0-9.-]+/g)) urls.add(m[0])
  }
}
walk(root)
const allowed = new Set([
  'http://localhost',
  'https://localhost',
  'http://127.0.0.1',
  'https://127.0.0.1',
])
const bad = [...urls].filter((u) => !allowed.has(u))
if (bad.length > 0) {
  console.error('external references in UI build:', bad)
  process.exit(1)
}
console.log(`ui build offline-safe; hosts seen: ${[...urls].join(' ') || '(none)'}`)
```

- [ ] **Step 6: Install + prove the boundary:**

```bash
pnpm install        # workspace lockfile churn ships; ~79 MB devDeps measured (lib-1)
pnpm ui:build && pnpm ui:offline-check   # hosts seen: (none) — honest output quoted in the report
pnpm test && pnpm lint && pnpm typecheck && pnpm build   # backend gates byte-unchanged: the UI is INVISIBLE to all four (counts must match Task 7's close exactly)
pnpm format:check   # prettier-plugin-svelte covers .svelte under repo rules
```

- [ ] **Step 7: Commit:**

```bash
git add pnpm-workspace.yaml package.json pnpm-lock.yaml .prettierrc scripts/ui-offline-check.mjs adapters/sveltekit
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(ui): sveltekit static scaffold at /ui outside src"
```

> **Amendment (Task 8, @implementer — four blocks byte-identical; the offline-check allow-list moved on MEASURED output; two formatting-infra lines beyond the file list; honest REDs measured):** (1) **sync = shipped form (diff-verified programmatically)** — the Step-2 `package.json`, Step-3 `svelte.config.js` + `vite.config.ts` and Step-4 `app.html` blocks are byte-identical to the shipped files; the Step-1 workspace shape and the `.gitignore` (`.svelte-kit/` + `build/` + `node_modules/`) ship as written. (2) **Step-5 offline-check: shipped with a measured allow-list addition — the block above is superseded at the `allowed` set; sync = shipped form.** The as-written check went RED first against the real artifact: `external references in UI build: [ 'http://www.w3.org', 'https://svelte.dev' ]` exit 1 — the plan's "hosts seen: (none)" expectation was measurably wrong. Both hosts are provably inert strings, neither ever fetched: `http://www.w3.org` = XML namespace identifiers (favicon `xmlns` + svelte's XHTML `createElementNS` constant — namespaces are identifiers per spec, not network references; a VALID standalone SVG requires the xmlns); `https://svelte.dev` = svelte@5.57.0's PROD runtime error/warning message text — Error(\`https://svelte.dev/e/<code>\`) and console.warn(\`https://svelte.dev/e/hydration_mismatch\`) as human-readable throwables, never fetched — and the CSP meta in app.html carries connect-src 'self' as the actual no-phoning-home enforcement. Stripping them would mean patching svelte internals or shipping an invalid favicon — rejected. The shipped check adds EXACTLY those two hosts with the why-comment; every other host still REDs (the detector just proved itself on the artifact). Honest REDs claimed, both measured: pre-build the guard crashed with exit 1 — errno -2, code ENOENT, syscall scandir, path adapters/sveltekit/build (the "deliberately absent build dir" arm fails loudly), and the first artifact run RED'd as quoted — no planted fake REDs. Final green output, one line, exit 0: ui build offline-safe; hosts seen: http://www.w3.org https://svelte.dev. (3) **File list grew by `.prettierignore` (two appended lines)** — prettier does NOT consult `.gitignore` (baseline at HEAD proves it: `format:check` flags the gitignored `.slim/` scratch), so the generated `adapters/sveltekit/build` + `adapters/sveltekit/.svelte-kit` trees entered `format:check` with 99 artifact warns; the two anchored entries restore the check to EXACTLY the two pre-existing residuals (`.slim/deepwork/plan-e-oidc-ui.md` + the design spec at `630fa16`), both byte-untouched. (4) **`.prettierrc` grows one line beyond the plan's overrides entry: `"plugins": ["prettier-plugin-svelte"]`** — measured with the pinned prettier@3.8.3 + pnpm workspace layout, plugin autoload did NOT engage (`Couldn't resolve parser "svelte"`, while the plugin imported green and `--plugin prettier-plugin-svelte` formatted the `.svelte` files exit 0); the explicit declaration makes tonight's rules cover `*.svelte` as planned. (5) **The Step-4 delegated CSS block ships** (105 lines after prettier normalization; "~60" read as budget, not contract): system-font stack, zero external URLs; primitives = body/nav/main + `.chips/.chip/.columns/.column/.card/.swimlane/.rollup/.tabs/.tab/.pill/.file-task` (class names grepped from Task 9's view blocks; Task 9's diff adds anything else per the delegation clause). Layout shell = the `+layout.ts` ssr/prerender pair + `+layout.svelte` (nav with `$app/paths`-`base` links: board/inbox/admin/login + `children()` slot — the Task-9-owned sign-out affordance joins this nav there) + FIVE one-line placeholder pages (`/`, `tasks/[id]`, `inbox`, `admin`, `login`) + a minimal `static/favicon.svg` square. (6) **Gates — build gates and backend gates ALL first-run green, declared; there is no RED phase to claim for them and none is claimed:** `pnpm ui:build` exit 0 (`✓ built in 1.30s` / `Wrote site to "build"` `✔ done`); D-vv's toolchain-boundary proof held byte-exact: `pnpm test` **636 passed / 85 files** (Task 7's close, zero drift — the UI is invisible to tsc `include:["src"]`, `eslint src`, vitest `src/**`), `pnpm lint` 0 issues, `pnpm typecheck` clean, `pnpm build` exit 0, `format:check` = only the (3) residuals. **Lockfile audit:** root importer delta is EXACTLY the `prettier-plugin-svelte@4.1.1` addition; 28 packages added / 0 removed / 0 changed, snapshots 0 removed / 0 changed — ZERO backend-dependency movement (vite@8.2.2 was already the vitest-transitive version — the plan's dedupe note verified). Install warned only the pre-existing `openapi-typescript ✕ unmet peer typescript@^5.x` (predates Task 1); `prettier-plugin-svelte`'s `svelte@5.57.0` peer resolves from the workspace (its .pnpm peer suffix carries the link) — no new warnings. Install reached the pnpm registry ONLY; the build fetched nothing (offline-safe by artifact and by the Step-5 proof).

## Task 9: The five §8 views — structure is the requirement

**Files (all under `adapters/sveltekit/`):**

- Create: `src/lib/types.ts`, `src/lib/api.ts`, `src/lib/events.ts`, `src/lib/poll.svelte.svelte` NO — `src/lib/poll.svelte.ts`
- Modify: `src/routes/+layout.svelte` (create, nav), `src/routes/+page.svelte` (board), `src/routes/tasks/[id]/+page.svelte`, `src/routes/inbox/+page.svelte`, `src/routes/admin/+page.svelte`, `src/routes/login/+page.svelte`
- Modify (Step 0 read-side, review R3/B12): `src/application/ports.ts` (`TaskWithCounts` +`labels`), `src/infra/sqlite/task-repo.ts` (batched `labelsFor` — no N+1), `src/adapters/rest/dto.ts` (`TaskDto`/`toTaskDto`), `openapi/openapi.yaml` (`Task` schema), `src/client/schema.d.ts` (regen), the §11.2 body-pin scenario-test files the suite names

**Contract-transcription duty (binding for this task):** every endpoint/field the UI calls is read from the SHIPPED route files (`routes/tasks.ts`, `threads.ts`, `inbox.ts`, `attachments.ts`, `links.ts`, `dependencies.ts`, `labels.ts`, `audit.ts`, `events.ts`, `admin.ts`, `webhooks.ts`, `auth.ts`) and from `dto.ts` — transcription, not invention. Where a response field is absent, the view shows less; the view NEVER assumes a field no route emits. Post-R3 the board DTO DOES carry `labels` — Step 0 makes that true FIRST; every other field stays pure transcription.

- [ ] **Step 0: The labels DTO expansion (review R3/B12 — the board's label chip needs labels ON the DTO).**
      Read-side only, shipped BEFORE the views: `ports.ts` `TaskWithCounts` gains `labels: string[]`; `task-repo.ts` resolves them in ONE batched query per response (`labelsFor(taskIds): Map<taskId, string[]>` via `task_labels` JOIN `labels` — wired into `listAllWithCounts` AND `findWithCounts`; NO N+1 per task); `dto.ts` `TaskDto`/`toTaskDto` gains `labels: string[]` (empty array for unlabeled tasks); `openapi/openapi.yaml` `Task` schema gains `labels: { type: array, items: { type: string } }`; `pnpm gen:client` + the regenerated `src/client/schema.d.ts` ship in THIS commit (D-zz duty). The §11.2 body-pins in the REST scenario tests gain the `labels` key — run `pnpm test` after the change and fix EXACTLY the pins that break (the MCP parity harness compares live⇄live and rides automatically; if any parity ROW hardcodes a body, fix the row). The board label chip then filters `t.labels.includes(fLabel)` client-side — no per-card GET.

- [ ] **Step 1: The client seam** `src/lib/api.ts` (D-rr companion mirroring lives HERE — every mutation carries the header when the companion cookie exists):

```ts
// api.ts — the single UI⇄API seam: cookies ride same-origin; session-bound CSRF
// companion mirrors into the header (D-rr); 401 bounces to the login view.
import { browser } from '$app/environment'

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly detail: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(`${code}: ${detail}`)
  }
}

const cookieValue = (name: string): string | null => {
  if (!browser) return null
  const hit = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`))
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null
}

export const csrfToken = (): string | null => cookieValue('__Host-ns_csrf')

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  const method = (init.method ?? 'GET').toUpperCase()
  if (!['GET', 'HEAD'].includes(method)) {
    const token = csrfToken()
    if (token) headers.set('x-csrf-token', token) // D-rr mirror
  }
  headers.set('accept', 'application/json')
  const res = await fetch(path, { credentials: 'same-origin', ...init, headers })
  if (res.status === 401 && browser) {
    location.assign(`/ui/login?returnTo=${encodeURIComponent(location.pathname)}`)
    throw new ApiError('unauthenticated', 401, 'session expired — signing in again')
  }
  const body = (
    res.status === 204 ? null : ((await res.json()) as T & { code?: string; detail?: string })
  ) as T
  if (!res.ok) {
    const b = (body ?? {}) as { code?: string; detail?: string }
    throw new ApiError(b.code ?? 'internal_error', res.status, b.detail ?? res.statusText)
  }
  return body as T
}

// JSON mutation helper: callers pass plain objects; identity stays server-side
// (the hook knows who you are — bodies never carry actor fields).
export const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
```

`src/lib/types.ts` — one interface per DTO READ from `dto.ts` + the route bodies transcribed (Task-9 implementer fills by transcription: `TaskDto`, `ThreadDto`, `MessageDto`, `InboxItemDto`, `AuditEntryDto`, `FeedEvent`, `ActorMe`, `ActorDto`, `TokenDto`, `WebhookDto`, `LabelDto`, `AllowlistDto`, `LinkDto`, `AttachmentDto`, `ContextBundle`; each field's presence is justified by a route file line, cited in a comment).

- [ ] **Step 2: Polling loop** `src/lib/events.ts` (§8: `/events?cursor=` polling; SSE stays §12) — cursor monotonic, backoff pinned-named:

```ts
// events.ts — live board via the cursor feed (spec §8: polling; SSE §12 later).
// SHAPE (review R4/B9 — verified routes/events.ts:54): GET /events answers a BARE
// ARRAY (rows.map(toEvent); cursor = audit_log.id — toEvent is the exported single
// source; transcribe its FULL field list into FeedEvent, not just cursor). The
// former `import { api }` here was unused (the loop takes `load` as a parameter) —
// dropped: no dead imports.

export const POLL_BASE_MS = 2000
export const POLL_MAX_MS = 10000

// transcribed from routes/events.ts toEvent — cursor shown, rest rides the mapper
interface FeedEvent {
  cursor: number
}

/** Pure next-delay decision — Task 9's e2e-adjacent honesty hook: cursor NEVER
 * decreases; failures back off ×2 up to POLL_MAX_MS; success returns to base. */
export interface PollState {
  cursor: number
  delayMs: number
}

export const initialPollState = (): PollState => ({ cursor: 0, delayMs: POLL_BASE_MS })

export const afterSuccess = (s: PollState, page: FeedEvent[]): PollState => ({
  cursor: page.reduce((m, e) => Math.max(m, e.cursor), s.cursor), // monotonic, never re-reads back
  delayMs: POLL_BASE_MS,
})

export const afterFailure = (s: PollState): PollState => ({
  cursor: s.cursor,
  delayMs: Math.min(s.delayMs * 2, POLL_MAX_MS),
})

/** Drives the loop; onBatch runs only when fresh events arrived. `alive` gates
 * across SPA navigations. */
export async function pollFeed(
  load: (cursor: number) => Promise<FeedEvent[]>,
  onBatch: (events: FeedEvent[]) => void,
  alive: () => boolean,
  schedule: (fn: () => void, ms: number) => unknown = setTimeout
): Promise<void> {
  let state = initialPollState()
  while (alive()) {
    try {
      const page = await load(state.cursor)
      const next = afterSuccess(state, page)
      if (page.length > 0) onBatch(page)
      state = next
    } catch {
      state = afterFailure(state) // feed failure NEVER kills the loop; the tick just refetches
    }
    await new Promise<void>((r) => schedule(() => r(), state.delayMs))
  }
}
```

- [ ] **Step 3: Board view** `src/routes/+page.svelte` (§8-1: columns=status, rows=swimlanes by root task w/ rollup `done/total` leaves, filter chips assignee/label/blocked/ready-only, minimal file-task form per §14-2). Computes the tree client-side from `GET /tasks` (no server assumption beyond the DTO), polls via `pollFeed` refetching on any batch, `onMount`-start + destroy-on-teardown:

```svelte
<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { api, json } from '$lib/api'
  import { pollFeed, type FeedEvent } from '$lib/events'
  import type { TaskDto } from '$lib/types'

  const COLUMNS = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled'] as const
  let tasks = $state<TaskDto[]>([])
  let byId = $derived(new Map(tasks.map((t) => [t.id, t])))
  const roots = $derived(tasks.filter((t) => !t.parent_id))
  // swimlane rollup: leaves of the root's subtree (root-with-children is never a
  // leaf — spec D6): done-leaves / total-leaves
  const leavesOf = (rootId: string): TaskDto[] => {
    const out: TaskDto[] = []
    const kids = (id: string) => tasks.filter((t) => t.parent_id === id)
    const walk = (id: string): void => {
      const ks = kids(id)
      if (ks.length === 0) out.push(byId.get(id)!)
      else ks.forEach((k) => walk(k.id))
    }
    if (kids(rootId).length === 0) out.push(byId.get(rootId)!)
    else kids(rootId).forEach((k) => walk(k.id))
    return out
  }
  // filters (chips; ready-only reads the SERVER's ready() facts OFF THE DTO —
  // unmet_blockers/claim_token_id ride it (review note (g)); full dependency
  // resolution stays the SERVER's claim gate's job, stated honestly in the UI note)
  let fAssignee = $state('')
  let fLabel = $state('')
  let fBlocked = $state(false)
  let fReadyOnly = $state(false)
  const visible = (t: TaskDto): boolean =>
    (!fAssignee || t.assignee_id === fAssignee) &&
    (!fLabel || t.labels.includes(fLabel)) &&
    (!fBlocked || t.blocked_flag === true) &&
    (!fReadyOnly ||
      (t.status === 'todo' &&
        !t.assignee_id &&
        !t.blocked_flag &&
        t.unmet_blockers === 0 &&
        t.claim_token_id === null &&
        !tasks.some((c) => c.parent_id === t.id)))
  const cell = (rootId: string, status: string): TaskDto[] =>
    leavesOf(rootId).filter((t) => t.status === status && visible(t))
  const rollup = (rootId: string): string => {
    const ls = leavesOf(rootId)
    return `${ls.filter((t) => t.status === 'done').length}/${ls.length}`
  }
  // new-task form (humans file work — §14-2)
  let newTitle = $state('')
  async function fileTask(): Promise<void> {
    if (!newTitle.trim()) return
    await api('/tasks', json('POST', { title: newTitle.trim(), status: 'todo' }))
    newTitle = ''
    await refresh()
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  async function refresh(): Promise<void> {
    tasks = await api<TaskDto[]>('/tasks')
  }
  onMount(() => {
    void (async () => {
      await refresh()
      await pollFeed(
        (cursor) => api<FeedEvent[]>(`/events?cursor=${cursor}`),
        () => void refresh(),
        () => !stopped,
        (fn, ms) => (timer = setTimeout(fn, ms))
      )
    })()
  })
  onDestroy(() => {
    stopped = true
    if (timer) clearTimeout(timer)
  })
</script>

<form class="file-task" onsubmit={(e) => (e.preventDefault(), fileTask())}>
  <input placeholder="File a task…" bind:value={newTitle} />
  <button type="submit">File</button>
</form>
<div class="chips">
  <select bind:value={fAssignee}><option value="">assignee: all</option>…</select>
  <select bind:value={fLabel}><option value="">label: all</option>…</select>
  <label><input type="checkbox" bind:checked={fBlocked} /> blocked</label>
  <label><input type="checkbox" bind:checked={fReadyOnly} /> ready-only</label>
</div>
{#each roots as root (root.id)}
  <section class="swimlane">
    <h2>
      <a href="/ui/tasks/{root.id}">{root.title}</a>
      <span class="rollup" title="done / total leaves">{rollup(root.id)}</span>
    </h2>
    <div class="columns">
      {#each COLUMNS as col (col)}
        <div class="column">
          <h3>{col}</h3>
          {#each cell(root.id, col) as t (t.id)}
            <a class="card" href="/ui/tasks/{t.id}">{t.title}{t.blocked_flag ? ' ⚑' : ''}</a>
          {/each}
        </div>
      {/each}
    </div>
  </section>
{/each}
```

(the `…` inside the two `<select>` option lists is the transcription duty: options are built from the loaded data — `Array.from(new Set(tasks.flatMap(t => t.labels)))` and an assignee select from `tasks` — the implementer expands from the DTO; structural shapes are pinned above). (The ready-only predicate above ALREADY ships in its preflight/review-amended form — plain-leaf test plus the DTO's `unmet_blockers === 0` + `claim_token_id === null` (review note (g)); no ship-time self-correction is reserved for it. The e2e board pin — a todo-leaf renders under `todo` — holds under the shipped predicate.)

- [ ] **Step 4: Task detail** `src/routes/tasks/[id]/+page.svelte` — header (title, status pills PATCH `/tasks/{id}/status` w/ reason input when claimed — reason rule transcribed from the route; assignee/labels via PATCH `/tasks/{id}`; blocked toggle) + the SIX §8-2 tabs as `<details>`-style tab strip: **conversation** (threads + messages, note/question kinds, question state badges + answer action), **children** (NESTED render — reuse the board's walk/group pattern to print the subtree as a TREE per §8-2; + links; split form omitted — splits are an agent/API surface, stated), **dependencies** (blocker/blocked lists + add/remove), **attachments+links** (upload via `POST /tasks/{id}/attachments` octet-stream `?filename=` transcribed from the route; links add/remove), **activity** (`GET /audit` query transcribed from `routes/audit.ts`, task-scoped), **context** (`GET /tasks/{id}/context` rendered verbatim). Comment box = note-thread creation (POST `/tasks/{id}/threads` kind note / messages). Each call rides `api()`. Structure pinned, layout plain.

- [ ] **Step 5: Inbox + Admin + Login views.** `inbox/+page.svelte`: `GET /inbox` list, unread marker, `markInboxRead`-route transcription button, jump-to-task links (§8-3). `admin/+page.svelte` (§8-4, admin-role-gated: `/auth/me` role !== 'admin' ⇒ "admins only" panel, no data fetch — the SERVER is the gate; this is the UI courtesy): actor list + create-agent form + token create/revoke (raw token shown ONCE with an acknowledge button), label create/attach, policy flag toggles (`GET/PUT /admin/policy/:key` — review_gate + oidc_provisioning), webhook list/register/rotate/delete (secret shown once), allow-list CRUD (Task 6 ops), audit search (GET /audit query). `login/+page.svelte` (§8-5: no registration — OIDC button ONLY): reads `?error=` (`pending` → "not allow-listed yet — ask an admin", `idp` → generic failure) + `?returnTo=`, button → `/auth/login?returnTo=<path>`; the sign-out affordance lives in the layout nav (Task 8 shell).

- [ ] **Step 6: Prove + commit:**

```bash
pnpm ui:build && pnpm ui:offline-check          # hosts: (none); build green
pnpm test && pnpm lint && pnpm typecheck && pnpm build   # backend gates GREEN — Step 0 is a read-side contract addition (labels): the §11.2 body-pins ride, record the counts; lint/typecheck/build still never see adapters/sveltekit
git add adapters/sveltekit src/application/ports.ts src/infra/sqlite/task-repo.ts src/adapters/rest/dto.ts openapi/openapi.yaml src/client/schema.d.ts
# + every §11.2 body-pin scenario-test file the suite names (mechanical labels additions only)
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(ui): five spec-8 views: board, detail, inbox, admin, login"
```

> **Amendment (Task 9, @implementer — Step 0 honest RED measured, pin sweep honestly EMPTY; eight shipped deltas logged; UI strings are UI-only):**
>
> 1. **Step 0 shipped; honest RED measured 3 failures** (listReady labels ride, findWithCounts sorted-names pin, the batched-query test — `labels: undefined` where arrays were pinned) before the ports/repo/dto/yaml landed. `labelsFor` is wired into **THREE** paths, not the plan's two: `findWithCounts` + `listAllWithCounts` **plus `listReady`** — `TaskWithCounts` is `listReady`'s return type and `GET /tasks/next`/MCP `next_tasks` serialize `toTaskDto` against the yaml `Task` schema that now promises `labels`; skipping the third path would make the field a lie or a type error. The batch discipline is machine-pinned, not prose: a counting `KyselyPlugin` wraps the repo's db in the test — list/single-get = base + **exactly ONE** labels query (N+1 would be 5 for 3 tasks); **empty-set arms issue ZERO labels queries** (the `in ()` guard: empty `listAllWithCounts`, empty filtered `listReady`), and a ghost `findWithCounts` returns BEFORE any labels query (delta 1). Names sorted asc, unlabeled `[]`.
> 2. **§11.2 body-pin sweep: ZERO pins needed the `labels` key — honestly zero.** `pnpm test` after the change went green without touching one existing assertion: every task-body expectation in the REST/MCP scenario files is a property accessor, a `toMatchObject`, or the live⇄live parity harness. No pin was edited, so none is claimed. The added NEW wire pin is `tasks.test.ts` "task wire bodies carry label names" (201/GET list/GET single carry sorted names; unlabeled `[]`, never absent) — written after the repo-level REDs, so it passed first-run: there is no RED phase to claim for it and none is claimed.
> 3. **The yaml grows beyond the plan's "Task schema gains labels" line:** the `TaskWithCounts` component — the un-DTO'd repo shape SERVED RAW by split's `parent` (ora-20) — gains `labels` too (BL1 §5 nothing-hidden: the row now carries it, the contract must not hide it). `schema.d.ts` regen (+labels on both) ships in this commit (D-zz duty).
> 4. **Coverage/drift:** `labelsFor`'s guard, group-build, `?? []` and miss-before-batch arms are all pinned; the documented-uncovered `task-repo.ts:151-164` arm renumbered to **178-191** (pure +27 line shift by the class-top insert — same arm). Globals 636/85 → **639/85**: **99.48 / 98.35 / 99.77 / 99.68** — every axis ≥ the Task-7 record (99.48/98.33/99.77/99.68), branches moved UP.
> 5. **Step 1 `api.ts`: sync = shipped form** (diff-verified byte-identical). `types.ts` filled by transcription — every interface carries the route/ports line that justifies it; `ContextBundleDto.task` is the RAW `TaskRecordDto` (get-context.ts:53 — the bundle's `task` carries no counts/labels inside; they are siblings).
> 6. **Step 2 `events.ts`: shipped with the plan block's self-contradiction resolved toward its own instruction.** The block's local `interface FeedEvent { cursor: number }` contradicts the block's comment ("transcribe its FULL field list"); the complete 8-field `FeedEvent` (routes/events.ts `toEvent`) ships in `types.ts` and events.ts ADDS `import type { FeedEvent } from './types'` — the only import change; reducers/loop byte-faithful. Consequence: the board's block import `import { pollFeed, type FeedEvent } from '$lib/events'` became `pollFeed` from events + `FeedEvent` from types. The Files line's `src/lib/poll.svelte.ts` is CONSUMED by events.ts (the "NO —" line self-corrects; loop + reducers live in events.ts, no separate file).
> 7. **Step 3 board: sync = shipped form** except (a) the two `…` selects expanded from the DTO only (assignees = distinct non-null `assignee_id`; labels = `flatMap(t => t.labels)`), and (b) the card markup rides the labels chip (`#name` per label) — the R3/B12 chip the whole Step 0 exists for. Steps 4–5 views ship per the structure blocks; THREE transcription realities are stated IN the views, not papered over: the **dependencies tab reads the context bundle's `blockers` (UNMET only)** — the contract has NO read route for met blockers or the "tasks this one blocks" edge, so the view shows less and says so; **assignee is a typed actor-id input** (members have no actor-read route — `GET /admin/actors` is admin-role-gated); token revoke operates on freshly issued tokens (no token-list route exists). The nested children tree (review note (g)/8) needed ONE file beyond the plan's Files line: `src/lib/TaskTree.svelte` (`svelte:self` recursion — a nested DOM tree cannot be printed from one page file without duplicating the walk). Layout: the sign-out affordance (Task 8's note) ships in the nav; its `whoami` read is a PLAIN fetch, NOT `api()` — `api()`'s 401→login bounce would ping-pong on the login page itself (a nav that cannot be seen while logged out is the bug this records); per-view `api()` keeps the bounce posture everywhere else. Login passes `?returnTo=` through untouched (the L3 collapse is server-side, routes/auth.ts:55).
> 8. **Gates:** `pnpm ui:build` exit 0 (`✓ built` / `Wrote site to "build"` / `✔ done`); `pnpm ui:offline-check` exit 0 — `ui build offline-safe; hosts seen: http://www.w3.org https://svelte.dev` (the two Task-8 inert hosts ONLY — the views introduce NO new host; every URL literal in the views is a root-path, never a host). Backend byte-unchanged: 639/85, lint 0, typecheck clean, build exit 0, drift/parity green. `format:check` = exactly the two baseline residuals. Extra self-check (NOT a plan gate): package-scoped `tsc --noEmit -p .svelte-kit/tsconfig.json` exit 0. **All view copy is UI-only text** ("assignee: all", "ready-only", "not allow-listed yet — ask an admin", "admins only", "shown ONCE", "sign out", …) — zero new machine-facing strings: no audit action/reason, problem code or reason string was added or reworded by this task.

## Task 10: Static mount + the two exact-set pins (hook UI arm, drift sentinel + hasRoute)

**Files:**

- Create: `src/adapters/rest/ui.ts` + `.test.ts`
- Modify: `src/adapters/rest/app.ts` (`mountUi(server, deps)` AFTER `mountMcp`, its own ruling-comment), `src/adapters/rest/auth.ts` (`isUiPath` arm — D-vv exact-set #1), `src/adapters/rest/openapi-contract.test.ts` (wildcard-sentinel + `hasRoute` pins — D-vv exact-set #2; the Step-1 fence carries the SAME-EDIT routeKeys grammar change)

- [ ] **Step 1: Failing `ui.test.ts`:** build-tree present (Task 8's `ui:build` output exists in the working tree — the test builds its OWN tiny tree ONLY if absent is FORBIDDEN; honest: the test `beforeAll` skips with a loud declared skip if `adapters/sveltekit/build/index.html` is absent — recorded, never fake-green):

```ts
// with a built tree (the pinned arm set):
// U1 GET /ui/                       => 200 text/html; cache-control no-cache; body = the shell (contains a known marker from build/index.html)
// U2 GET /ui/login, GET /ui/tasks/NS-1 (SPA deep-links, files absent) => 200 html shell (scope notFound fallback)
// U3 GET /ui/_app/entries/<first hashed asset via fs.readdir> => 200 + cache-control immutable + max-age=2592000
// U4 HEAD /ui/                      => 200, no body — HEAD rides GET exemption
// U5 dot-segment reality (re-pinned, preflight P7/fix13): inject (and EVERY browser UA)
//    normalizes dot-segments BEFORE the hook sees the URL — GET /ui/../openapi.yaml
//    arrives as /openapi.yaml (PUBLIC ⇒ 200 spec, never the UI, never the API-under-test).
//    The honest pin: unit-test the hook's normalizer regex directly (slash-collapse/trailing
//    arms unchanged — fail-closed membership only) + rely on U7; no dot-segment inject can
//    exercise a UI-path fail-close because the path never reaches the hook un-normalized.
// U6 POST /ui/                      => 401 problem unauthenticated — exemption is GET/HEAD ONLY
// U7 GET /uix                       => 401 (single-member set: '/ui/' prefix only; /uix is NOT under it)
// U8 the D-vv skip-arm: mountUi against a missing build dir (unit: call it on a fresh Fastify w/ cwd pointing elsewhere) => no route registered + logged notice + /ui/* 404s problem+json (root notFound intact)
```

`openapi-contract.test.ts` gains beside the `MCP_ROUTES` block (same D-ll spirit, second exact set):

```ts
// D-vv — the yaml cannot describe a built asset tree. (AMENDED pre-dispatch,
// preflight P7/fix12, machine-verified on find-my-way 9.9.0/fastify 5.12.3:) the
// static mount prints as a BARE wildcard leaf `* (GET, HEAD)` — NO path segment in
// ANY printRoutes mode — so routeKeys learns the leaf as a SENTINEL and the /ui/*
// SPELLING is pinned exactly via hasRoute. A second wildcard registration duplicates
// the sentinel (fails the pin); the hasRoute pair pins the spelling and the absence
// of any POST sibling.
// SAME-EDIT grammar in routeKeys: the leaf alternation becomes (\/\S*|\*) and after
// `stack.length = match[1].length / 4`:
//   if (match[2] === '*') {
//     for (const method of match[3].split(', ')) {
//       if (method === 'HEAD') continue
//       keys.add(`${method} *`)
//     }
//     continue
//   }
// The 'fails loudly on tree shapes outside the grammar' test RE-PINS IN THE SAME
// EDIT: the old wildcard-as-junk fixture is now GRAMMAR (returns
// GET *,GET /tasks,POST /tasks); the loud-fail class keeps a genuinely out-of-shape
// line (a junk leaf must still throw). The MCP assertions stay byte-identical;
// only the single-exemption remainder line is replaced (by design).
// LANDED: sync = shipped form — the excerpt mirrors the shipped 4-space test-body
// indent; prettier wraps the final expect as `expect(⏎ filter ⏎ ).toEqual(documented)`.
const STATIC_KEYS = ['GET *'] // sentinel — the /ui/* spelling is pinned by hasRoute
const staticPresent = served.filter((key) => key.endsWith(' *')).sort()
expect(staticPresent).toEqual(uiBuildPresent() ? STATIC_KEYS : [])
expect(hasUiGet).toBe(uiBuildPresent())
expect(hasUiPost).toBe(false)
expect(documented.some((key) => key.includes('/ui'))).toBe(false)
expect(served.filter((key) => !mcpPresent.includes(key) && !staticPresent.includes(key))).toEqual(
  documented
)
```

(`uiBuildPresent()` — the same helper `ui.ts` exports, so test and mount see the SAME tree-truth; when the build dir is absent the drift test proves the ZERO-member set honestly. Capture `const hasUiGet = t.app.hasRoute({ method: 'GET', url: '/ui/*' })` + `const hasUiPost = t.app.hasRoute({ method: 'POST', url: '/ui/*' })` right after `ready()`/`routeKeys`, BEFORE `t.close()`. The preflight verified both exemptions hold simultaneously on live served keys, with-build and without.)

- [ ] **Step 3: Implement `ui.ts`:** (block BELOW: sync = shipped form — the two
      additions over the pre-dispatch text are the measured eslint-disable and the
      fallback-comment wrap, both quoted in the amendment at the end of this section)

```ts
// ui.ts — D-vv: the SvelteKit static SPA mount. Its own encapsulated scope;
// wildcard:true registers exactly `GET /ui/*` INSIDE the scope, so the scope's
// setNotFoundHandler answers SPA deep-links while the ROOT notFound stays
// problem+json byte-untouched. Same cwd-relative asset story as /openapi.yaml
// (Docker asset-shipping stays F — stated).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'

const BUILD_DIR = join(process.cwd(), 'adapters', 'sveltekit', 'build')
export const uiBuildPresent = (): boolean => existsSync(join(BUILD_DIR, 'index.html'))

// the 2-arg signature is buildApp symmetry; deps exists ONLY for the skip-path
// story (preflight P7/fix11 deleted the dead deliveryLoop line — measured here:
// eslint's after-used rule flags the unused tail param, the plan sanctions this
// one-line disable on the signature)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const mountUi = (app: FastifyInstance, deps: AppDeps): void => {
  if (!uiBuildPresent()) {
    // dev/test without a build: the mount skips, /ui/* 404s as problem+json, boot
    // NEVER crashes — the Playwright smoke builds first (D-xx).
    app.log.warn(
      'UI build absent (adapters/sveltekit/build) — /ui mount skipped; run pnpm ui:build'
    )
    return
  }
  // (fix11, preflight P7) the scope registers WITH { prefix: '/ui' } — the prefix-less
  // shape collided with the repo root's own setNotFoundHandler at boot: 'Not found handler
  // already set for Fastify instance with prefix: /'. Static now mounts at '/' INSIDE the
  // /ui scope; every runtime arm (shell/deep-link/asset cache/br/POST/404s) re-verified green.
  void app.register(
    async (scope) => {
      await scope.register(fastifyStatic, {
        root: BUILD_DIR,
        prefix: '/',
        wildcard: true,
        index: ['index.html'],
        // hashed assets (vite emits content-hashed names) are immutable forever;
        // the shell (and the fallback) is always no-cache — setHeaders below.
        immutable: true,
        maxAge: '30d',
        preCompressed: true, // pairs adapter-static precompress:true
        setHeaders(reply, path) {
          if (path.endsWith('.html')) reply.header('cache-control', 'no-cache')
        },
      })
      scope.setNotFoundHandler((request, reply) => {
        // SPA fallback: scope-local ONLY — deep-links answer the shell; the root
        // handler (problem+json) owns everything outside /ui.
        if (request.method === 'GET' || request.method === 'HEAD') {
          // html arm: no-cache via setHeaders is route-path-based; the explicit
          // header wins for the fallback (sendFile ships the 30d plugin default)
          return reply.code(200).header('cache-control', 'no-cache').sendFile('index.html')
        }
        // non-GET deep-links fall to the root problem+json 404 — the root notFound
        // does NOT fire for in-scope misses; re-shape the problem HERE (the body
        // matches problem.ts's envelope byte-for-byte; ui.test.ts U6c pins the
        // byte-equality against a live root 404 — problem() stays private, the
        // pinned-untouched rule for problem.ts stands):
        return reply.code(404).type('application/problem+json').send({
          type: 'https://nightshift.local/errors/not_found',
          title: 'not found',
          status: 404,
          code: 'not_found',
          detail: 'route not found',
        })
      })
    },
    { prefix: '/ui' }
  )
}
```

(SHIPPED-FORM duties: the `deps` dead-line is RESOLVED pre-dispatch (preflight P7/fix11) — the stray `deps.deliveryLoop` line above is deleted; `mountUi(app: FastifyInstance, deps: AppDeps)` keeps the 2-arg signature for `buildApp` symmetry and `deps` exists ONLY for the skip-path — the warning rides `app.log` (if the repo's eslint flags the unused param, an eslint-disable-next-line on the signature is the sanctioned one-liner — measure, don't guess). The html `sendFile` maxAge option — verify `sendFile('index.html', { maxAge: 0, immutable: false })` at implement (README documents per-send options; the `setHeaders` html arm already covers it — the preflight confirmed the fallback answers `no-cache`). The non-GET in-scope 404 problem body must match `problem.ts`'s shape byte-for-byte — import the ENVELOPE from problem.ts if `problem()` is not exported (it is private — the test pins byte-equality against the root one; if byte-equality needs the builder, exporting it is a recorded one-liner in THIS task).

`app.ts`: `mountUi(server, deps)` immediately after `mountMcp(server, deps)` with a one-line ruling comment (`D-vv — static SPA mount, last mount; exact-set pins in auth.ts + the drift test`). `auth.ts` arm (D-vv #1), between PUBLIC_PATHS and the session arm (block BELOW: sync = shipped form — landed directly after the PUBLIC_PATHS return; the two comment sentences are the amendment's one wording change, the code lines are byte-verbatim):

```ts
// D-vv exact-set #1: the static SPA shell/assets are public under the /ui
// prefix ONLY (GET/HEAD — a POST to /ui answers auth like any other path:
// session POST /ui/x without CSRF gets the D-rr 403, a no-credential POST
// gets the bearer 401). Single-member set; membership + shape pinned in
// ui.test.ts (U6/U7 twins — the hook-arm matrix is byte-identical there).
const isUiPath =
  (request.method === 'GET' || request.method === 'HEAD') &&
  (path === '/ui' || path.startsWith('/ui/'))
if (isUiPath) return
```

- [ ] **Step 4: Gates (with the build present AND after `rm -rf adapters/sveltekit/build` — the ZERO-member drift set + U8 prove both faces honestly; restore the build before commit) + commit:**

```bash
git add src/adapters/rest/ui.ts src/adapters/rest/ui.test.ts src/adapters/rest/app.ts src/adapters/rest/auth.ts src/adapters/rest/openapi-contract.test.ts
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(ui): static /ui mount + exact-set pins for hook and drift (D-vv)"
```

> **Amendment (Task 10, @implementer — three blocks sync = shipped form; two duties resolved; honest RED declared):**
>
> 1. **`ui.ts` landed as the block plus EXACTLY two additions** (the block above now carries the shipped bytes): the plan-sanctioned `// eslint-disable-next-line @typescript-eslint/no-unused-vars` on the `mountUi` signature — measured, not guessed: the repo rule is after-used, so the unused tail `deps` flags — and the fallback `html arm` comment wrapped ABOVE `sendFile` (printWidth). The duties' conditional export of `problem()` from `problem.ts` was NOT taken: the in-scope non-GET 404 ships the block's literal body and U6c pins byte-equality LIVE (root ghost 404 ⇄ in-scope `POST /ui/deep/thing` bodies `toEqual`); `problem.ts` stays in the untouched-pinned set.
> 2. **`auth.ts` arm: code lines byte-verbatim, landed directly after the PUBLIC_PATHS return** (inside the plan's "between PUBLIC_PATHS and the session arm", leaving the D-vv(b) block untouched). One comment wording change (block relabeled): the membership/shape-pin sentence names **ui.test.ts** (U6/U6b/U7) — an auth.test.ts edit is on no Files/add line and the matrix ships byte-identical in the U-arms. Consequences pinned as ruled: session POST /ui/x WITHOUT CSRF ⇒ 403 D-rr (U6b), no-credential POST /ui/ ⇒ bearer 401 (U6), GET /uix ⇒ 401 (U7).
> 3. **U8 mechanism (the plan's "fresh Fastify w/ cwd pointing elsewhere"):** `BUILD_DIR` is the module-load `process.cwd()` literal, so the shift is `vi.spyOn(process, 'cwd')` + `vi.resetModules()` + fresh `await import('#root/adapters/rest/ui')`, mounted on a FRESH mini-app (`registerProblemHandlers` + `registerAuth` + real `t.deps`) — the real build dir is never moved (parallel-safe); spy/registry restored, tmpdir removed in `finally`. Pinned: warn-ONCE (exact string), `hasRoute GET /ui/* === false`, `/ui/x` ⇒ root problem+json 404, boot never crashes (`ready()` resolves).
> 4. **U5 mechanism (P7/fix13 re-pin):** the normalizer is unexported and no new export fits the Files line — the unit is MACHINE-COUPLED: the test asserts the three shipped source fragments (`(request.url.split('?')[0] ?? '/')`, `.replace(/\\/{2,}/g, '/')`, `.replace(/(.)\\/+$/, '$1')`) are present VERBATIM in auth.ts, then unit-pins the duplicated pipeline: collapse/trailing/query arms + dot-runs pass-through (`/ui/../openapi.yaml`, `/ui/../../etc/passwd` unchanged — fail-closed membership). No dot-segment inject pin exists or is claimed (light-my-request and every UA normalize before the hook).
> 5. **Arm growth (coverage duty):** U1 drives both `'/ui/'` and `'/ui'`; U4 also drives the HEAD deep-link (the scope-notFound `'HEAD'` disjunct); U3 additionally pins `content-encoding: br` so `preCompressed: true` is load-bearing; U6c captures the root 404 oracle first. All built-tree arms are `it.skipIf(!BUILD)`.
> 6. **Drift test:** grammar `(\/\S*|\*)` + the sentinel arm landed as amended (shipped text carries its own why-comments; the loud-fail throw message now names the wildcard leaf as grammar); the fails-loudly test re-pinned in the SAME edit — the old wildcard fixture parses to `['GET *','GET /tasks','POST /tasks']` and a genuinely junk leaf (`── ???junk (GET)`) still throws (bite kept); `hasUiGet`/`hasUiPost` captured before `t.close()`; MCP_ROUTES lines byte-untouched; the file's stale "This app registers neither [wildcards]" header paragraph rewritten to the D-vv reality. Evidence (with build): printRoutes prints exactly ONE bare `* (HEAD, GET)` leaf (no `/ui` node — pretty-print carries no path for wildcards); `hasRoute GET /ui/* → true`, `POST /ui/* → false`.
> 7. **Both faces (Step 4) + gates:** WITH build — `pnpm test` 639/85 → **650/86**, lint 0, typecheck clean, build exit 0; globals **99.49 / 98.38 / 99.78 / 99.69** (≥ the Task-9 record 99.48/98.35/99.77/99.68, every axis up); `ui.ts` and `app.ts` **100×4**; `auth.ts` 100/97.82/100/100 — the only uncovered branch is the documented `:76` `?? '/'` arm, same arm, unchanged number. WITHOUT build (`rm -rf adapters/sveltekit/build`): 642 passed + **8 skipped, loud in the reporter** (never silent — tonight's gates run WITH the build, where the 8 are counted as run), the drift STATIC arm passes on the ZERO-member set, U8+U5 green; the build was restored via `pnpm ui:build` before commit (artifacts git-invisible). Honest RED: both test files failed at file level on module-absent (`#root/adapters/rest/ui`, 0 tests collected) before Step 3 — per-test REDs were never collected, so none is claimed; everything else passed first-run and none is claimed from that either.

## Task 11: §11.5 Playwright smoke + the honest runner posture (D-xx)

**Files:**

- Create: `playwright.config.ts`, `e2e/smoke.e2e.ts`, `e2e/global-setup.ts`, `src/testing/stub-idp-main.ts` (the stub as a real-socket server FOR E2E ONLY — documented exception to zero-sockets: a browser is a network actor by definition; it stays an in-repo stub, NEVER a real IdP)
- Modify: `package.json` (devDep `@playwright/test@1.63.0` — `pnpm add -w -D @playwright/test@1.63.0`), `.gitignore` (`playwright-report/` + `test-results/`)

- [ ] **Step 1: Browser probe FIRST (the posture hinges on it, not on hope):**

```bash
pnpm exec playwright install chromium --only-shell 2>&1 | tee /tmp/ns-e-playwright-install.log
pnpm exec playwright screenshot --browser chromium about:blank /tmp/ns-e-pw-probe.png 2>&1 | tee /tmp/ns-e-playwright-launch.log; echo "launch exit: $?"
```

Exit 0 ⇒ **RUN path** (review R5/B11: the 1.63 CLI has NO `launch` command — `playwright screenshot` IS a real headless launch, so the screenshot IS the launch probe; the tee log keeps its `launch` name as the evidence file). Non-zero missing-shared-library errors ⇒ **NO-SYSTEM-SURGERY path** (Night-shift: no pacman, no sudo, ever): the suite still SHIPS, Task 11 stops at Step 4's recorded skip, D-xx posture lands in the final record with both logs quoted, and QUEUED (HUMAN) gains "operator: `pnpm exec playwright install chromium` + the Arch shared libs". **The recorded choice is made by the probe, never by hope; the log files are the evidence either way.**

- [ ] **Step 2: Config + servers** `playwright.config.ts`: `testDir: 'e2e'`, `fullyParallel: false`, `globalSetup: './e2e/global-setup'`, `webServer: [ {command: 'NODE_OPTIONS=--conditions=development pnpm exec tsx src/testing/stub-idp-main.ts', url: 'http://127.0.0.1:3310/ping', reuseExistingServer: false}, {command: 'NODE_OPTIONS=--conditions=development pnpm exec tsx src/index.ts', url: 'http://127.0.0.1:3311/ping', env: {NS_PORT:'3311', NS_DB_PATH: <fresh tmp db path>, NS_DATA_DIR: <fresh tmp>, NS_OIDC_ISSUER:'http://127.0.0.1:3310', NS_OIDC_CLIENT_ID:'nightshift-e2e', NS_OIDC_CLIENT_SECRET:'e2e-secret-not-a-real-one-0001', NS_PUBLIC_URL:'http://127.0.0.1:3311', NS_SESSION_KEY:'e2e-session-key-0000000000000000000000000', NS_BOOTSTRAP_TOKEN:<64-hex literal>, NS_WEBHOOK_INTERVAL_MS:'0'}, timeout: 120_000} ]`. `stub-idp-main.ts` listens on `:3310` (`0.0.0.0`? — `127.0.0.1` only, stated) with the SAME `buildStubIdp` code, users `alice`/`bob`.

- [ ] **Step 3: `global-setup.ts`** — bootstrap-admin API only (NO UI, NO real network — 127.0.0.1 only): POST `/admin/allowlist` `alice@example.com` via bearer bootstrap; PUT `/admin/policy/oidc_provisioning` `allowlist`; write the bootstrap token + actor id to an `os.tmpdir()`-routed file OUTSIDE the repo (review note (e): no `.tokens.json` in the tree, no gitignore churn — `.gitignore` gains only `playwright-report/` + `test-results/`) — the run is DETERMINISTIC because both servers boot fresh (tmp DBs; the D-j purge + empty tables).

- [ ] **Step 4: `smoke.e2e.ts` — the §11.5 chain, exactly one test, honest names:**

```ts
// test('§11.5 login -> board -> task -> comment -> status', ...)
// 1  goto /ui/login            => the OIDC button (no registration page exists — pin the ABSENCE)
// 2  click                     => redirected to 127.0.0.1:3310/authorize (stub page), pick alice
// 3  arrive back on /ui/       => board visible; BOTH __Host- cookies present in context (expect.poll on context.cookies(); __Host- semantics: Secure + Path=/ + no Domain — assert the attributes, not just presence); __Host-ns_csrf readable BY THE PAGE (not HttpOnly — D-rr companion proof from a real browser)
// 4  file a task via the board form => swimlane card appears (events-polling refetch: the card shows WITHOUT a manual reload — that IS the §8 polling assertion)
// 5  open the task detail      => tabs render all six §8-2 names
// 6  post a note comment       => appears in conversation tab (CSRF header rode: assert via page.route spy on the POST)
// 7  PATCH status via the header control to in_progress (human member — no claim, no lease: legal transition pinned) => header shows in_progress
// 8  negative CSRF pin from a REAL browser: page.evaluate fetch POST /tasks WITHOUT the header + valid cookie => 403 (the D-rr arm against a real cross-context-free client — honest in-browser)
// 9  sign out via nav          => /ui/login; direct goto /ui/tasks/... 401-bounce path (session dead: the 401-bounce in api.ts lands on login)
```

**Step 5:** run iff probe passed: `pnpm test:e2e` green twice (flake sanity); record command+output into the final record. **Step 6: Commit:**

```bash
git add playwright.config.ts e2e src/testing/stub-idp-main.ts package.json pnpm-lock.yaml .gitignore
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "test(e2e): playwright 11.5 smoke against stub idp (D-xx)"
```

> **Amendment (Task 11, @implementer — RUN path: the probe is green, the suite shipped, and the smoke CAUGHT two real UI defects; honest RED recorded, no fake green, zero assertion bends):**
>
> 1. **Step-1 probe — evidence quoted verbatim.** Install (`/tmp/ns-e-playwright-install.log` tail): `Chrome Headless Shell 153.0.8010.12 (playwright chromium-headless-shell v1243) downloaded to ~/.cache/ms-playwright/chromium_headless_shell-1243` + `FFmpeg (playwright ffmpeg v1011) downloaded to ~/.cache/ms-playwright/ffmpeg-1011` (with the CLI's `BEWARE: your OS is not officially supported by Playwright; downloading fallback build for ubuntu24.04-x64.` lines). **Redaction per Night-shift protocol #7:** local home prefixes shown as `~` — the verbatim logs remain the run host's `/tmp` files.) Launch probe (`/tmp/ns-e-playwright-launch.log`, complete): `Navigating to about:blank` / `Capturing screenshot into /tmp/ns-e-pw-probe.png` / `launch exit: 0`. **⇒ RUN path** (no system surgery at any point; the Arch-hosted fallback build runs on the libs already present).
> 2. **The suite ran (RUN path) and is RED against the shipped tree** — and the failure is NOT a selector bend: `expect(locator).toBeVisible() failed … getByRole('link', { name: 'Sign in with your account' }) … element(s) not found` at step 1, while the server log shows `/ui/login 200` + every immutable asset 200. The SPA renders NOTHING in a real browser. Two genuine product defects, each measured with isolated diagnostics (all probe artifacts deleted, none committed): **D1 (CSP, `adapters/sveltekit/src/app.html` — the plan's own Task-8 CSP block is the defect):** Kit's static fallback boots the SPA through an INLINE module-bootstrap script; the shipped meta `default-src 'self'; …` has no `script-src` allowance, and Chromium's console says: `Executing inline script violates the following Content Security Policy directive 'default-src 'self''…` — the bootstrap never executes, so no page ever mounts. adapter-static offers no nonce hook for that fallback script; the minimal honest shape is appending `script-src 'self' 'unsafe-inline'` (a D-vv CSP-posture decision — NOT this task's to smuggle). **D2 (layout, `adapters/sveltekit/src/routes/+layout.svelte`):** behind CSP, `{@render children()}` has no `let { children } = $props()` — the compiled artifact emits `$.snippet(node_2, () => children)` (a free identifier; `f(I,()=>children)` in the shipped bundle) and the browser throws `pageerror: children is not defined`. The proposed UI-lane diffs are exactly: `content="default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'"` and one line `let { children } = $props()` after the layout's imports. **Verification of the repairs (staged in the working tree, NOT committed — the views stay byte-untouched in this commit):** `pnpm ui:build` clean and with BOTH repairs in place, `pnpm test:e2e` passed twice — tails verbatim: `✓ 1 e2e/smoke.e2e.ts:8:1 › §11.5 login -> board -> task -> comment -> status (718ms)` / `1 passed (4.0s)` (and the preceding run likewise `1 passed`) — every §11.5 pin held AS WRITTEN: the OIDC-button absence pin, the stub `login_hint` leg, the Set-Cookie attribute pins (`__Host-ns_sess` HttpOnly+Secure+Path=/+no-Domain+Max-Age=28800, companion `__Host-ns_csrf` NOT HttpOnly + readable via `document.cookie`, `__Host-ns_flow` cleared Max-Age=0), `context.cookies()` attribute equality against `{secure:true, path:'/', domain:'127.0.0.1'}`, the board→detail→six-tabs chain, the CSRF-header route spy, the header-control status PATCH, the in-browser negative-CSRF 403 (`'missing or invalid CSRF token (D-rr)'`), the sign-out and the dead-session 401-bounce. The repairs were then REVERTED (`git checkout` — tree byte-clean) and the UI rebuilt from shipped sources; against the shipped tree the smoke fails at step 1 with the error quoted above (`exit 1`). **What ships UNRUN: nothing — the suite ran; it is honestly RED until the UI-lane repair commit lands. QUEUED (HUMAN) for the operator/review lane: land the two UI diffs above (D1 carries the CSP `script-src` decision), then re-run `pnpm test:e2e` — the suite needs no edits.**
> 3. **Shipped-form notes.** (a) `e2e/e2e-env.ts` is a NEW file beyond the Files line — the ONE constants module so config/globalSetup/smoke share tmp paths + the 64-hex bootstrap literal `'e2ee2e…2ee'` (token env-only per D-ff; the run is deterministic — fresh mkdtemp'd tmp DB/data at config-load time); (b) `src/testing/stub-idp-main.ts` boots the SHIPPED `buildStubIdp` factory (users alice `alice@example.com` — the Task-7 seed email — and bob) on `127.0.0.1:3310` and adds the `/ping` readiness leg beside it (the shipped factory registers no health route; stub-idp.ts is not this task's surface to grow); the e2e exception is STATED in the file header: real socket FOR THE BROWSER ONLY, in-repo stub, loopback-only, never a real IdP; (c) the webServer env block is EXACTLY the section's block (stub :3310 / app :3311, `NS_WEBHOOK_INTERVAL_MS '0'`, `reuseExistingServer:false` both, stdout pipe, 120 s timeout); (d) `global-setup.ts` seeds via the bootstrap bearer ONLY (`POST /admin/allowlist` alice@example.com + `PUT /admin/policy/oidc_provisioning allowlist` + `GET /auth/me` identity), fail-loud on any leg, and writes `{bootstrapToken, actorId, role, seededAt}` to `os.tmpdir()/nightshift-e2e-XXXX/bootstrap-token.json` — nothing in the repo tree; `.gitignore` gains ONLY `playwright-report/` + `test-results/`; (e) **harness reality measured tonight:** this headless-shell build does NOT surface redirect hops to `page.route` (a direct goto IS intercepted, the 302-continuation is never delivered) and the shipped stub has NO HTML consent page — selecting a user IS the stub's documented test-only `login_hint` query leg (stub-idp.ts:84-96), so the smoke rides `login_hint` by rewriting the `/auth/login` redirect's own Location (the interceptable first hop); every hop after that — `:3310/authorize` → callback → `/ui/` — is a real, un-intercepted browser navigation. The login flow is therefore browser-driven end-to-end; nothing was driven outside the browser. (f) `smoke.e2e.ts` carries a `page.on('pageerror')` honesty rig (surfaced D2's ReferenceError; SPA console errors never swallowed). (g) `@playwright/test@1.63.0` exact-pinned devDep (Apache-2.0); `pnpm-lock.yaml` root-importer delta is exactly that addition.
> 4. **Gates (all with the shipped tree, views byte-clean):** `pnpm test` **650 passed / 86 files** exactly (e2e invisible to vitest: include `src/**`; `src/testing/**` coverage-excluded), lint **0** (stub-idp-main.ts included and clean), typecheck clean, build 0, coverage **99.49 / 98.38 / 99.78 / 99.69** — every axis unchanged vs the Task-10 record (never-lower honored; e2e adds nothing to src coverage), `format:check` = exactly the two baseline residuals (`.slim/deepwork/plan-e-oidc-ui.md` + the design spec). Backend first-run-green declarations: every backend gate passed first-run tonight — there is no RED phase to claim for them and none is claimed. The e2e RED is claimed in full, quoted, above.
> 5. **FIX ROUND (orchestrator rulings R-1/R-2 — the two UI-lane blockers LANDED, the e2e is now green on the shipped tree):** **R-1 (D2, the `children` bug)** — "clear defect, correctness fix, lands as-is": `let { children } = $props()` after the imports of `adapters/sveltekit/src/routes/+layout.svelte`. The plan shows NO fenced layout block (the layout shell is prose in Task 8's amendment (5) — "children() slot" — and Task 9's note 7), so there are no plan bytes to re-label; this line IS the record. **R-2 (D1, CSP)** — ORCHESTRATOR RULE: `script-src 'self' 'unsafe-inline'` lands in the app.html meta, "because Kit's nonce/hash CSP only applies to server-rendered pages and the adapter-static fallback is static (per-request nonces impossible); the inline bootstrap is adapter-generated; `connect-src 'self'` + `default-src 'self'` remain the load-bearing locks" — no other directive softened, one line changed: `content="default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'"`. The Task-8 Step-4 app.html block above is updated to the shipped line + re-labeled `sync = shipped form` (fix-round clause). **QUEUED (HUMAN):** nonce/hash-grade CSP = shell-strategy change (§12 candidate), operator's call. **Verification (this round, shipped tree, views as committed):** `pnpm ui:build` exit 0, offline-check unchanged (`hosts seen: http://www.w3.org https://svelte.dev`); `pnpm test:e2e` green TWICE — run 1 tail verbatim: `✓ 1 e2e/smoke.e2e.ts:8:1 › §11.5 login -> board -> task -> comment -> status (740ms)` / `1 passed (4.0s)`; run 2 tail verbatim: `✓ 1 e2e/smoke.e2e.ts:8:1 › §11.5 login -> board -> task -> comment -> status (707ms)` / `1 passed (4.0s)`. Backend gates: `pnpm test` **650 passed / 86 files** exact, lint 0, typecheck clean, build 0 — coverage NOT re-run by ruling: zero `src/**` production changes (both files live in `adapters/sveltekit`, invisible to vitest/coverage/tsc/eslint), so the axes cannot move. The §11.5 story is now told end-to-end by the REAL browser, not just the vitest seams.

## Task 12: Final whole-plan gate + record + PR (Night-shift endgame)

**Files:**

- Modify: this header (final-gate record), plus the PR body (via `gh`, redaction-passed)

- [ ] **Step 1: Zero-churn proofs (success criteria, not ritual):** `git diff main --stat -- openapi/ src/domain/errors.ts src/adapters/mcp/mount.test.ts` → ONLY the recorded yaml additions (D-zz ops + Actor.role + the D-vv labels addendum + the Task 6 policy-enum widening) and NOTHING on errors.ts; the 35-tool snapshot byte-untouched (`git diff main -- src/adapters/mcp/mount.test.ts` empty); `git diff main --stat -- src/domain` shows ONLY `src/domain/task.ts` (the HUMAN_ROLES addition — recorded D-ss duty, domain 100×4 holds); `vitest.config.ts` + `lefthook.yaml` + `ci.yaml` + `problem.ts` byte-untouched (diffs empty).

- [ ] **Step 2: The gate:** `pnpm test:coverage && pnpm lint && pnpm typecheck && pnpm build && pnpm ui:build && pnpm ui:offline-check && pnpm test:e2e` — every global axis ≥ the Plan D record (99.36 / 97.81 / 99.74 / 99.61 — never-lower HELD; new-code arms closed-by-test or documented with one-line justifications exactly as Plan D's record did; the ENFORCED floors unchanged and holding); honest counts recorded (517 → N).

- [ ] **Step 3: Append the FINAL-GATE RECORD** to this header (Plan D's format: figures vs baseline with honest accounting per arm; tool-surface 35 frozen-unchanged line; the E2E posture line quoting the Task 11 probe outcome VERBATIM either way; the D-yy CLI-slice restatement; the commit chain task-by-task; the QUEUED (HUMAN) ledger: Pocket ID real credentials + `INTERNAL_APP_URL` note, real-instance nonce verify, browser binaries + CI job, key rotation, session table pruning/§12 candidates).

- [ ] **Step 4: Byte-sync audit:** every shipped divergence has its amendment + `sync = shipped form` re-label; `rg -n "TBD|TODO|fill in|similar to Task" docs/superpowers/plans/2026-09-09-nightshift-plan-e-oidc-ui.md` → empty (plan-failure scan).

- [ ] **Step 5: Commit record, then end-of-night per ticket #9 (NOT Plan D's STOP — the ticket's Night-shift protocol governs):** gates green ⇒ `git push -u origin feature/plan-e-oidc-ui` + PR (`gh pr create --title "feat: Plan E — OIDC human login & minimal UI" --body <shape of #3/#5/#8> — resolves #9`); red ⇒ push NOTHING, branch intact, honest state in the record. Redaction pass on the PR body: no local absolute paths, usernames, hostnames. **NEVER merge.**

```bash
git add docs/superpowers/plans/2026-09-09-nightshift-plan-e-oidc-ui.md
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "docs(plan): plan E final gate record"
```

---

## Execution handoff

Plan complete. Per the ticket's Night-shift protocol the human sign-off gate is WAIVED and replaced by: (1) this plan's **independent plan-review lane** (PASS on spec-coverage §8/§5/§10/§11.5 + scope + rulings BEFORE any implementer dispatch; FAIL ⇒ revision as a logged amendment), and (2) the **plan-artifact preflight** — every embedded block machine-verified before dispatch (extract & compile probes against the pinned deps: jose subpaths + `createRemoteJWKSet` fetch-option shape; the mount.ts/`printRoutes`-derived drift expectations; the stub-IdP sign/verify roundtrip via `crypto.subtle` on node 24; cookie-attribute strings; kit config parses + offline-check script dry-run; the ADD-COLUMN identity migration against a migrated fixture DB), registry-checks DONE above (2026-09-09), trickiest session/CSRF/cookie assertions dry-run. Then execute with subagent-driven-development — fresh implementer per task, spec-compliance review THEN code-quality review per task, serial execution on shared wiring, fix rounds re-verified by the same reviewer, TDD with honest REDs, byte-sync amendments with lineage, coverage never lowered. QUEUED (HUMAN) items never block; stop conditions per ticket (baseline not green at recorded numbers; unbridgeable spec conflict; dependency unverifiable).
