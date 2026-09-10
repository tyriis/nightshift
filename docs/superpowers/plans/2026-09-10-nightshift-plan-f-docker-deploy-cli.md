# Plan F: Docker Image, Homelab Deploy & the CLI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the last §12 slice and the deploy wave: the `nightshift next|claim|report` CLI over the D-kk generated client (zero new runtime deps, zero server-contract change), one multi-stage Docker image serving static UI + REST + MCP from one container with the offline guard as a BUILD gate and a recorded cwd-relative asset ruling, and the repo-side homelab artifacts (`deploy/README.md` env surface + the `deploy/DEPLOY-SMOKE.md` checklist that runs §14 live and the FTS5 declared-not-pinned arms) — honestly recording what ran here versus what the operator runs at home.

**Architecture:** The CLI is a pure DI core (`src/cli/run.ts`: argv+env+io+fetch in, exit code out — the same zero-socket `inject()` harness the client uses) behind a 5-line repo-bin shim (`bin/nightshift.mjs`, the only site reading `process`/`globalThis.fetch`); it rides the drift-pinned `createNightshiftClient` and the D-jj flat problem envelope — agents branch on codes, never parse prose. The image is three `node:24-bookworm-slim` stages (full build + UI offline gate → `--prod` install where `better-sqlite3` compiles → bare runtime with prod `node_modules` + `dist/` + `openapi/` + `adapters/sveltekit/build/`, non-root, `/data` volume, `node -e` healthcheck on `/ping`); the cwd-relative asset story is KEPT and made provable by WORKDIR `/app` (D-ccc — the Dockerfile is the ruling's evidence). `deploy/` ships the full `NS_*` surface (transcribed from `src/main/config.ts`), the Pocket ID `INTERNAL_APP_URL` caveat (D-pp), and a checklist that automates every non-interactive probe (`scripts/deploy-smoke.mjs`, zero deps, PASS/FAIL lines) while the browser/IdP legs stay operator steps (§14 live, honest posture per D-xx lineage).

**Tech Stack:** no new dependencies of ANY kind — node 24 / pnpm 10.33 via mise; the CLI reuses `openapi-fetch@0.17.0` + `zod@4.5.4` (both already shipped) and the `#root/*` alias; the image is plain Dockerfile multi-stage (buildkit); the deploy scripts are dependency-free node 24 (the `scripts/ui-offline-check.mjs` precedent — `scripts/`, `bin/`, `deploy/`, `Dockerfile` are invisible to the tsc/eslint/vitest gates exactly like `adapters/sveltekit/` stays). All versions registry-frozen by the existing lockfile — D14's sanctioned-four runtime exceptions stay exactly four.

**Spec / Inputs (all in-repo):** `docs/superpowers/specs/2026-09-05-nightshift-design.md` §9 (single image, static UI), §12 (the CLI line), §14 (the v1 acceptance story), §11 (agents branch on `code`), §4 D14 · ticket [tyriis/nightshift#11](https://github.com/tyriis/nightshift/issues/11) (scope 1–5 + QUEUED + working agreements) · Plan E record `docs/superpowers/plans/2026-09-09-nightshift-plan-e-oidc-ui.md` (D-pp Pocket ID caveats, D-xx honest-e2e posture, D-yy CLI slice, D-zz regen duty, FINAL-GATE RECORD + its two binding process lessons) · Plan D record (D-kk client substrate, D-oo handoff origin) · Plan C record (FTS5 declared-not-pinned arms) · Plan B (D-ff credential posture) · Plan A (asset-shipping backlog note from #2).

---

## Status & provenance

- Branch: `feature/plan-f-docker-deploy-cli` off `main` @ `d8b7f7d` (PR #10 merge commit — **Plan E IS merged, verified 2026-09-10**; ticket #11's branch-after-merge gate SATISFIED). **Push/PR at end-of-night per the Night-shift protocol (ticket #9 lineage); NEVER merge — merges are @tyriis's (binding).**
- Ticket: tyriis/nightshift#11 (session-handover; scope = the issue body's "Plan F scope" 1–5 + the explicit slice-outs; state remains frozen — SSE, search UI / saved filters / undo, keepalive enforcement, capability scopes, §13 items are NOT touched).
- Baseline gate (from Plan E's FINAL-GATE RECORD at `40c2bd1`, main = the merge of that chain): **650 tests / 86 files; Stmts 99.49 / Branch 98.38 / Funcs 99.78 / Lines 99.69**; lint / typecheck / build / `ui:build` / `ui:offline-check` clean; `test:e2e` green (stub IdP). Documented-uncovered set (modulo renumbers only): `auth.ts :76`, `mount.ts :51-54` family, `rate-limit.ts :35`, `task-repo.ts :178-191`, `thread-repo.ts :96/132`, `migrations.ts :324` error arm.
- Environment facts (planner-verified 2026-09-10 on this branch): node 24.20.0 / pnpm 10.33.0 via mise; **docker 29.7.2 with a live daemon** (the Task 5 image build CAN run here); no Dockerfile / .dockerignore / `deploy/` exists yet (filesystem-verified); `domain TASK_STATUSES` (`src/domain/task.ts:1-8`) === yaml `TaskStatus` enum (`openapi/openapi.yaml:954-956`) byte-checked; `nightshift-ui` has ZERO runtime deps (`adapters/sveltekit/package.json` — devDependencies only), so `pnpm install --prod` lands exactly the root production tree; `/ping` is public (`auth.ts:22` `PUBLIC_PATHS`); `NS_*` surface = `src/main/config.ts:3-56` (16 vars).
- Decision letters: Plans A–E exhausted the single-letter and repeated-pair space (`D-a`…`D-l`, `D-m`…`D-z`, `D-aa`…`D-gg`, `D-hh`…`D-oo`, `D-pp`…`D-zz` with **`D-uu` permanently dead** — it dangles uncited in Plan D line 37 and is never reused). **Plan F continues the repeated-pair tradition in triple form: `D-aaa`, `D-bbb`, `D-ccc`, `D-ddd`, `D-eee`.** Grep duty: the triples CONTAIN Plan C's pairs as substrings (`D-aa` ⊂ `D-aaa`) — every ledger citation is whole-token (`\bD-aa\b` matches the C record, never the F one).
- The CLI handoff chain closes here: D-oo (Plan D defers) → D-yy (Plan E slices to F) → **D-aaa (this plan owns and ships it)**. Restated in the final-gate record + the PR body so the chain shows no break.

### Pre-dispatch amendment ledger (plan-review + artifact preflight)

Per the ticket protocol and Plan E's binding lessons ("treat your own plan as untrusted input"; "policies decay, tools don't"), BEFORE any implementer dispatch: (1) an independent plan-review lane (PASS/FAIL on spec §9/§12/§14 coverage, scope vs ticket #11, rulings; FAIL ⇒ revisions logged here); (2) the **machine artifact-preflight** extracting and compiling EVERY embedded block against the pinned deps.

**ROUND 1 — 2026-09-10. Independent review attempt 1: FAIL (B1–B6 + notes); artifact preflight: P1–P10 ALL PASS (zero repo mutation).** All six blockers applied to the blocks as the fixes below; **re-review (attempt 2) is required before implementer dispatch.** The byte-sync protocol still governs shipped-vs-plan divergences.

- [B1] Task 3's `threads` helper re-pinned to the server's `ThreadWithMessages` shape (`ports.ts:288-291`) — `kind` read under `.thread`; the honest-partial arm (`messages[0].body`) unchanged (top-level is correct). Same finding fired independently in preflight (S1).
- [B2] `deploy-smoke.mjs`: the claim SURVIVES `in_progress` (`update-status.ts` clears it only on in_review/done) — the script now RELEASES before the human cancel (preflight verified the exact claim→move→release→leaseless-cancel=200 arm); preflight S2 fired identically.
- [B3] Task 6 Step 3 runs the script HOST-side (it byte-compares this checkout's openapi) ⇒ `NS_URL=http://127.0.0.1:3199` (the published mapping); 3123 stays container-internal for the `docker exec` arms.
- [B4] Task 1 Step 1: `makeInjectFetch(() => CURRENT.app)` — `CURRENT` is the TestApp; the getter must yield the FastifyInstance (TS2345).
- [B5] Task 1's next-loop `r.data ?? []` (statically uncoverable right-arm, P10 violation) replaced by the documented trust-cast `r.data as unknown[]` — consistent with the claim/report casts.
- [B6] The never-lower floor corrected to E's real record **99.49 / 98.38 / 99.78 / 99.69** (Funcs was mistyped 99.74 = D's axis value; four places) — a gate that would have green-lit a regression.
- [n1] commit subjects re-lengthed ≤72 (Tasks 3/7); [n2] `scripts/fts-probe.mjs` added to the File structure; [n3] the runtime-stage ui-manifest COPY kept — harmless by preflight evidence (prod install ships no ui node_modules); [n4] the FTS delete-trigger's honest-RED duty is already carried by Task 6's expectation line; [n5] the dead `?? e.id` events arm dropped.
- [preflight facts] zod@4.5.4 surface + no-secret-echo CONFIRMED; the Task-1 run.ts block executed standalone (every ladder arm byte-exact, `tsc --noEmit` exit 0 on the assembled blocks — no `as never` anywhere); the P3 spawn mechanism live (exit codes cross the process); `pnpm install --prod --frozen-lockfile` resolves from the four manifests to exactly the eight prod deps; the HEALTHCHECK quoting survives `sh -c` and both arms answer 0/1; `--start-interval=1s` is accepted by the daemon, NOT silently dropped; **better-sqlite3@13 arm: pnpm runs `node-gyp rebuild` while the runtime prefers the tarball-bundled `prebuilds/linux-x64.node` — the toolchain layer is required either way**; openapi-fetch garbage-shape arms match the failFrom design; the claim race/leaseless-move/`stale_lease`-412/`agent_close_forbidden` arms CONFIRMED against the live app (Task 3's pins are server truth).
- [S3] `AbortSignal.timeout` is an unref'd timer — the timeout arm is vitest-only territory (as written; do not validate with bare-node one-offs). [S4] `docker build` on this box is the LEGACY builder (no buildx) — the Dockerfile is builder-agnostic by construction; the Task 5 build and the final record state the builder used (Task 5 Step 3 carries the duty).

Preflight probes executed (all PASS; outcomes folded into the ledger above):

- **P1** `z.url()` + `z.coerce.number()` + `z.enum(readonly tuple)` exist and behave as written on zod@4.5.4 (compile probe).
- **P2** `AbortSignal.timeout(ms)` + the `fetch: (input, init) => base(input, { ...init, signal })` wrapper compiles under TS 6.0.3 nodenext and the inject-fetch harness ignores the signal; the 100 ms timeout arm is deterministic.
- **P3** `node --import tsx bin/nightshift.mjs --help` exits 0 with `NODE_OPTIONS=--conditions=development` (the spawn-test mechanism AND the `pnpm cli` dev path).
- **P4** `pnpm install --prod --frozen-lockfile` probe in a throwaway dir with ONLY the three manifests + `adapters/sveltekit/package.json` (the proddeps stage's inputs) — lockfile resolves prod-only cleanly.
- **P5** `HEALTHCHECK ... CMD node -e "fetch('http://127.0.0.1:'+(process.env.NS_PORT??3123)+'/ping')..."` survives Dockerfile shell-form quoting AND answers exit 0/1 correctly against a live `/ping` (probe via `docker run --entrypoint sh` or a node one-off) — and `--start-interval=1s` is ACCEPTED by the docker 29.x engine (the fast-first-probe posture the Task 5 smoke waits on; a silently-dropped healthcheck flag is the E silent-ignore class).
- **P6** `better-sqlite3@13.0.3` on node 24 linux-x64 bookworm: record WHICH arm fired in the actual build (prebuild-download vs source-compile); the toolchain layer ships either way.
- **P7** openapi-fetch@0.17.0 empty-body-2xx and non-problem-body shapes: whichever the library returns, the CLI ladder answers exit 1 (pin the ladder, not the library).
- **P8** the CLI claim race over the REAL app: loser exits 3 with line 1 exactly `nightshift: already_claimed` and flat `holder_handle` on line 2 (D-jj flatness through the CLI, not just the client).
- **P9** release-then-status without a lease (unclaimed task): `PATCH /tasks/{id}/status` answers 200 for the claimless arm the Task 3 test claims; `agent_close_forbidden` answers 403 for an agent closing (scenarios lineage).
- **P10** `runCli`'s run.ts ships with EVERY branch covered (arm inventory in Task 1/2/3; the coverage gate proves it — the never-lower bar tolerates no silent uncovered arm).

### Inherited binding rulings (Plans A–E — obey; violation = task failure)

- **Error taxonomy ONE map, ZERO new codes:** `src/domain/errors.ts`, `problem.ts` `ADAPTER_ERROR_CODES` and the yaml `Problem.code` enum stay byte-untouched. The CLI's three ladder strings (`transport_error`, `usage_error`, `config_error`) are CLI-stderr-only strings and DO NOT join the taxonomy (no yaml change — that is the "no server contract change" proof). Server codes on CLI stderr are the taxonomy verbatim, never reworded.
- **ZERO server-contract change:** `openapi/openapi.yaml`, `src/client/schema.d.ts`, the 35-tool MCP snapshot (`mount.test.ts`), `PUBLIC_PATHS`/`AUTH_PRE_SESSION`/`/ui`/`MCP_ROUTES`/drift wildcard-sentinel exact sets, `__Host-` cookie attrs, hook order — byte-untouched. `src/adapters/**`, `src/domain/**`, `src/application/**`, `src/infra/**`, `src/main/**`, `src/index.ts` receive NO edits (F is additive: `src/cli/`, `bin/`, `scripts/`, `deploy/`, `Dockerfile`, `.dockerignore`, `package.json` bin+script lines only, plan doc). If anything seems to require a server change, that is a recorded ruling (amendment + decision letter), not a side effect.
- **Coverage never lowered:** thresholds unchanged (global ≥85, `src/domain/**` 100×4), `vitest.config.ts` byte-unchanged; every global axis ≥ the Plan E record (99.49 / 98.38 / 99.78 / 99.69). `src/cli/**` lands inside `src/**/*.ts` coverage include — every arm in the Task 1–3 inventories closes by test (no `??`/`?.`/ternary without a covering arm; trust-casts are documented, not asserted away). Test helpers live under `src/testing/**` (coverage-excluded — placement is a coverage decision, not style).
- **Machine strings are grep-pinned** by their test in the same task (CLI exit ladder + stderr tokens included); never reworded later.
- Secrets (D-ff): `NS_TOKEN`/`NS_LEASE_TOKEN`/`NS_SESSION_KEY`/`NS_OIDC_CLIENT_SECRET`/`NS_BOOTSTRAP_TOKEN` env-only, never argv, never logged, never echoed in errors (a pin proves stderr never echoes them); `.dockerignore` excludes `.env*` (secrets NEVER bake into an image layer); the smoke script reads secrets from env only.
- New runtime deps: NONE (D14's four stay four). DevDeps: none. `pnpm-lock.yaml` gains ZERO churn beyond the existing lockfile (package.json bin/script edits touch no resolutions).
- Toolchain-boundary (E's `adapters/sveltekit/` rule extended by precedent): `Dockerfile`, `.dockerignore`, `bin/`, `scripts/`, `deploy/` are invisible to tsc (`include:["src"]`), eslint (`eslint src`) and vitest (`src/**/*.test.ts`) — same territory as `scripts/ui-offline-check.mjs`; their gates are EXECUTION (Task 5/6 run them for real) and the final-gate record, not the unit suite.
- Conventions: TDD, `pnpm test <file>` red/green then `pnpm test && pnpm lint && pnpm typecheck` before commit; `LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "<≤72-char conventional subject> (D-x)"`; `git add` explicit files; tests colocated `*.test.ts`; env via `makeTestApp()`; temp dirs via `os.tmpdir()`; `#root/*` imports only (TS2835); prettier config-lookup trap; honest REDs ("no RED to claim and none is claimed"); **raw-git-verify your own commits before claiming them** (E's top lesson); **probe silently-ignorable options in the preflight** (E's second lesson — applies doubly: a Dockerfile flag that quietly no-ops is the same failure class as jose's `{ fetch }`); a commit cannot quote its own hash.
- Night-shift protocol (ticket #9 lineage): the sign-off gate is replaced by the plan-review lane + artifact preflight above; QUEUED (HUMAN) items never block (route around + say so); no real Pocket ID traffic (deploy-smoke here runs against the LOCAL container; the real-IdP legs are operator checklist steps); no global installs (docker daemon ops only — `docker build/run` against the local daemon is sanctioned, it is F's deliverable); no `.env*`/`*.db`/secret reads; redaction pass on every public write; end of night: gates green ⇒ push + PR `resolves #11`; red ⇒ branch intact, honest record. **NEVER merge.**

### Plan ⇄ shipped byte-sync protocol (same as Plans A–E)

The code blocks below are the planned text. If shipped code lands byte-different (review repair, lint normalization, preflight correction), the implementer appends a `> **Amendment (Task N, <who/what>):** …` blockquote to that task's section in THIS file, quoting what changed (with `git show <hash>` for review repairs) and re-labels the block `sync = shipped form`. Never leave the plan silently describing code that does not exist. Amendments land in the child fix commit (a commit cannot quote its own hash).

### QUEUED (HUMAN) — never blocks tonight

| Item                                                                                                                                    | Route-around for tonight                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real Pocket ID client credentials + `INTERNAL_APP_URL` jwks/token rewrite + nonce verify-once (D-pp)                                    | operator checklist steps 4–5 in `deploy/DEPLOY-SMOKE.md`; automated probes run against the stub-free local container WITHOUT OIDC (OIDC-dormant boot is a pinned config arm) |
| Playwright browser re-install after upgrades + optional CI e2e job (`ci.yaml` byte-untouched; D-xx)                                     | `test:e2e` runs probe-first at the final gate; honest posture either way                                                                                                     |
| nonce/hash-grade CSP (shell-strategy change; E's R-2)                                                                                   | untouched                                                                                                                                                                    |
| Session-key dual-rotation story (D-qq)                                                                                                  | untouched; README documents the single-key rotation consequence (sessions die at the exp bound)                                                                              |
| `removeAdditional` 400-flip (Plan B lineage)                                                                                            | untouched; status quo strips                                                                                                                                                 |
| `nightshift-client` npm publish + the extensionless `bin/nightshift` exec form (exec-bit/shebang + Windows story ride the publish wave) | module stays in-repo (D-kk/D-bbb); repo shim + `pnpm cli` are the tonight forms                                                                                              |
| home-ops side: image digest pinning, registry push, the HelmRelease itself                                                              | repo ships the artifacts + README; HelmRelease lives outside this repo (ticket literal)                                                                                      |

---

## Decision records (Plan F — D-aaa … D-eee; triple letters, see the provenance note; `D-uu` stays dead)

**D-aaa — The CLI contract (closes the D-oo→D-yy→F chain): `nightshift next|claim|report` rides the D-kk typed client over EXISTING ops only; zero new runtime deps; zero server-contract change; a pinned exit ladder is the machine interface.** Why: ticket #11 literal — "No server contract change should be needed"; §11 — agents branch on `code`, never parse prose; D-kk — the drift-pinned client is the ONLY door (hand-rolled fetch would fork contract truth; the MCP 35-tool surface is frozen and the CLI rides REST, the parity harness already pins MCP⇄REST). **Surface:** `next [--label L] [--limit N]` → GET `/tasks/next` → the server's Task DTO as JSONL (one compact JSON line per ready leaf; `jq`-composable; empty output + exit 0 when none ready); `claim <task-id>` → POST `/tasks/{id}/claim` → `{task_id, lease_token, generation}` (lease_token IS the claim-issued capability — stdout by design: the agent's own pipe, the server stores only its hash; it never appears in argv anywhere in the product). `report <task-id> [--message M] [--status S --reason R]` → `--message` posts a `kind:'note'` thread (kind `question` is DELIBERATELY not exposed — it opens a review gate; the CLI reports, humans decide); `--status` PATCHes `/tasks/{id}/status` with `reason` and the `lease_token` from `NS_LEASE_TOKEN` env (claim's output, env for transport — D-ff lineage: capabilities never in argv, same posture as every credential); order message-then-status; status-arm stdout = the server's Task DTO (truth), message-only arm = `{task_id, message_id}`; **partial success is honest** — there is no cross-request transaction, a note can land and the status move can still 412 (the exit + code record exactly that, and the note is on the audit-visible spine). **Local mirrors of the server gates** (fail cheap, NOTHING sent, exit 2): `--limit` int 1..100 (the yaml `/tasks/next` pin), `--status` ∈ `TASK_STATUSES` imported from `#root/domain/task` (the SINGLE truth — zero enum duplication, the taxonomy pin already marries it to the yaml), `--status` without `--reason` rejected (the server requires reason — invariant 3 lineage). **Env** via zod (already-shipped dep): `NS_URL` (url), `NS_TOKEN` (min 1), `NS_LEASE_TOKEN` optional, `NS_TIMEOUT_MS` int ≥100 default **15000** applied as `AbortSignal.timeout` per call (a dead server dies in 15 s, not forever — the only knob; no keepalive/retry inventing, §12 keeps those). **Exit ladder + machine strings (pinned, grep-stable, invented HERE and living ONLY CLI-side):** `0` success · `1` `nightshift: transport_error` (socket death, timeout, or a non-problem body — a garbage 2xx is a transport failure against the contract, honest by ruling) · `2` `nightshift: usage_error <why>` / `nightshift: config_error <why>` (nothing sent; error text never echoes secret VALUES, zod treeify lists paths+expectations only — a test proves it) · `3` `nightshift: <server code>` with the flat problem JSON verbatim on line 2 (D-jj envelope: `already_claimed` carries `holder_handle`/`holder_display_name` through unchanged). The taxonomy gains NOTHING: zero new `DomainErrorCode`, zero yaml change — the CLI's three strings are stderr strings, not contract codes. **DI surface:** `runCli({argv, env, stdout, stderr, fetch}) → Promise<number>` — `fetch` is REQUIRED (runCli never reads `globalThis.fetch`; the shim injects it), zero `process` reads, so every arm including the transport legs is testable through the zero-socket inject harness; the exit-code ladder is the API, `bin/` is the only entry point.

**D-bbb — Bin shape: a repo `bin/nightshift.mjs` shim + the `package.json` `bin` map — NOT an npm entry; logic lives in `src/cli/` where the gates bite.** The `nightshift-client` publish stays QUEUED (HUMAN, D-kk unchanged) and the module stays in-repo, so the npm-package `bin` story would be publishing shape nobody can consume yet; the repo-bin ships today and rides the image (D-ccc). `#root/cli/run` resolves through the package `imports` map — `dist/` after `pnpm build` (the runtime form in the image), `src/` with `--conditions=development` for dev/tests (the `dev`/`start:dev` precedent, verbatim); repo invocation: `node bin/nightshift.mjs` (built) or the new `pnpm cli <args>` dev script (`NODE_OPTIONS=--conditions=development tsx bin/nightshift.mjs` — the exact prefix `start:dev` uses); the extensionless `bin/nightshift` form (exec-bit/shebang resolution, Windows) rides the publish wave — QUEUED. The shim is five honest lines (argv/env/stdout/stderr/fetch → runCli; result → `process.exitCode`) — all logic in `src/cli/run.ts` where tsc/eslint/vitest/coverage actually apply; `bin/` itself is invisible to the unit gates, so it is pinned by BEHAVIOR: a spawned smoke test runs the shim exactly as the dev path does (`node --import tsx` + development condition — probe P3) and checks the exit codes cross the process boundary, plus a shape-pin of the shim file (shebang + `#root/cli/run` + `process.exitCode`). The image ships `bin/` + `dist/` so the same CLI is reachable inside the container (operator `docker exec` / future agent-on-box use) — stated, zero cost.

**D-ccc — Asset-layout ruling (the ticket's required decision): KEEP the cwd-relative story; WORKDIR `/app` makes it absolute and provable — no `import.meta.url` rework.** `/openapi.yaml` reads `join(process.cwd(),'openapi','openapi.yaml')` (`app.ts:47-50`) and `/ui` reads `join(process.cwd(),'adapters','sveltekit','build')` (`ui.ts:12`) — E's D-vv stated shipping stays F, and Plan A's backlog note ("`openapi/` is not in tsc output — docker build will need an asset-shipping step") lands here. Ruled against the rework, honestly: (1) `dist/` file-relative resolution would need `../openapi/` + `../adapters/...` — a SECOND path story with its own failure modes — while WORKDIR makes cwd a boot-time constant the whole suite already uses (tests, dev, e2e all run from repo root: one cwd contract, zero forks); (2) the rework edits `app.ts`/`ui.ts` — surfaces E pinned byte-untouched with byte-exact test arms (U-pins, drift sets) — for zero runtime difference; (3) the E2E/`mountUi` skip-with-warning behavior (build absent ⇒ boot survives) keeps its meaning: the image ALWAYS ships the build (the build stage produced it), and a missing-build boot stays the pinned dev posture. **Image contract (the ruling's evidence — Task 5's probes, not prose):** WORKDIR `/app` owned by root, mode-755, containing `dist/`, `openapi/openapi.yaml`, `adapters/sveltekit/build/`, `bin/`, `package.json` (the `#root/*` imports map is runtime infrastructure); `USER node` (uid 1000, the node:24 image's built-in — no custom user invented), so the only writable app-side path is the volume: `ENV NS_DB_PATH=/data/nightshift.db NS_DATA_DIR=/data` — **ONE volume** at `/data` covering the SQLite **WAL family** (db + `-wal`/`-shm` sidecars live beside it — single-writer: NEVER schedule two containers on one volume; README says so in caps) and the content-addressed uploads. `VOLUME /data` is deliberately NOT declared (anonymous-volume surprise; home-ops mounts explicitly). The smoke proves the layout by BYTE-MATCHING served `/openapi.yaml` against the repo artifact and 200ing the `/ui` shell — cwd-relative, proven, not assumed.

**D-ddd — Image shape: three stages from the SAME `node:24-bookworm-slim` tag (one libc, one ABI, digest-pin at deploy time); `better-sqlite3@13` compiles OUT of the runtime layer; `ui:offline-check` is an image BUILD gate; zero new image dependencies.** Stage `build` = full workspace install (`--frozen-lockfile`, `onlyBuiltDependencies {esbuild, better-sqlite3}` untouched) → `pnpm build && pnpm ui:build && pnpm ui:offline-check` — the offline guard REDS the image exactly as it REDS the repo gate (a shell suddenly phoning a CDN cannot ship; ticket #11 literal). Stage `proddeps` = same base + toolchain, manifests ONLY (D-kk workspace rule holds — the ui manifest is needed for the workspace protocol; the ui has zero runtime deps so the prod tree is exactly the root's eight) → `pnpm install --prod --frozen-lockfile` (preflight P4). Stage `runtime` = bare `node:24-bookworm-slim`: COPY prod `node_modules` (+ the ui workspace stub), `dist/`, `openapi/`, the built UI, `bin/`, `package.json` — **no apt packages ship in the runtime layer** (no curl: `HEALTHCHECK` is `node -e "fetch(.../ping)"` — zero-dep posture to the last byte; probe P5 pins the quoting). `EXPOSE 3123` (config default), `ENTRYPOINT ["node","dist/index.js"]` (= the `start` script verbatim), `USER node`, graceful stop = `src/index.ts`'s existing SIGTERM drain (Task 5 measures `docker stop` exit code — honest record, no signal-handling changes). `NODE_ENV=production`. The build toolchain (`python3 make g++` for better-sqlite3's node-gyp arm — prebuild fast-path recorded by probe P6 either way; `corepack enable` for the packageManager pnpm@10.33.0 pin) exists in exactly the two build stages and never in runtime. `.dockerignore` keeps the context honest AND safe: `node_modules`, `dist`, `coverage`, `.git`, **`.env*` (secrets never bake)**, `*.db*` + `data/` (no local state in the image), `playwright-report`, `test-results`, `.slim`, `adapters/sveltekit/build` + `.svelte-kit` (the image builds its OWN UI — local builds never smuggle). Registry: `nightshift:local` for the smoke; push/registry + HelmRelease stay home-ops (QUEUED).

**D-eee — Deploy posture: the repo ships artifacts + probes, the homelab owns the release; §14 runs live as a checklist split into AUTOMATED (non-interactive, zero-secret-in-repo) and OPERATOR (real Pocket ID, browser) legs, with the FTS5 declared-not-pinned arms checked on a COPY of the volume db — honest about both.** The HelmRelease lives in home-ops (ticket literal — nothing here touches it). The repo ships: `deploy/README.md` — the full `NS_*` surface as a table transcribed from `src/main/config.ts:3-56` (defaults + the fail-closed matrix + the OIDC-dormant rule verbatim from D-pp including the `INTERNAL_APP_URL` jwks/token rewrite caveat and the session-key rotation consequence), the volume/WAL/one-container rule, the bootstrap-token first boot, the CLI usage + exit-ladder table, quickstart, backup/restore note (copy THREE db files or none — WAL); `scripts/deploy-smoke.mjs` — dependency-free node 24 (the `ui-offline-check.mjs` precedent: `scripts/` invisible to the unit gates, its gate is RUNNING it): `/ping`, `/openapi.yaml` sha256-matches this checkout (the D-ccc proof), `/ui` shell html+no-cache, hashed `/ui/_app/*.js` immutable, SPA deep-link, `GET /tasks` 401, `POST /mcp` 401 (D-ww), then the agent-token lifecycle on the live contract (admin bootstrap token ⇒ create agent + token ⇒ agent creates a ready `deploy-smoke` task ⇒ claim ⇒ upload+download an attachment (the volume round-trip) ⇒ note thread ⇒ lease-gated status ⇒ event feed ascending ⇒ agent release ⇒ admin cancel (intentional audit-visible residue, stated) ⇒ revoke token) — one PASS/FAIL line per probe, exit 0 all-PASS / 1 any-FAIL / 2 usage; secrets env-only; no interactive/browser leg in it. `deploy/DEPLOY-SMOKE.md` — the numbered checklist: 1 container posture + healthcheck (operator on the homelab; the LOCAL twin is Task 5's gate), 2 `scripts/deploy-smoke.mjs`, 3 the CLI against the real instance, 4 REAL Pocket ID: register `nightshift` (redirect `{NS_PUBLIC_URL}/auth/callback`), the P-pp caveat check (curl the discovery doc's `jwks_uri`/`token_endpoint` hosts from the nightshift container — they must be REACHABLE; `INTERNAL_APP_URL` rewrites them to an IdP-only host), browser login, **nonce-echo verify-once** (Fosite-conformant but unconfirmed in Pocket ID — the honest checkbox), 5 first-login allow-list round-trip (policy `off` deny ⇒ allow-list ⇒ `member` provisioned, then promote to admin + revoke the bootstrap token), 6 the **FTS5 arms** on a stopped-copy (`task_fts` is the real table, `migrations.ts:238`): MATCH `'deploy-smoke'` ≥1 (in-migration rebuild data-carry) AND delete-one-`tasks`-row drops `task_fts` count by 1 (the `task_fts_ad` trigger; no delete path exists in code — declared-not-pinned since Plan C, explicitly F's deploy-time job), 7 the §14 human story end-to-end (two humans, claim race — two concurrent `nightshift claim`, one 200 one exit-3 `already_claimed` — split, question gate, PR link, human close, audit reconstruction), 8 record the run (PR/issue comment — "what ran vs what the operator runs", the D-xx bar). Task 5 runs the LOCAL twin of legs 1–3 + 6 (image + local container + copied volume db — zero secrets, zero real IdP) so tonight's honest claim is: automated legs green locally; OIDC/browser legs operator-at-home.

---

## Backlog disposition (ticket #11 scope table → tasks)

| Ticket item                                                                                                                                            | Where                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| 1. Multi-stage Docker image (UI build gate + single container + cwd/asset ruling + better-sqlite3 + non-root + HEALTHCHECK + single WAL/upload volume) | Task 5 (D-ccc/D-ddd); Task 1–4 ship the `src/cli/`+`bin/` the image copies                        |
| 2. Homelab deploy artifacts + deploy-smoke checklist (env surface, Pocket ID caveat, FTS5 arms)                                                        | Task 6 (`scripts/deploy-smoke.mjs` + `deploy/DEPLOY-SMOKE.md`), Task 7 (`deploy/README.md`)       |
| 3. The CLI (D-yy slice — bin shape, zero-deps, credential posture, pinned exit codes/strings)                                                          | Tasks 1–4 (D-aaa/D-bbb); no server change needed — none made (proof: the zero-churn list)         |
| 4. §14 end-to-end on the real deployment as F's closing story                                                                                          | Task 6 checklist step 7 + final-gate honest posture (local twin ran; operator-at-home legs named) |
| 5. Slice-outs (SSE, search/undo, keepalive enforcement, capability scopes, §13)                                                                        | **Untouched — state frozen** per the ticket                                                       |

## File structure (created / modified / why)

**Create (production):** `src/cli/run.ts` (the D-aaa CLI core — DI-pure, exit-code-returning), `bin/nightshift.mjs` (the D-bbb shim), `Dockerfile` (D-ddd), `.dockerignore`.
**Create (deploy-side, gate-invisible by precedent):** `scripts/deploy-smoke.mjs` (D-eee automated probes), `scripts/fts-probe.mjs` (the FTS5 declared-not-pinned arms, copy-only), `deploy/README.md`, `deploy/DEPLOY-SMOKE.md`.
**Create (test-side):** `src/cli/cli.test.ts` (all CLI arms, colocated), `src/cli/shim.test.ts` (Task 4 spawn smoke + shape-pin), `src/testing/inject-fetch.ts` (the client.test.ts injectFetch extracted — reused by the CLI tests; behavior byte-identical).
**Modify:** `package.json` (ONLY: `"bin"` map + the `cli` dev script — no dep changes, lockfile untouched), `src/client/client.test.ts` (import the extracted `makeInjectFetch` instead of its inline copy — test-side DRY, byte-behavior unchanged), this plan doc (amendments + final-gate record).
**Untouched (pinned):** `vitest.config.ts`, `lefthook.yaml`, `.github/workflows/ci.yaml`, `problem.ts`, `domain/errors.ts`, `src/domain/**` (TASK_STATUSES is IMPORTED, never edited), the whole `src/adapters/**`+`src/application/**`+`src/infra/**`+`src/main/**` tree + `src/index.ts` (F adds zero server code — the zero-churn proof in Task 8 lists the empty diff), `openapi/openapi.yaml`, `src/client/schema.d.ts`, `mount.test.ts`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, the spec, all Plan A–E records.

---

## Task 1: CLI core — exit ladder, config gates, `next` over the D-kk client

**Files:**

- Create: `src/testing/inject-fetch.ts`, `src/cli/run.ts`, `src/cli/cli.test.ts`
- Modify: `src/client/client.test.ts` (import the extracted inject-fetch helper — behavior byte-identical)

Context for the implementer: this is the D-aaa contract's first landing — the file below ships ONLY `next`; `COMMANDS` and the dispatch chain grow in lockstep in Tasks 2/3 (E-style growth, every intermediate file fully arm-covered — the P10 duty). `src/testing/**` placement is the coverage-exclusion decision (D-aaa). The server tree receives ZERO edits in all of F.

- [ ] **Step 1: Extract the inject-fetch harness into `src/testing/inject-fetch.ts`**

```ts
// src/testing/inject-fetch.ts — inject-backed fetch for the client/CLI test harnesses:
// zero sockets, the FULL hook chain (auth/idempotency/rate-limit ride a real Request).
// Plan F extraction of client.test.ts's inline injectFetch — behavior byte-identical,
// reused by the CLI tests (D-aaa DI); lives under src/testing/** (coverage-excluded).
import type { FastifyInstance } from 'fastify'

export const makeInjectFetch = (getApp: () => FastifyInstance): typeof globalThis.fetch => {
  return async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const res = await getApp().inject({
      method: request.method as 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(request.headers),
      ...(request.body === null ? {} : { body: Buffer.from(await request.arrayBuffer()) }),
    })
    return new Response(new Uint8Array(res.rawPayload), {
      status: res.statusCode,
      headers: Object.fromEntries(
        Object.entries(res.headers).flatMap(([k, v]) =>
          v === undefined ? [] : [[k, Array.isArray(v) ? v.join(', ') : String(v)]]
        )
      ),
    })
  }
}
```

In `src/client/client.test.ts`: delete the inline `injectFetch` const and replace it with `const injectFetch = makeInjectFetch(() => CURRENT.app)` (module level, `CURRENT` stays the existing `let`; the accessor is `.app` — B4 fix: `CURRENT` is the TestApp, the getter must yield the FastifyInstance) plus the import `import { makeInjectFetch } from '#root/testing/inject-fetch'`. Run `pnpm test src/client/client.test.ts` → GREEN immediately — this is a test-only extraction, **no RED phase to claim and none is claimed**.

- [ ] **Step 2: Write the failing tests (`src/cli/cli.test.ts`)**

```ts
// src/cli/cli.test.ts — the D-aaa exit ladder + machine strings, pinned against the real
// app (inject harness, zero sockets) and stub fetches for the transport legs.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCli, type CliIo } from '#root/cli/run'
import { makeInjectFetch } from '#root/testing/inject-fetch'
import { makeTestApp } from '#root/testing/test-app'

let CURRENT: Awaited<ReturnType<typeof makeTestApp>>
beforeEach(async () => {
  CURRENT = await makeTestApp()
})
afterEach(async () => {
  await CURRENT.close()
})

// the DI door (D-aaa): argv+env in, exit code + captured stdout/stderr out
const run = async (
  argv: string[],
  env: Record<string, string> = {},
  fetch: typeof globalThis.fetch = makeInjectFetch(() => CURRENT.app)
) => {
  const out: string[] = []
  const err: string[] = []
  const io: CliIo = {
    argv,
    env: { NS_URL: 'http://nightshift.test', NS_TOKEN: CURRENT.adminToken, ...env },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    fetch,
  }
  return { code: await runCli(io), out, err }
}
const stubFetch = (impl: (...args: never[]) => Promise<Response>): typeof globalThis.fetch =>
  impl as unknown as typeof globalThis.fetch
const createTask = async (title: string, extra: Record<string, unknown> = {}) => {
  const res = await CURRENT.app.inject({
    method: 'POST',
    url: '/tasks',
    headers: { authorization: `Bearer ${CURRENT.adminToken}`, 'content-type': 'application/json' },
    payload: { title, status: 'todo', ...extra },
  })
  return JSON.parse(res.payload) as { id: string }
}

describe('cli run-core (D-aaa)', () => {
  it('help exits 0 with the usage contract in both spellings', async () => {
    for (const argv of [['--help'], ['help']]) {
      const r = await run(argv)
      expect(r.code).toBe(0)
      expect(r.out).toEqual([])
      expect(r.err.join('\n')).toMatch(/nightshift next/)
      expect(r.err.join('\n')).toMatch(
        /exit: 0 ok · 1 transport_error · 2 usage\/config \(nothing sent\) · 3 API problem/
      )
    }
  })
  it('unknown command and bare argv are usage_error exit 2 (nothing sent)', async () => {
    expect((await run([])).err[0]).toBe("nightshift: usage_error unknown command ''")
    expect((await run([])).code).toBe(2)
    const r = await run(['wat'])
    expect(r.code).toBe(2)
    expect(r.err[0]).toBe("nightshift: usage_error unknown command 'wat'")
  })
  it('config errors exit 2, echo no secret VALUES', async () => {
    const badUrl = await run(['next'], { NS_URL: 'not-a-url', NS_TOKEN: 'sekret-token-9' })
    expect(badUrl.code).toBe(2)
    expect(badUrl.err[0]).toMatch(/^nightshift: config_error/)
    expect(badUrl.err.join('')).not.toMatch(/sekret-token-9/)
    expect((await run(['next'], { NS_TOKEN: '' })).code).toBe(2) // min(1) leg
    expect((await run(['next'], { NS_TIMEOUT_MS: '10' })).code).toBe(2) // min(100) leg
  })
  it('--limit mirrors the SERVER pin locally (1..100 int), fail-cheap exit 2', async () => {
    for (const bad of ['abc', '0', '101']) {
      const r = await run(['next', '--limit', bad])
      expect(r.code).toBe(2)
      expect(r.err[0]).toMatch(/^nightshift: config_error --limit/)
    }
    expect((await run(['next', '--limit', '2'])).code).toBe(0)
  })
  it('flag-shape errors: missing value, flag-as-value, unknown flag, stray positional', async () => {
    expect((await run(['next', '--label'])).err[0]).toBe(
      'nightshift: usage_error flag --label needs a value'
    )
    expect((await run(['next', '--label', '--limit', '2'])).code).toBe(2)
    expect((await run(['next', '--bogus', 'x'])).err[0]).toBe(
      "nightshift: usage_error unknown flag --bogus for 'next'"
    )
    expect((await run(['next', 't_stray'])).err[0]).toBe(
      "nightshift: usage_error 'next' takes no positional arguments"
    )
  })
  it('next prints the server DTOs as JSONL — empty output when nothing is ready', async () => {
    const empty = await run(['next'])
    expect(empty.code).toBe(0)
    expect(empty.out).toEqual([])
    const a = await createTask('ready a')
    const b = await createTask('ready b')
    const r = await run(['next'])
    expect(r.code).toBe(0)
    expect(r.out.length).toBe(2)
    expect(JSON.parse(r.out[0]).id).toBe(a.id) // server FIFO order preserved, no CLI reshaping
    expect(JSON.parse(r.out[1]).id).toBe(b.id)
    expect(JSON.parse(r.out[0]).status).toBe('todo')
  })
  it('next forwards --label and --limit to the server query', async () => {
    await createTask('labeled', { labels: ['front'] })
    await createTask('bare')
    const labeled = await run(['next', '--label', 'front'])
    expect(labeled.out.length).toBe(1)
    expect(JSON.parse(labeled.out[0]).title).toBe('labeled')
    expect((await run(['next', '--limit', '1'])).out.length).toBe(1)
  })
  it('an API problem exits 3: taxonomy code line 1, flat D-jj envelope line 2', async () => {
    const r = await run(['next'], { NS_TOKEN: 'wrong-token' })
    expect(r.code).toBe(3)
    expect(r.err[0]).toBe('nightshift: unauthenticated')
    expect(JSON.parse(r.err[1])).toMatchObject({ code: 'unauthenticated', status: 401 })
  })
  it('garbage responses are transport_error exit 1 — the ladder, not the library (P7)', async () => {
    const text502 = stubFetch(async () => new Response('not json at all', { status: 502 }))
    expect((await run(['next'], {}, text502)).err[0]).toBe('nightshift: transport_error')
    expect((await run(['next'], {}, text502)).code).toBe(1)
    const empty200 = stubFetch(async () => new Response('', { status: 200 }))
    expect((await run(['next'], {}, empty200)).code).toBe(1)
    const codedLess = stubFetch(
      async () =>
        new Response(JSON.stringify({ message: 'gateway shrug' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        })
    )
    expect((await run(['next'], {}, codedLess)).err[0]).toBe('nightshift: transport_error')
  })
  it('a dead socket, a thrown string and the NS_TIMEOUT_MS abort all exit 1', async () => {
    const boom = stubFetch(async () => {
      throw new Error('socket died')
    })
    const r = await run(['next'], {}, boom)
    expect(r.code).toBe(1)
    expect(r.err).toEqual(['nightshift: transport_error', 'Error: socket died'])
    const strung = stubFetch(async () => {
      throw 'plain-string-failure'
    })
    expect((await run(['next'], {}, strung)).err[1]).toBe('plain-string-failure')
    // the timeout seam: init.signal is the AbortSignal.timeout — honour it, never resolve
    const hang = stubFetch(
      (_input: never, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init?.signal?.reason))
        })
    )
    const t0 = Date.now()
    const timed = await run(['next'], { NS_TIMEOUT_MS: '100' }, hang)
    expect(timed.code).toBe(1)
    expect(timed.err[0]).toBe('nightshift: transport_error')
    expect(Date.now() - t0).toBeLessThan(5_000) // deterministic abort, not a hang
  })
})
```

- [ ] **Step 3: Run to verify RED**: `pnpm test src/cli/cli.test.ts` → FAIL (`Cannot find module '#root/cli/run'` — honest RED: module-missing; the step-2 suite is designed against the D-aaa contract, not against existing code).

- [ ] **Step 4: Implement `src/cli/run.ts`** (D-aaa; `next` only — the exact-set grows in Tasks 2/3):

```ts
// src/cli/run.ts — the nightshift CLI core (D-aaa): argv+env+io+fetch in, exit code out.
// Zero new runtime deps (zod + the D-kk client, both already shipped); ZERO server-contract
// change — every arm rides EXISTING documented ops (Task 8's zero-churn list is the proof).
// stderr line 1 is the machine string `nightshift: <token>`; the exit ladder is pinned and
// grep-stable (spec §11 — agents branch on the code, never parse prose):
//   0 ok · 1 transport_error · 2 usage_error/config_error (NOTHING sent) · 3 API problem
// (the server's taxonomy code verbatim; the flat D-jj problem JSON rides on line 2).
import { z } from 'zod'
import { createNightshiftClient } from '#root/client/index'

export interface CliIo {
  argv: readonly string[]
  env: NodeJS.ProcessEnv
  stdout: (line: string) => void
  stderr: (line: string) => void
  // REQUIRED (D-aaa): runCli never reads globalThis.fetch — the caller injects it
  // (the bin shim passes the platform; the tests inject the zero-socket harness).
  fetch: typeof globalThis.fetch
}

const EnvSchema = z.object({
  NS_URL: z.url(),
  NS_TOKEN: z.string().min(1),
  NS_TIMEOUT_MS: z.coerce.number().int().min(100).default(15_000), // per-call AbortSignal
})

// the command surface, one exact set (D-aaa): COMMANDS keys and the dispatch chain ship in
// lockstep — claim (Task 2) and report (Task 3) join BOTH, never one alone
const COMMANDS: Record<string, readonly string[]> = {
  next: ['label', 'limit'],
}

const LimitSchema = z.coerce.number().int().min(1).max(100) // mirrors the yaml /tasks/next pin

const USAGE = [
  'usage: nightshift next [--label L] [--limit N] | claim <task-id> | report <task-id> [--message M] [--status S --reason R]',
  'env: NS_URL + NS_TOKEN required · NS_LEASE_TOKEN for --status · NS_TIMEOUT_MS default 15000 (secrets via env, never argv — D-ff)',
  'exit: 0 ok · 1 transport_error · 2 usage/config (nothing sent) · 3 API problem (`nightshift: <code>` on stderr)',
]

interface ParsedArgs {
  positionals: string[]
  flags: Record<string, string>
}

// ParsedArgs or a one-line usage reason (string): a trailing `--flag` or `--flag --other`
// is a MISSING value, never a value starting with --.
const parseArgs = (args: readonly string[]): ParsedArgs | string => {
  const positionals: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('--')) {
      positionals.push(a)
      continue
    }
    const value = args[i + 1]
    if (value === undefined || value.startsWith('--')) return `flag ${a} needs a value`
    flags[a.slice(2)] = value
    i++
  }
  return { positionals, flags }
}

// the D-jj door: a problem with a string code → exit 3 + the flat envelope verbatim;
// anything else (garbage body, empty 2xx) is a transport failure against the contract
// → exit 1 (D-aaa). null = data present, the caller proceeds.
const failFrom = (io: CliIo, r: { data?: unknown; error?: unknown }): number | null => {
  if (r.data !== undefined) return null
  const err = r.error as { code?: unknown } | undefined
  if (typeof err?.code === 'string') {
    io.stderr(`nightshift: ${err.code}`)
    io.stderr(JSON.stringify(err))
    return 3
  }
  io.stderr('nightshift: transport_error')
  io.stderr(
    typeof err === 'string'
      ? err
      : JSON.stringify(err ?? 'empty response — no data, no problem body')
  )
  return 1
}

export const runCli = async (io: CliIo): Promise<number> => {
  const usageError = (why: string): number => {
    io.stderr(`nightshift: usage_error ${why}`)
    USAGE.forEach((line) => io.stderr(line))
    return 2
  }
  const [cmd = '', ...rest] = io.argv
  if (cmd === 'help' || cmd === '--help') {
    USAGE.forEach((line) => io.stderr(line))
    return 0
  }
  if (!Object.hasOwn(COMMANDS, cmd)) return usageError(`unknown command '${cmd}'`)
  const parsed = parseArgs(rest)
  if (typeof parsed === 'string') return usageError(parsed)
  for (const key of Object.keys(parsed.flags)) {
    if (!COMMANDS[cmd].includes(key)) return usageError(`unknown flag --${key} for '${cmd}'`)
  }
  if (parsed.positionals.length !== 0) return usageError(`'${cmd}' takes no positional arguments`)
  const env = EnvSchema.safeParse(io.env)
  if (!env.success) {
    io.stderr(
      'nightshift: config_error check NS_URL / NS_TOKEN / NS_TIMEOUT_MS (values never echoed)'
    )
    io.stderr(JSON.stringify(z.treeifyError(env.error)))
    return 2
  }
  let limit: number | undefined
  if (parsed.flags.limit !== undefined) {
    const r = LimitSchema.safeParse(parsed.flags.limit)
    if (!r.success) {
      io.stderr('nightshift: config_error --limit must be an integer 1..100 (the server pin)')
      return 2
    }
    limit = r.data
  }
  const label = parsed.flags.label
  const client = createNightshiftClient({
    baseUrl: env.data.NS_URL,
    token: env.data.NS_TOKEN,
    fetch: (input, init) =>
      io.fetch(input, { ...init, signal: AbortSignal.timeout(env.data.NS_TIMEOUT_MS) }),
  })
  try {
    // Task 1 ships the single command directly (COMMANDS === {next}); Task 2 grows the
    // dispatch chain with claim, Task 3 with report — exact set, lockstep.
    const r = await client.GET('/tasks/next', {
      params: {
        query: {
          ...(label === undefined ? {} : { label }),
          ...(limit === undefined ? {} : { limit }),
        },
      },
    })
    const f = failFrom(io, r)
    if (f !== null) return f
    // server DTO pass-through as JSONL (D-aaa) — the CLI never reshapes the contract.
    // Trust-cast (B5/P10): failFrom PROVED data present — a `?? []` right-arm would be
    // statically uncoverable and the never-lower bar forbids it.
    for (const task of r.data as unknown[]) io.stdout(JSON.stringify(task))
    return 0
  } catch (err) {
    io.stderr('nightshift: transport_error')
    io.stderr(err instanceof Error ? `${err.name}: ${err.message}` : String(err))
    return 1
  }
}
```

- [ ] **Step 5: Run to verify GREEN**: `pnpm test src/cli/cli.test.ts`, then full gates `pnpm test && pnpm lint && pnpm typecheck`.

- [ ] **Step 6: Commit** (explicit files; new files `git add`ed — bare `-am` skips them):

```bash
git add src/cli/run.ts src/cli/cli.test.ts src/testing/inject-fetch.ts src/client/client.test.ts
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(cli): run-core with pinned exit ladder + machine strings (D-aaa)"
```

## Task 2: `claim` — the lease, the race, and the flat-envelope pin

**Files:**

- Modify: `src/cli/run.ts`, `src/cli/cli.test.ts` (append a describe; the T1 file is the base)

- [ ] **Step 1: Write the failing tests (append to `src/cli/cli.test.ts`)** — the T1 helpers (`run`, `createTask`) are reused; an agent-token helper joins here:

```ts
// appended to src/cli/cli.test.ts — the §14 claim race through the CLI (P8 pin)
const agentToken = async (handle: string): Promise<string> => {
  const actor = await CURRENT.app.inject({
    method: 'POST',
    url: '/admin/actors',
    headers: { authorization: `Bearer ${CURRENT.adminToken}`, 'content-type': 'application/json' },
    payload: { kind: 'agent', handle, display_name: handle },
  })
  const tok = await CURRENT.app.inject({
    method: 'POST',
    url: `/admin/actors/${(JSON.parse(actor.payload) as { id: string }).id}/tokens`,
    headers: { authorization: `Bearer ${CURRENT.adminToken}`, 'content-type': 'application/json' },
    payload: { label: 'cli-test' },
  })
  return (JSON.parse(tok.payload) as { raw_token: string }).raw_token
}

describe('cli claim (D-aaa)', () => {
  it('claim prints {task_id, lease_token, generation} — the lease NEVER touches argv', async () => {
    const t = await createTask('claimable')
    const r = await run(['claim', t.id])
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.out[0]) as Record<string, unknown>
    expect(parsed.task_id).toBe(t.id)
    expect(typeof parsed.lease_token).toBe('string')
    expect(typeof parsed.generation).toBe('number')
  })
  it('the race loser exits 3 with `nightshift: already_claimed` + flat holder fields (P8)', async () => {
    const t = await createTask('contested')
    const winner = await run(['claim', t.id], { NS_TOKEN: await agentToken('a_winner') })
    expect(winner.code).toBe(0)
    const loser = await run(['claim', t.id], { NS_TOKEN: await agentToken('a_loser') })
    expect(loser.code).toBe(3)
    expect(loser.err[0]).toBe('nightshift: already_claimed')
    expect(JSON.parse(loser.err[1])).toMatchObject({
      code: 'already_claimed',
      status: 409,
      holder_handle: 'a_winner',
    })
  })
  it('ghost task → exit 3 not_found; claim arity is exact', async () => {
    expect((await run(['claim', 't_ghost'])).err[0]).toBe('nightshift: not_found')
    expect((await run(['claim'])).err[0]).toBe(
      "nightshift: usage_error 'claim' takes exactly one <task-id>"
    )
    expect((await run(['claim', 'a', 'b'])).code).toBe(2)
  })
  it('unknown flags die per-command: --label is a next-only flag', async () => {
    expect((await run(['claim', 't_x', '--label', 'nope'])).err[0]).toBe(
      "nightshift: usage_error unknown flag --label for 'claim'"
    )
  })
})
```

- [ ] **Step 2: Verify RED**: `pnpm test src/cli/cli.test.ts` → the claim describe FAILs (`unknown command 'claim'` exits 2), next suite stays green.

- [ ] **Step 3: Implement — grow the exact set in `src/cli/run.ts`**:

1. `COMMANDS` gains `claim: [],`.
2. Replace the no-positional gate with the arity-aware one:

```ts
const idWanted = cmd === 'claim'
if (parsed.positionals.length !== (idWanted ? 1 : 0)) {
  return usageError(
    idWanted ? `'${cmd}' takes exactly one <task-id>` : `'${cmd}' takes no positional arguments`
  )
}
```

3. Wrap the Task-1 dispatch (which already `return`s) into `if (cmd === 'next') { … }` and append the claim arm inside the same `try` — the exact set grows with the chain (D-aaa):

```ts
const id = parsed.positionals[0] as string // arity gate proved it
const claim = await client.POST('/tasks/{id}/claim', { params: { path: { id } } })
const f = failFrom(io, claim)
if (f !== null) return f
// trust-cast (D-aaa): failFrom proved data present
const d = claim.data as { lease_token?: string; generation?: number }
io.stdout(JSON.stringify({ task_id: id, lease_token: d.lease_token, generation: d.generation }))
return 0
```

(`next` becomes `if (cmd === 'next') { <T1 block unchanged> }` — every branch here is arm-covered by the two commands' tests; P10.)

- [ ] **Step 4: Gates + commit**:

```bash
git add src/cli/run.ts src/cli/cli.test.ts
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(cli): claim with lease stdout + already_claimed race pin (D-aaa)"
```

> **Amendment (Task 2, lint normalization on the claim-arm trust-cast):** One byte-sync note. The Step-3 fragment's first line shipped as `const id = parsed.positionals[0] // arity gate proved it` — the planned `as string` assertion was removed: `parsed.positionals` is `string[]` (no `noUncheckedIndexedAccess` in tsconfig — `strict: true` only), so the assertion does not change the type and `@typescript-eslint/no-unnecessary-type-assertion` REDS the lint gate (the preflight compiled the blocks with `tsc --noEmit`, where the cast is legal; eslint is the stricter gate). `id` is still exactly `string`; the comment's proof-duty stands; the rest of the block — and the Step-1 test block and the Step-3 arity-gate block — shipped byte-identical to the planned text (verified by uniform-dedent diff). Block sync = shipped form.

## Task 3: `report` — note thread + lease-gated status (NS_LEASE_TOKEN env)

**Files:**

- Modify: `src/cli/run.ts`, `src/cli/cli.test.ts`

- [ ] **Step 1: Write the failing tests (append)**:

```ts
// appended to src/cli/cli.test.ts — the report arms incl. the honest partial-state pin
// B1/S1 fix: the server serves ThreadWithMessages = { thread: {...}, messages: [...] }
// (ports.ts:288-291) — `kind` lives UNDER thread, `messages` is top-level.
const threads = async (
  id: string
): Promise<{ thread: { kind: string }; messages: { body: string }[] }[]> => {
  const res = await CURRENT.app.inject({
    method: 'GET',
    url: `/tasks/${id}/threads`,
    headers: { authorization: `Bearer ${CURRENT.adminToken}` },
  })
  return JSON.parse(res.payload) as { thread: { kind: string }; messages: { body: string }[] }[]
}
const claimAs = async (id: string, token: string): Promise<string> => {
  const r = await run(['claim', id], { NS_TOKEN: token })
  expect(r.code).toBe(0)
  return (JSON.parse(r.out[0]) as { lease_token: string }).lease_token
}

describe('cli report (D-aaa)', () => {
  it('--message posts a NOTE thread and prints {task_id, message_id}', async () => {
    const t = await createTask('reportable')
    const r = await run(['report', t.id, '--message', 'progress: wired the door'])
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.out[0]) as Record<string, unknown>
    expect(parsed.task_id).toBe(t.id)
    expect(typeof parsed.message_id).toBe('string')
    const list = await threads(t.id)
    expect(list[0]).toMatchObject({
      thread: { kind: 'note' },
      messages: [{ body: 'progress: wired the door' }],
    })
  })
  it('--status moves status under the env lease and prints the server Task DTO', async () => {
    const agent = await agentToken('a_reporter')
    const t = await createTask('movable')
    const lease = await claimAs(t.id, agent)
    const r = await run(['report', t.id, '--status', 'in_progress', '--reason', 'starting work'], {
      NS_TOKEN: agent,
      NS_LEASE_TOKEN: lease,
    })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out[0])).toMatchObject({ id: t.id, status: 'in_progress' })
  })
  it('an unclaimed task moves WITHOUT a lease (claim → release → move) — the lease-less arm (P9)', async () => {
    const agent = await agentToken('a_releaser')
    const t = await createTask('releasable')
    await claimAs(t.id, agent)
    const rel = await CURRENT.app.inject({
      method: 'POST',
      url: `/tasks/${t.id}/release`,
      headers: { authorization: `Bearer ${agent}` },
    })
    expect(rel.statusCode).toBe(200)
    const r = await run(['report', t.id, '--status', 'in_progress', '--reason', 'fresh start'], {
      NS_TOKEN: agent,
    })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out[0]).status).toBe('in_progress')
  })
  it('HONEST PARTIAL (D-aaa): the note lands, a wrong lease still exits 3 stale_lease', async () => {
    const agent = await agentToken('a_partial')
    const t = await createTask('partial')
    await claimAs(t.id, agent)
    const r = await run(
      [
        'report',
        t.id,
        '--message',
        'this note WILL land',
        '--status',
        'in_progress',
        '--reason',
        'x',
      ],
      { NS_TOKEN: agent, NS_LEASE_TOKEN: 'wrong-lease' }
    )
    expect(r.code).toBe(3)
    expect(r.err[0]).toBe('nightshift: stale_lease')
    const list = await threads(t.id) // the note is there — no cross-request transaction, honestly
    expect(list[0].messages[0].body).toBe('this note WILL land')
  })
  it('an agent may not close: --status done answers exit 3 agent_close_forbidden', async () => {
    const agent = await agentToken('a_closer')
    const t = await createTask('closable')
    const lease = await claimAs(t.id, agent)
    const r = await run(['report', t.id, '--status', 'done', '--reason', 'shipped'], {
      NS_TOKEN: agent,
      NS_LEASE_TOKEN: lease,
    })
    expect(r.code).toBe(3)
    expect(r.err[0]).toBe('nightshift: agent_close_forbidden')
  })
  it('local gates: needs message-or-status, status needs reason, status is the DOMAIN enum', async () => {
    expect((await run(['report', 't_x'])).err[0]).toBe(
      "nightshift: usage_error 'report' needs --message and/or --status"
    )
    expect((await run(['report', 't_x', '--status', 'in_progress'])).err[0]).toBe(
      'nightshift: usage_error --status requires --reason (the server invariant)'
    )
    const bad = await run(['report', 't_x', '--status', 'shipped', '--reason', 'x'])
    expect(bad.code).toBe(2)
    expect(bad.err[0]).toMatch(
      /^nightshift: config_error --status must be one of backlog\|todo\|in_progress\|in_review\|done\|canceled/
    )
    expect((await run(['report', 't_x', '--message'])).err[0]).toBe(
      'nightshift: usage_error flag --message needs a value'
    )
  })
})
```

- [ ] **Step 2: Verify RED** (unknown command 'report').

- [ ] **Step 3: Implement in `src/cli/run.ts`**:

1. Imports gain: `import { TASK_STATUSES, type TaskStatus } from '#root/domain/task'` (the SINGLE truth — zero enum duplication; the existing pin marries it to the yaml — D-aaa).
2. `EnvSchema` gains `NS_LEASE_TOKEN: z.string().min(1).optional(),` (comment: the claim-issued capability — env like every credential, NEVER argv, D-ff/D-aaa).
3. `COMMANDS` gains `report: ['message', 'status', 'reason'],`.
4. Gates after the unknown-flag loop (before the env parse):

```ts
if (cmd === 'report' && parsed.flags.message === undefined && parsed.flags.status === undefined) {
  return usageError("'report' needs --message and/or --status")
}
let status: TaskStatus | undefined
if (parsed.flags.status !== undefined) {
  if (parsed.flags.reason === undefined) {
    return usageError('--status requires --reason (the server invariant)')
  }
  const sv = StatusSchema.safeParse(parsed.flags.status)
  if (!sv.success) {
    io.stderr(`nightshift: config_error --status must be one of ${TASK_STATUSES.join('|')}`)
    return 2
  }
  status = sv.data
}
```

with `const StatusSchema = z.enum(TASK_STATUSES)` next to `LimitSchema`.

5. Dispatch chain (inside the same `try`): wrap T2's claim arm in `if (cmd === 'claim') { … }` and append report as the terminal arm (exact set, lockstep):

```ts
// report (D-aaa): note thread FIRST, then the lease-gated status move. There is no
// cross-request transaction — a landed note + a failed move is honest partial state,
// recorded by exit code + taxonomy code. kind 'question' is DELIBERATELY unexposed.
let messageId: string | undefined
if (parsed.flags.message !== undefined) {
  const note = await client.POST('/tasks/{id}/threads', {
    params: { path: { id } },
    body: { kind: 'note', body: parsed.flags.message },
  })
  const nf = failFrom(io, note)
  if (nf !== null) return nf
  messageId = (note.data as { message: { id: string } }).message.id // trust-cast: failFrom proved data
}
if (status !== undefined) {
  const moved = await client.PATCH('/tasks/{id}/status', {
    params: { path: { id } },
    body: {
      status,
      reason: parsed.flags.reason, // the gate above proved it present (n13: Record access is string — an `as string` cast is a typed no-op and eslint no-unnecessary-type-assertion REJECTS it; T2 amendment precedent)
      ...(env.data.NS_LEASE_TOKEN === undefined ? {} : { lease_token: env.data.NS_LEASE_TOKEN }),
    },
  })
  const mf = failFrom(io, moved)
  if (mf !== null) return mf
  io.stdout(JSON.stringify(moved.data)) // the server's Task DTO IS the truth (D-aaa)
  return 0
}
io.stdout(JSON.stringify({ task_id: id, message_id: messageId }))
return 0
```

(The `id` const from Task 2 moves ABOVE the command blocks — same arity gate serves claim and report; update the arity check: `const idWanted = cmd === 'claim' || cmd === 'report'`.)

- [ ] **Step 4: Gates + commit**:

```bash
git add src/cli/run.ts src/cli/cli.test.ts docs/superpowers/plans/2026-09-10-nightshift-plan-f-docker-deploy-cli.md
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(cli): report — note thread + lease-gated status (D-aaa)"
```

> **Amendment (Task 3, byte-sync — shipped divergences; the Step-1 test block and the Step-3 blocks above are sync = shipped form):**
>
> 1. **Prettier reflow — the claim `io.stdout` line.** Task 3 wraps the claim arm in `if (cmd === 'claim') { … }`, so the two-space-deeper indent pushes the single-line `io.stdout(JSON.stringify({ task_id: id, lease_token: d.lease_token, generation: d.generation }))` past printWidth 100. Shipped (JSON content byte-identical, Task-2 single line re-wrapped by prettier only):
>    ```ts
>    io.stdout(
>      JSON.stringify({ task_id: id, lease_token: d.lease_token, generation: d.generation })
>    )
>    ```
> 2. **Prettier reflow — the report lease-spread line.** The block's `...(env.data.NS_LEASE_TOKEN === undefined ? {} : { lease_token: env.data.NS_LEASE_TOKEN }),` at its dedented presentation indent exceeds 100 once nested inside the real `body: { … }` at the shipped depth. Shipped (tokens byte-identical):
>    ```ts
>    ...(env.data.NS_LEASE_TOKEN === undefined
>      ? {}
>      : { lease_token: env.data.NS_LEASE_TOKEN }),
>    ```
> 3. **Coverage-duty addition (never-lower P10; "prove it, not document it" — Plan D Task 6 Amendment (4) / Task 7 Amendment (5) precedent).** The verbatim Step-1 test block never makes the NOTE POST itself fail (the HONEST-PARTIAL pin lands the note then fails the status), so the message-leg `if (nf !== null) return nf` (`run.ts` line 194) sat uncovered and the global Statements axis dipped to **99.47 < the 99.49 floor**. One `it` was added inside `describe('cli report (D-aaa)')` — a ghost-task `--message` POST answers the taxonomy `not_found` 404, `failFrom` returns 3 on the note leg, and nothing prints (no `message_id` tail): `expect(r.code).toBe(3)` / `nightshift: not_found` / `expect(r.out).toEqual([])`. run.ts then ships 100×4 (FNF/FNH 7/7, LF/LH 100/100, BRF/BRH 74/74, zero `,0`); the never-lower axes hold. The block's other arms are unchanged — "message both sides, status both sides, lease both sides, note trust-cast path, partial-state path" all map to named tests: message-present (`--message posts a NOTE thread`, HONEST-PARTIAL), message-absent (`--status moves …`, P9 lease-less, `agent_close_forbidden`), note-leg `return nf` (the added ghost arm), note trust-cast + message-only tail (`--message posts a NOTE thread` → `{task_id, message_id}`), status-present/absent, `return mf` (HONEST-PARTIAL `stale_lease`, `agent_close_forbidden`), lease-defined vs lease-less (P9 claim→release→move).
> 4. **The Step-3.4 gate block ships at its own heading's position.** The block's Step-3.4 heading states "after the unknown-flag loop (**before the env parse**)"; the shipped `run.ts` places the report-needs gate, the `let status` declaration, the requires-`--reason` usage gate and the `StatusSchema` `config_error --status must be one of …` contiguously there. No test distinguishes it from an after-env-parse placement (all report value/usage pins carry a valid `NS_TOKEN`), so this is position lineage, not a behavior divergence. The n13 fix holds verbatim: `reason: parsed.flags.reason` carries NO cast (eslint `no-unnecessary-type-assertion` — Task-2 amendment precedent). `const id = parsed.positionals[0]` moved above the command blocks per the Step-3 note ("same arity gate serves claim and report"); the arity line is `cmd === 'claim' || cmd === 'report'`; the comment gained the parenthetical `(serves claim and report)` — comment-only, the code line byte-verbatim.
>
> **Gates:** `pnpm test` 670→671 passed / 87 files; `pnpm lint` clean; `pnpm typecheck` clean; prettier-clean; coverage A/B (stashed HEAD baseline 99.51 / 98.47 / 99.78 / 99.7 vs shipped 99.52 / 98.52 / 99.78 / 99.7) — every axis at-or-above both the Plan E record and the pre-Task-3 HEAD; `run.ts` 100×4. `TASK_STATUSES`/`TaskStatus` are IMPORTED from `#root/domain/task` — the domain tree is byte-untouched.

## Task 4: The bin shim + package wiring (D-bbb) — spawned, not assumed

**Files:**

- Create: `bin/nightshift.mjs`, `src/cli/shim.test.ts`
- Modify: `package.json` (`"bin"` map + the `cli` dev script — nothing else)

- [ ] **Step 1: Write the failing spawn test (`src/cli/shim.test.ts`)**:

```ts
// src/cli/shim.test.ts — the D-bbb bin pin: the spawn path IS the dev/runtime story.
// NODE_OPTIONS=--conditions=development + the tsx loader resolve #root/cli/run through
// the package imports map (the start:dev precedent); the exit ladder must cross the
// PROCESS boundary, and the shim stays a five-line honest transport with no logic.
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const spawnShim = (argv: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ['--import', 'tsx', 'bin/nightshift.mjs', ...argv], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '--conditions=development', ...env },
  })

describe('bin shim (D-bbb)', () => {
  it('the shim stays honest: shebang, one #root import, exitCode wiring — no logic', () => {
    const src = readFileSync('bin/nightshift.mjs', 'utf8')
    expect(src.startsWith('#!/usr/bin/env node')).toBe(true)
    expect(src).toContain("from '#root/cli/run'")
    expect(src).toContain('process.exitCode = await runCli(')
    expect(src).toContain('fetch: globalThis.fetch') // the ONLY globalThis.fetch site (D-aaa)
  })
  it('--help exits 0 with the usage contract and NO env', () => {
    const r = spawnShim(['--help'])
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('nightshift next')
  })
  it('config and usage errors cross the process boundary with the pinned codes', () => {
    const cfg = spawnShim(['next'], { NS_URL: '', NS_TOKEN: 't' })
    expect(cfg.status).toBe(2)
    expect(cfg.stderr).toContain('nightshift: config_error')
    const usage = spawnShim(['wat'], { NS_URL: 'http://x.test', NS_TOKEN: 't' })
    expect(usage.status).toBe(2)
    expect(usage.stderr).toContain('nightshift: usage_error')
  })
})
```

- [ ] **Step 2: Verify RED**: `pnpm test src/cli/shim.test.ts` → the spawn tests FAIL (`MODULE_NOT_FOUND`/nonexistent file); the shape-pin FAILs on the missing file.

- [ ] **Step 3: Create `bin/nightshift.mjs`** (the ONLY site reading `process`/`globalThis.fetch` — D-aaa/D-bbb):

```js
#!/usr/bin/env node
// nightshift CLI shim (D-bbb): five honest lines — the repo-bin resolves #root/cli/run
// through the package imports map: dist/ after `pnpm build` (the image ships this form),
// src/ under --conditions=development (the `pnpm cli` dev path — shim.test.ts spawns it).
import { runCli } from '#root/cli/run'

process.exitCode = await runCli({
  argv: process.argv.slice(2),
  env: process.env,
  stdout: (line) => void process.stdout.write(line + '\n'),
  stderr: (line) => void process.stderr.write(line + '\n'),
  fetch: globalThis.fetch,
})
```

- [ ] **Step 4: Wire `package.json`** — add after `"main": "dist/index.js",`:

```json
  "bin": { "nightshift": "bin/nightshift.mjs" },
```

and into `scripts` (after `start:dev` — same NODE_OPTIONS precedent):

```json
    "cli": "NODE_OPTIONS=--conditions=development tsx bin/nightshift.mjs",
```

Verify the dev path once by hand: `pnpm cli --help` → exit 0, usage on stderr (record the exit code honestly in the amendment if it differs). No dependency changes anywhere.

- [ ] **Step 5: Gates + commit**:

```bash
git add bin/nightshift.mjs src/cli/shim.test.ts package.json
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(cli): repo-bin shim + pnpm cli dev path, spawned pins (D-bbb)"
```

> **Preflight obligations this task cannot dodge (P3):** the exact spawn mechanism (`node --import tsx` + dev condition) MUST be run by the preflight lane before dispatch — a silently-unresolvable `#root` specifier under tsx is precisely E's silent-ignore failure class.

> **Amendment (Task 4, byte-sync — one prettier reflow; the Step-1 test block and the Step-3 shim block are sync = shipped form, verified byte-verbatim by uniform-dedent diff — zero divergence, none claimed):**
>
> 1. **Prettier reflow — the `package.json` `bin` line.** The plan's compact one-liner `  "bin": { "nightshift": "bin/nightshift.mjs" },`, is expanded by prettier (object literal on one line is not prettier's style); pre-commit runs prettier, so the shipped bytes are:
>    ```json
>    "bin": {
>      "nightshift": "bin/nightshift.mjs"
>    },
>    ```
>    Key and value byte-identical; formatting-only (Task-3 reflow precedent). The `cli` script line shipped byte-identical to the plan block. `git diff package.json` at ship = exactly these two insertions (+4/−0), the sanctioned delta.
> 2. **Manual verifications, honest record.** `pnpm cli --help` → **exit 0**, the three USAGE lines on **stderr only** (stdout carries just pnpm's two-line script banner — the CLI itself prints nothing to stdout). `pnpm build` (exit 0) then `node bin/nightshift.mjs --help` → **exit 0**, stdout 0 bytes, the three USAGE lines on stderr — the dist-resolution arm the image ships resolves `#root/cli/run` → `dist/cli/run.js`. Both as expected; nothing to paper over.
> 3. **Gates:** `pnpm test` 671→**674 passed / 88 files**; `pnpm lint` 0 errors (the 3 warnings are pre-existing coverage-report artifacts, identical stashed-at-HEAD); `pnpm typecheck` clean; prettier-clean. Coverage **99.52 / 98.52 / 99.78 / 99.70** — byte-identical axes to the Task-3 record (shim is outside `src` → zero denominator churn), every axis ≥ floor (99.49 / 98.38 / 99.78 / 99.69); `run.ts` untouched and holds **BRF/BRH 74/74, FNF/FNH 7/7, LF/LH 100/100**. `pnpm-lock.yaml` byte-untouched (two package.json keys touch no resolutions).

## Task 5: The multi-stage Docker image + the container smoke that PROVES the rulings

**Files:**

- Create: `Dockerfile`, `.dockerignore`

- [ ] **Step 1: Write `.dockerignore`** (secrets and local state NEVER bake — D-ddd):

```
.git
.slim
.env*
node_modules
dist
coverage
*.db
*.db-wal
*.db-shm
/data
playwright-report
test-results
adapters/sveltekit/build
adapters/sveltekit/.svelte-kit
```

(The two `adapters/sveltekit` exclusions are deliberate: the image builds its OWN UI — a local build never smuggles in, and the in-image offline gate therefore proves the artifact from source.)

- [ ] **Step 2: Write `Dockerfile`** (D-ddd; the D-ccc layout is the RUNTIME section — the ruling's evidence):

```dockerfile
# Plan F — the single Docker image (spec §9). ONE base tag across the three stages:
# one glibc, one native ABI (operators pin @sha256 digests in home-ops).
FROM node:24-bookworm-slim AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable
# python3/make/g++ = better-sqlite3@13's node-gyp arm — deterministic either way (P6);
# they NEVER ship in the runtime layer.
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY adapters/sveltekit/package.json adapters/sveltekit/
RUN pnpm install --frozen-lockfile
COPY . .
# the D-ddd BUILD GATE: tsc + the SvelteKit static SPA + the offline guard as an image
# gate — a shell that suddenly phones a CDN REDS the image exactly as it REDS the repo.
RUN pnpm build && pnpm ui:build && pnpm ui:offline-check

FROM node:24-bookworm-slim AS proddeps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY adapters/sveltekit/package.json adapters/sveltekit/
# nightshift-ui has ZERO runtime deps — this tree is exactly the root's eight prod deps,
# with better-sqlite3's native build landing HERE (preflight P4 verified this resolves)
RUN pnpm install --prod --frozen-lockfile

# ---- the D-ccc layout ruling, as code: WORKDIR /app makes the repo-root-relative
# asset story (openapi/openapi.yaml + adapters/sveltekit/build from process.cwd())
# an absolute, provable image contract. No backend code moves; the app tree is
# root-owned 755 — the only writable path for the node user is the /data volume.
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=proddeps /app/node_modules ./node_modules
COPY --from=proddeps /app/adapters/sveltekit ./adapters/sveltekit
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY openapi ./openapi
COPY --from=build /app/adapters/sveltekit/build ./adapters/sveltekit/build
COPY bin ./bin
RUN mkdir -p /data && chown node:node /data
USER node
ENV NS_DB_PATH=/data/nightshift.db \
    NS_DATA_DIR=/data
EXPOSE 3123
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --start-interval=1s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.NS_PORT??3123)+'/ping').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["node", "dist/index.js"]
```

- [ ] **Step 3: Build the image** — `docker build -t nightshift:planf .` → exit 0; the log ends with the offline gate's own line (`ui build offline-safe; hosts seen: http://www.w3.org https://svelte.dev`) — record it VERBATIM (it is the gate running in the image, not in the repo). Record the BUILDER FORM used (S4: this box runs docker 29.7.2's LEGACY builder — no buildx; the Dockerfile is builder-agnostic by construction, no syntax directive, no cache mounts). Config-plane pin: `docker image inspect nightshift:planf --format '{{json .Config}}'` → record the pins: `User":"node"`, `Entrypoint":["node","dist/index.js"]`, Env contains `NS_DB_PATH=/data/nightshift.db` + `NS_DATA_DIR=/data`, `Healthcheck` present, `ExposedPorts` 3123/tcp.

- [ ] **Step 4: Boot + probe the container** (the D-ccc/D-ddd evidence — every arm machine-checked, no ad-hoc curls):

```bash
BOOT_TOKEN="planf-local-smoke-token-0123456789abcdef" # local smoke literal, never a real secret
docker volume create nightshift-smoke >/dev/null
docker run -d --name ns-f -p 127.0.0.1:3199:3123 -v nightshift-smoke:/data \
  -e NS_BOOTSTRAP_TOKEN="$BOOT_TOKEN" nightshift:planf
for i in $(seq 1 40); do [ "$(docker inspect -f '{{.State.Health.Status}}' ns-f)" = healthy ] && break; sleep 1; done
```

Expected `healthy` within ~5 s (P7's `--start-interval=1s`). Then the pinned arms:

```bash
curl -sf http://127.0.0.1:3199/ping                                   # {"pong":"it worked!"}
diff <(curl -sf http://127.0.0.1:3199/openapi.yaml) openapi/openapi.yaml  # the D-ccc proof: byte-identical
curl -sfI http://127.0.0.1:3199/ui/ | grep -qi 'content-type: text/html' # shell served from /app/adapters/sveltekit/build
curl -sf http://127.0.0.1:3199/ui/some/deep/link -o /dev/null -w '%{http_code}\n' # 200 — SPA fallback
docker exec ns-f sh -c 'ls /data'                                     # nightshift.db (+ WAL sidecars while running)
docker exec ns-f id -u                                               # 1000 — the node user
docker exec ns-f sh -c 'touch /app/x 2>/dev/null || echo READONLY-APP-OK' # READONLY-APP-OK
docker exec -e NS_URL=http://127.0.0.1:3123 -e NS_TOKEN="$BOOT_TOKEN" \
  ns-f node bin/nightshift.mjs next                                  # exit 0 — the shipped CLI, zero ready tasks
docker exec ns-f node bin/nightshift.mjs --help >/dev/null 2>&1; echo $? # 0 — dist form works
```

Then the host-side CLI against the container (REAL sockets — the D-xx honest-exception, stated): `NS_URL=http://127.0.0.1:3199 NS_TOKEN="$BOOT_TOKEN" node --import tsx bin/nightshift.mjs --help` → exit 0, usage on stderr. Graceful shutdown (D-ddd): `docker stop -t 12 ns-f && docker inspect -f '{{.State.ExitCode}}' ns-f` → **0** (the SIGTERM drain in `src/index.ts` under Docker stop — the measurement, not the claim; container + volume STAY for Task 6).

- [ ] **Step 5: Commit + record the build/smoke evidence** (verbatim PASS lines into the task's amendment blockquote — this task's gate is EXECUTION):

```bash
git add Dockerfile .dockerignore
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(docker): multi-stage image with the offline-gated UI build (D-ddd)"
```

## Task 6: The deploy probes as artifacts — `deploy-smoke.mjs` + `fts-probe.mjs` + the §14 checklist

**Files:**

- Create: `scripts/deploy-smoke.mjs`, `scripts/fts-probe.mjs`, `deploy/DEPLOY-SMOKE.md`

Both scripts live in `scripts/` — invisible to tsc/eslint/vitest like `ui-offline-check.mjs`, so their gate is RUNNING them (Step 3/4 do exactly that, against Task 5's container).

- [ ] **Step 1: Write `scripts/deploy-smoke.mjs`** (D-eee; zero deps — node 24 global fetch + subtle):

```js
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
  // cleanup: in_progress does NOT clear the claim (update-status.ts clears it only on
  // in_review/done — B2/S2) — the AGENT releases first (the arm P9 verified
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
```

- [ ] **Step 2: Write `scripts/fts-probe.mjs`** (the FTS5 arms Plan C declared-not-pinned, D-eee — run ONLY on a copy of the volume db):

```js
#!/usr/bin/env node
// fts-probe.mjs — the FTS5 arms Plan C declared-not-pinned (D-eee): the in-migration
// rebuild's data-carry and the delete trigger (task_fts_ad has no app-level delete path).
// Run against a COPY of the volume db, never the live file (the checklist shows the
// copy). Uses the repo's/image's better-sqlite3; FK enforcement is off on this
// connection (bare default) — this is a TRIGGER + index check, stated honestly.
// usage: node scripts/fts-probe.mjs <copy-of-nightshift.db>
import Database from 'better-sqlite3'

const file = process.argv[2]
if (!file) {
  console.error('usage: node scripts/fts-probe.mjs <copy-of-nightshift.db>')
  process.exit(2)
}
const db = new Database(file)
const count = (q, ...args) => db.prepare(q).get(...args).n
// arm 1 — data-carry: the deploy-smoke task (created by scripts/deploy-smoke.mjs)
// must be MATCH-able through the fts index exactly as the app writes it
const matched = count("select count(*) as n from task_fts where task_fts match 'deploy-smoke'")
const smoke = db
  .prepare("select rowid as rid, id from tasks where title like 'deploy-smoke%' limit 1")
  .get()
if (matched < 1 || smoke === undefined) {
  console.log(
    `FAIL fts data-carry — match:${matched} task:${smoke ? smoke.id : 'none'} (run deploy-smoke.mjs against this volume first)`
  )
  process.exit(1)
}
console.log(`PASS fts data-carry — ${matched} MATCH 'deploy-smoke' row(s), task ${smoke.id}`)
// arm 2 — the delete trigger: on the COPY, removing the tasks row must prune task_fts
const before = count('select count(*) as n from task_fts')
db.prepare('delete from tasks where id = ?').run(smoke.id)
const survives = count('select count(*) as n from task_fts where rowid = ?', smoke.rid)
console.log(
  survives === 0
    ? `PASS fts delete-trigger — rowid ${smoke.rid} pruned (${before} → ${count('select count(*) as n from task_fts')}, copy only)`
    : `FAIL fts delete-trigger — fts rowid ${smoke.rid} survives the tasks delete`
)
process.exit(survives === 0 ? 0 : 1)
```

- [ ] **Step 3: Run both probes for real against Task 5's container** (this IS the gate):

```bash
docker start ns-f
NS_URL=http://127.0.0.1:3199 NS_TOKEN="planf-local-smoke-token-0123456789abcdef" node scripts/deploy-smoke.mjs
docker stop -t 12 ns-f
docker cp ns-f:/data/nightshift.db /tmp/ns-fts-copy.db
for s in -wal -shm; do docker cp "ns-f:/data/nightshift.db$s" "/tmp/ns-fts-copy.db$s" 2>/dev/null || true; done
node scripts/fts-probe.mjs /tmp/ns-fts-copy.db && rm -f /tmp/ns-fts-copy.db*
```

Expected: `deploy-smoke: ALL PASS` exit 0; `PASS fts data-carry …` + `PASS fts delete-trigger …` exit 0. Any FAIL ⇒ fix the script (or record the honest server finding) before committing — amendments to this plan block per the byte-sync protocol. (B3 fix: the script runs HOST-side — it byte-compares against this checkout's `../openapi/openapi.yaml` via `import.meta.url` — so it hits the published mapping `127.0.0.1:3199`; container-internal `3123` is valid only INSIDE `docker exec`, which is what Task 5's in-container CLI arm uses. Both arms are recorded.)

- [ ] **Step 4: Write `deploy/DEPLOY-SMOKE.md`** — the numbered operator checklist (0 Inputs · 1 automated probes · 2 container/health/shutdown posture · 3 the CLI live legs · 4 REAL Pocket ID incl. the `INTERNAL_APP_URL` caveat + one-shot browser login + nonce echo verification · 5 first-login allow-list round-trip · 6 the FTS5 copy-probe commands · 7 the §14 live walkthrough · 8 residue ledger + recording duty). Full text ships in the commit; content per D-eee.

- [ ] **Step 5: Commit + record the local-run evidence:**

```bash
git add scripts/deploy-smoke.mjs scripts/fts-probe.mjs deploy/DEPLOY-SMOKE.md
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(deploy): deploy-smoke + fts-probe arms + the §14 checklist (D-eee)"
```

## Task 7: `deploy/README.md` — the full NS\_\* surface and the Pocket ID caveats

**Files:**

- Create: `deploy/README.md`

- [ ] **Step 1: Write `deploy/README.md`** — sections (D-eee; every env row transcribed from `src/main/config.ts`, nothing invented): What this ships (repo-side artifacts; the HelmRelease lives in home-ops — image build, tag/digest pin, registry push are home-ops steps) · Quickstart (`docker build`, `docker run` with `-v ns-data:/data` + the first-boot `NS_BOOTSTRAP_TOKEN`, port mapping to `NS_PORT`) · **The complete env table** — every `NS_*` with its config.ts default/rule: `NS_PORT` (3123, 1024–65535), `NS_DB_PATH` (`./nightshift.db` → image: `/data/nightshift.db`), `NS_BOOTSTRAP_TOKEN` (optional, ≥32; first-boot admin+token; **env-as-truth per boot** — durable revocation needs the env REMOVED too, `bootstrap.ts` as-is), `NS_DATA_DIR` (`./data` → `/data`), `NS_MAX_UPLOAD_BYTES` (20971520), `NS_RATE_LIMIT_PER_MIN` (120, 0=off), `NS_WEBHOOK_INTERVAL_MS` (1000, **0 disables the delivery loop**), `NS_WEBHOOK_TIMEOUT_MS` (5000), `NS_WEBHOOK_MAX_BACKOFF_MS` (300000), `NS_OIDC_ISSUER` (trailing `/` stripped), `NS_OIDC_CLIENT_ID`, `NS_OIDC_CLIENT_SECRET` (≥8, env-only, token-endpoint BODY only — D-ff), `NS_OIDC_SCOPE` (`openid profile email`), `NS_PUBLIC_URL` (required WITH OIDC), `NS_SESSION_KEY` (≥32, required WITH OIDC), `NS_SESSION_TTL_S` (28800; 60–2592000) — plus the fail-closed matrix (issuer+client-id ⇒ key+public-url REQUIRED, boot fails `invalid env`) and the OIDC-dormant rule (`/auth/*` ⇒ pinned 500 `oidc not configured`) · **Pocket ID**: register the client, redirect URI `{NS_PUBLIC_URL}/auth/callback`, `client_secret_post`, and the D-pp caveat VERBATIM (`INTERNAL_APP_URL` rewrites `jwks_uri`/`token_endpoint` to an IdP-internal host — the nightshift container must reach the PUBLIC URLs; same-origin browser + different-host RP ⇒ cookie domains split, which is exactly why sessions are signed httpOnly), the **nonce-echo verify-once** checkbox, session-key rotation = all sessions die at the exp bound (D-qq) · **Volumes/WAL**: ONE volume at `/data` (db + WAL sidecars + uploads); SQLite single-writer — never two containers on one volume, NEVER network filesystems for WAL; backup = stop, copy the db trio + `data/` tree · Non-root (uid 1000) + read-only `/app` · Health: `/ping` + the node HEALTHCHECK · Graceful stop: SIGTERM drain, exit 0 · **The CLI**: the four commands, the env table (`NS_URL`/`NS_TOKEN`/`NS_LEASE_TOKEN`/`NS_TIMEOUT_MS`), the exit ladder + `nightshift: <machine>` strings, examples (agent daemon loop sketch), notes (`kind question` deliberately unexposed; agent close pinned 403) · Upgrade/rollback: migrations run at boot (forward-only), rollback = prior tag + a volume snapshot if the schema moved · pointer to `DEPLOY-SMOKE.md`.

- [ ] **Step 2: Commit:**

```bash
git add deploy/README.md
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "docs(deploy): README with the NS_* surface + Pocket ID caveats (D-eee)"
```

## Task 8: Final whole-plan gate + record + PR (Night-shift endgame)

**Files:**

- Modify: this header (pre-dispatch ledger results, FINAL-GATE RECORD), plus the PR body (via `gh`, redaction-passed)

- [ ] **Step 1: Zero-churn proofs (success criteria, not ritual):**

```bash
git diff main --stat -- vitest.config.ts lefthook.yaml .github/workflows/ci.yaml \
  src/adapters/rest/problem.ts src/domain/errors.ts src/adapters/mcp/mount.test.ts \
  openapi/ src/client/schema.d.ts src/client/index.ts src/adapters/rest/auth.ts \
  src/adapters/rest/ui.ts src/adapters/rest/app.ts src/main/ src/index.ts \
  src/domain/ src/application/ src/infra/ src/adapters/ pnpm-lock.yaml pnpm-workspace.yaml \
  docs/superpowers/specs docs/superpowers/plans/2026-09-06* docs/superpowers/plans/2026-09-08* \
  docs/superpowers/plans/2026-09-09* docs/superpowers/plans/2026-09-11*
```

→ EVERY line empty: F ships ZERO server-code change (the D-aaa proof), the taxonomy/contract/MCP surfaces byte-frozen, all prior plan records untouched. `git diff main --stat -- package.json` shows ONLY the `bin` + `cli` lines (+ lockfile untouched); the whole F footprint is additive: `src/cli/`, `src/testing/inject-fetch.ts`, `bin/`, `scripts/`, `deploy/`, `Dockerfile`, `.dockerignore`, this plan doc.

- [ ] **Step 2: The gate:** `pnpm test:coverage && pnpm lint && pnpm typecheck && pnpm build && pnpm ui:build && pnpm ui:offline-check && pnpm test:e2e` — every global axis ≥ the Plan E record (**99.49 / 98.38 / 99.78 / 99.69**, never-lower HELD — the `src/cli/**` arms closed by test, P10; B6 fix: E's Funcs axis is 99.78); `test:e2e` probe-first per D-xx (browser may still be installed from Plan E — honest posture either way); THEN the F-native gates re-run for the record: `docker build` (fresh, no cache — the offline gate line quoted verbatim) → boot → `node scripts/deploy-smoke.mjs` → `ALL PASS` + the graceful `docker stop` exit-0 measurement. Honest counts recorded (650 → N tests / 86 → N files).

- [ ] **Step 3: Append the FINAL-GATE RECORD** to this header (Plan E's format): figures vs baseline; the zero-churn proof quoted; the image evidence lines (offline-gate output, config pins, healthy + exit-0 stop, CLI-in-image); the deploy-smoke + fts-probe local-run outputs (what RAN here vs what the operator runs at home — D-eee honesty, D-xx posture bar); the P1–P10 preflight outcomes; the CLI chain restatement (D-oo→D-yy→D-aaa CLOSED — the CLI shipped); the commit chain task-by-task; the QUEUED (HUMAN) ledger (Pocket ID real credentials + verify-once, browser/CI e2e, CSP hardening, session rotation, removeAdditional flip, npm publish + extensionless bin, home-ops HelmRelease + digest pin); the slice-out restatement (state frozen — SSE/search/undo/keepalive/capability scopes untouched).

- [ ] **Step 4: Byte-sync audit:** every shipped divergence has its amendment + `sync = shipped form` re-label; `rg -n "TBD|TODO|fill in|similar to Task" docs/superpowers/plans/2026-09-10-nightshift-plan-f-docker-deploy-cli.md` → empty (plan-failure scan). **Raw-git verification (E's binding lesson):** every hash quoted in the record re-checked with raw `git show --format=…` against the actual chain — no phantom commits.

- [ ] **Step 5: Commit the record, then end-of-night per the ticket protocol:** gates green ⇒ `git push -u origin feature/plan-f-docker-deploy-cli` + `gh pr create --title "feat: Plan F — Docker image, homelab deploy & the CLI" --body <shape of #3/#5/#8/#10 — resolves #11>`; red ⇒ push NOTHING, branch intact, honest state in the record. Redaction pass on the PR body: no local absolute paths, usernames, hostnames, or smoke literals beyond the documented ones. **NEVER merge — merges are @tyriis's (binding).**

```bash
git add docs/superpowers/plans/2026-09-10-nightshift-plan-f-docker-deploy-cli.md
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "docs(plan): plan F final gate record"
```

---

## Execution handoff

Plan complete. Per the ticket's Night-shift protocol the human sign-off gate is WAIVED and replaced by: (1) this plan's **independent plan-review lane** — PASS on spec §9/§12/§14 coverage, scope vs ticket #11 items 1–5, the five rulings, and the inherited-agreements restatement BEFORE any implementer dispatch (FAIL ⇒ revision as a logged amendment here), and (2) the **machine artifact-preflight** — probes P1–P10 above run against the real pinned environment BEFORE dispatch (every embedded block is treated as untrusted input; the silent-ignore class — a Dockerfile flag that quietly no-ops, a `z.url()` that does not exist on 4.5.4, a spawn condition that never resolves `#root` — is exactly E's failure class; a `--start-interval` the daemon rejects is exactly Plan E's `customFetch` lesson re-run). Results land in the pre-dispatch ledger above; revisions ship as amendments with lineage.

Then execute with subagent-driven-development — fresh implementer per task, TDD with honest REDs, spec-compliance review THEN code-quality review per task, fix rounds re-verified by the same reviewer, serial execution on shared wiring, byte-sync amendments with lineage, coverage never lowered (99.49 / 98.38 / 99.78 / 99.69 floor, `src/domain/**` 100×4, `vitest.config.ts` byte-untouched), **raw-git-verify every commit before claiming it**. QUEUED (HUMAN) items never block; stop conditions: baseline not green at the recorded numbers, an unbridgeable spec conflict, or the docker daemon absent mid-Task-5 (record, stop honestly — the image is F's deliverable, not an optional). NEVER merge.
