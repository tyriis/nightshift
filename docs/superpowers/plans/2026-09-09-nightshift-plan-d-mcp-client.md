# Plan D: MCP Server & Generated Client — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the MCP server as a thin adapter over the EXISTING use-cases (1:1 tools mirroring the REST surface + the four spec §7.1 composites `claim_next`/`post_update`/`ask_question`/`split_task`), the committed generated TypeScript client `nightshift-client` drift-pinned to `openapi/openapi.yaml`, and the §11.4 MCP⇄REST parity harness pinning every tool — success AND error paths — with zero new domain codes and zero behavior forks.

**Architecture:** The MCP server runs **in-process** behind the existing fastify auth/idempotency/rate-limit hook chain (spec §10 — "same guards, no bypass") as `POST/GET/DELETE /mcp` on `@modelcontextprotocol/server@2.0.0` (D-hh); every tool is a pure function of `(deps, ActorContext)` reusing the exact use-case/port call sites and response serializers of its REST twin (D-mm); errors ride the FLAT envelope doctrine through `structuredContent` (D-jj). The client is a committed generated `schema.d.ts` + hand-written `createNightshiftClient` wrapper (D-kk).

**Tech Stack:** fastify 5.12.3, `@modelcontextprotocol/server@2.0.0` (runtime, sanctioned exception — D-hh), `@modelcontextprotocol/client@2.0.0` (devDep), zod 4.5.4 (already present; SDK dedupes to it), `openapi-typescript@7.13.0` (devDep) + `openapi-fetch@0.17.0` (runtime, sanctioned — D-kk), Kysely 0.29.5 + better-sqlite3 13.0.3, vitest 4, node 24 / pnpm 10.33 via mise. **No other runtime dependencies.**

**Spec / Inputs (all in-repo):** `docs/superpowers/specs/2026-09-05-nightshift-design.md` §7.1, §9, §10, §11.4, §12 · Plan A record `docs/superpowers/plans/2026-09-06-nightshift-plan-a-agent-core.md` (D-a…D-l, Ruling A) · Plan B record `docs/superpowers/plans/2026-09-11-nightshift-plan-b-threads-questions.md` (D-m…D-z) · Plan C record `docs/superpowers/plans/2026-09-08-nightshift-plan-c-events-webhooks.md` (D-aa…D-gg) · `openapi/openapi.yaml` · ticket [tyriis/nightshift#6](https://github.com/tyriis/nightshift/issues/6).

---

## Status & provenance

- Branch: `feature/plan-d-mcp-client` off `main` @ `2d6c7d8` (PR #5 merge commit — Plan C IS merged, verified 2026-09-09). **No pushes** — merges and PRs are @tyriis's (binding).
- Ticket: tyriis/nightshift#6 (session-handover; scope = issue body "Plan D scope" + inherited rulings).
- Baseline gate (recorded by the planner 2026-09-09 at `2d6c7d8`, from Plan C's final gate): **416 tests / 62 files; Stmts 99.75 / Branch 98.06 / Funcs 100 / Lines 99.9**; lint / typecheck / build clean. Documented-uncovered set unchanged (`task-repo.ts:151-164`, `thread-repo.ts:96/132`, `rate-limit.ts:35`, `auth.ts:47`, `migrations.ts:274` error arm).
  - Baseline gate confirmed green at execution start by Task 1 (2026-09-09 at `800d192`): `pnpm test` → 416 passed / 62 files; coverage axes identical (Stmts 99.75 / Branch 98.06 / Funcs 100 / Lines 99.9), documented-uncovered set unchanged; lint (0 issues) / typecheck / build clean.
- Research artifacts (planner-provided, sandbox-probed, not repo files): MCP v2 SDK API pin + wire matrix (`mcp-sdk.md` notes, embedded verbatim where needed below), codegen comparison, REST response-semantics appendix. The SDK facts embedded in this plan were EXECUTED against `@modelcontextprotocol/{server,client}@2.0.0` on Node; if any shipped divergence surfaces, the byte-sync protocol closes it.

### Inherited binding rulings (Plans A+B+C — obey; violation = task failure)

- **Error taxonomy ONE map:** no Plan D task adds a `DomainErrorCode`; `src/domain/errors.ts` and the yaml `Problem.code` enum stay **byte-untouched** — the drift test pins `domain ∪ adapter` (D-uu/D-u precedent). Adapter codes live in `problem.ts` `ADAPTER_ERROR_CODES`. `DomainError.details` ride the FLAT envelope — the MCP envelope copies that doctrine (D-jj).
- **Audit is the one spine** (D-aa); no second event ledger; machine reason strings are grep-pinned and never reworded. Plan D introduces **no new audit reasons** (composites reuse the use-cases' own reasons); any new machine-facing MCP string gets pinned by its test the same task.
- `PUBLIC_PATHS` stays exactly `{/ping, /openapi.yaml}` — `/mcp` is authenticated by that fact. Hook order `auth → idempotency → rate-limit` UNCHANGED; no new onRequest hooks at app level (Task 4 adds one conditional INSIDE the existing idempotency hook — recorded, not a new hook). `requireHuman` stays async; actorCtx spreads LAST.
- UoW FIFO non-reentrant; never touch root db inside `withTransaction`; never hold a tx across network I/O. MCP handlers are ordinary single-use-case callers — nothing in Plan D runs a background loop.
- Time seam (T14): nothing in Plan D decides on elapsed time; recorded timestamps stay `Clock`-port.
- Secrets (D-ff): MCP exposes **no** admin/webhook/token surfaces (D-nn) — the `secret` read path stays `listDue`-only; the plan adds no second reader and prints no secret values in tests.
- Ghost-404 doctrine (typo'd id 404s, never masquerades as empty) applies to every read tool verbatim. `/events`-style rate-budget burn applies to `/mcp` (D-dd doctrine).
- `removeAdditional` status quo: fastify strips unknown body keys; MCP input schemas STRIP too (zod default, no `.strict()`) — strip-parity pinned in Task 10. The 400-on-extras flip stays a queued HUMAN decision.
- Untouched: `ready()` (Ruling A), claim CAS + generation fencing, D-o invariant-6, D-s store, D-q mention grammar, FTS5 repo-port-only (D-gg — **MCP is not a §12 lift**: no search tool, D-oo). `src/domain/**` coverage stays 100×4 (no domain file is touched). Coverage thresholds unchanged (global ≥85), never-lower bar applies to every axis.
- Conventions: TDD, `pnpm test <file>` red/green then `pnpm test && pnpm lint && pnpm typecheck` before commit; `LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "<subject ≤72>"` conventional commits; tests colocated `*.test.ts`; env via `makeTestApp(overrides)`; temp dirs via `os.tmpdir()`; tests NEVER read `.env`/secret paths; no fake RED — honest declarations; new files `git add` explicitly; a commit cannot quote its own hash.

### Plan ⇄ shipped byte-sync protocol (same as Plans A+B+C)

The code blocks below are the planned text. If shipped code lands byte-different from a block (review repair, lint normalization, API correction), the implementer appends a `> **Amendment (Task N, <who/what>):** …` blockquote to that task's section in THIS file, quoting what changed (with `git show <hash>` for review repairs) and re-labels the block `sync = shipped form` once identical. Never leave the plan silently describing code that does not exist. A commit cannot quote its own hash — amendments land in the child fix commit. A pin that passes first-run says so: "there is no RED phase to claim and none is claimed."

---

## Decision records (Plan D — D-hh … D-oo; letters continue Plan C's D-aa…D-gg)

**D-hh — MCP SDK line v2, mounted in-process at `/mcp` (stateless Streamable HTTP), runtime-dep exception declared.** Spec §10 binds "in-process behind the same auth middleware — same guards, no bypass", which rules out stdio (a second process = second identity path and a second UoW against one SQLite file). Chosen line: `@modelcontextprotocol/server@2.0.0` + `@modelcontextprotocol/client@2.0.0` (devDep). Why not v1 (`@modelcontextprotocol/sdk@1.30.0`): its server is per-session with `tool()` deprecated, it drags `express@5` + `hono@4` transitively, and its root barrel import is broken (#971); v2 is protocol 2026-07-28 with legacy-first negotiation, its server package's only dependency is `zod` (already the repo's 4.5.4 — pnpm dedupes), and its `createMcpHandler` per-request server factory is the only shape that binds per-request actor identity with no session→server Map. Measured (probed): constructing a fresh handler per request costs ~1.7 ms, leaks no timers, has no process-wide state — adopted, since a shared handler's factory cannot carry our `ActorContext` (the factory ctx only carries `authInfo` strings). `@modelcontextprotocol/fastify@2.0.0` exists but ships NO handler adapter (it builds its own app) — the mount is an explicit route + `reply.hijack()` (~30 lines, zero extra deps, probed end-to-end). **Runtime-dep posture:** inherited "no new runtime dependencies" is KEPT for everything except this mount and openapi-fetch (D-kk); both exceptions are stated here, and the inherited codegen-dev-dependency-only rule stays. Fallback (recorded, not planned): v1 `@modelcontextprotocol/sdk@1.30.0` subpath imports + `StreamableHTTPServerTransport` stateless mode.

**D-ii — Identity seam: the existing hook chain guards `/mcp`; identity closes over the per-request server.** The app-level `registerAuth` onRequest hook runs for `/mcp` exactly as for REST (not in `PUBLIC_PATHS` ⇒ missing/revoked bearer ⇒ the standard 401 problem+json; the MCP client surfaces it as `SdkHttpError` code `CLIENT_HTTP_AUTHENTICATION` (modern pin) / `CLIENT_HTTP_NOT_IMPLEMENTED` (legacy) — matched on `code`, not prose). The mount reads `request.actorRef`/`request.tokenId` set by the hook and closes them into `buildMcpServer(deps, ctx, mcpTools)` — **no token re-lookup, no second identity path**; a tool's `ActorContext` is the same object the REST routes spread LAST into bodies, so body/args can never shadow identity (stronger than REST's spread-last, same doctrine). Rate-limit burns the per-actor budget per JSON-RPC call (D-dd precedent). **Idempotency-Key is inert on `/mcp`:** JSON-RPC retries are at-most-once per call, and a hijacked response never fires `onSend`, which would strand a reservation forever — Task 4 adds a recorded `url.startsWith('/mcp')` skip inside the existing idempotency hook with a pin test; this is the ONLY hook change and violates no ordering (MCP is NOT an idempotency-replay surface — stated, with the §7.3 rationale: the spec's replay guarantee is an HTTP-contract feature; agent runners retry MCP tools deliberately. The audit spine records every attempt). `handler.fetch` gets no `authInfo` (it verifies nothing by design — probed); the mount forwards ALL request/response headers verbatim (the 2026-07-28 leg enforces the `Mcp-Method`/`Mcp-Name` header⇄body mirror; allow-lists break it) and drops hop-by-hop headers into the Web `Request`.

**D-jj — Tool result envelope: `{ result: <exact REST JSON body> }` on success, FLAT `{ code, status, ...details }` on application errors, both mirrored into `text`.** No `outputSchema` ANYWHERE (probed: `structuredContent` passes through unvalidated without one): an output schema would be a second source of truth for response shapes that the REST side owns. Arrays are valid results (wrapped: `{ result: TaskDto[] }`) because MCP requires an object `structuredContent`. Both channels carry identical JSON (`content[0].text` + `structuredContent`) so machine-clients have a redundant parse path and the parity harness asserts on `structuredContent`. Application errors: `isError:true` + FLAT envelope `{ code: error.code, status: error.status, ...(error.details ?? {}) }` — `DomainError.details` sit at top level exactly like the REST problem body (no `type/title/detail` prose is mirrored; prose is transport, the taxonomy is contract). Unknown throws map to `{ code: 'internal_error', status: 500 }` with NO stack leak, mirroring `problem.ts`; adapter-level non-domain codes (the only reachable one is 413 via `McpEnvelopeError`, D-mm) reuse the SAME code names from `ADAPTER_ERROR_CODES` — the taxonomy stays one map, the yaml enum untouched. SDK-level rejections (unknown tool, input validation) keep SDK error shapes on purpose — MCP's analog of a fastify 400 validation rejection; the harness classifies them "rejected ⇄ rejected" and this scope is pinned, not hand-waved (D-mm strip-parity rows).

**D-kk — Client: `openapi-typescript@7.13.0` (devDep) generating one committed `src/client/schema.d.ts`, `openapi-fetch@0.17.0` as the client runtime, thin hand-written `createNightshiftClient`.** Why: single generated file (vs 16 for @hey-api), byte-deterministic (no timestamps/versions in header — probe-verified across double-generations), typed `application/problem+json` errors via the `${string}/json` content filter (tsc-proven), and `openapi-fetch`'s only dependency is the types-only helpers package (4.3 KB gz; second sanctioned exception, D-hh). Drift-pin: `pnpm gen:client` regenerates to a temp path + prettier-formats, and a vitest drift test byte-compares the temp against the committed artifact (git-dirt-proof, no CI git dependency); the committed file is prettier-formatted and format-on-save is pinned away via the regen byte-compare. Scripts: `"gen:client": "openapi-typescript openapi/openapi.yaml -o src/client/schema.d.ts && prettier --write src/client/schema.d.ts"`. Fallback (recorded, not planned): `@hey-api/openapi-ts@0.99.0` (pure devDep, inlined runtime) if the zero-runtime-deps bar were tightened. The client lives at `src/client/` (builds/ships with the app via the existing `#root/client` alias; extracting a publishable `nightshift-client` npm package is a later human decision — the module is the spec's `nightshift-client`). The client is load-bearing in Plan D: the parity harness's smoke test drives REST through it (inject-backed `fetch`), so a stale generated artifact breaks a test, not just a consumer.

**D-ll — `/mcp` is a contract-pinned EXEMPTION in the drift test, never a silent hole.** The route⇄yaml drift test keeps `specKeys === routeKeys` for every REST route; the three transport routes (`POST /mcp`, `GET /mcp`, `DELETE /mcp`) live in an explicit `MCP_ROUTES` set that the test asserts EXACTLY (a fourth `/mcp` verb, or any non-`/mcp` route hiding in the exemption, fails the pin), and the yaml is asserted to never mention `/mcp`. The MCP surface is instead pinned by the tools-list snapshot + parity harness (Task 10). Rationale: the OpenAPI contract is the REST product surface; the MCP protocol is a JSON-RPC envelope the yaml cannot meaningfully describe.

**D-mm — Tool doctrine: 31 1:1 mirrors + 4 composites = 35 tools; tools are pure functions of `(deps, ActorContext)` transcribing the REST twin.** Every 1:1 tool body transcribes the REST route's EXACT call sequence, including the re-fetch-after-write serializer (`toTaskDto(await deps.tasksRoot.findWithCounts(id)!)`, uc return DISCARDED where REST discards it), the ghost-404 messages verbatim (`` `task ${id} not found` `` etc.), and the handler-side defaults (`get_inbox` limit 50, `list_ready_tasks` limit default 10 via the use-case clamp, `search_audit` limit default 50, `get_events` cursor 0 / limit 100). Zod input objects transcribe the fastify schema bounds and **STRIP** unknown keys (default behavior — the `removeAdditional` status quo; flipping to `.strict()` is the queued human decision, single sweep when it lands). No `title`/`annotations` beyond `description` (YAGNI). Attachment posture (D-s unchanged): MCP has no octet-stream body, so `upload_attachment` carries `content_base64` and self-checks `deps.config.maxUploadBytes`, throwing `McpEnvelopeError { code: 'payload_too_large', status: 413 }` — the same code name as REST's adapter rejection; `get_attachment_content` returns `{ content_type, content_disposition, filename, bytes_base64 }` computing the `UNSAFE_INLINE` downgrade + filename sanitize through the SHARED helpers extracted in Task 2 (one source, no fork). Admin/webhook surfaces are NOT exposed (D-nn).

**D-nn — Composites are sequences of the SAME use-case calls; admin surfaces stay out of MCP v1.** `claim_next` = `getNext.run({limit:1})` → `claimTask.run` (empty ⇒ `{claimed:false}` is data, not an error; a lost race propagates the ordinary `already_claimed` FLAT envelope + D-cc inbox copy — no new string, no new code). `post_update` = comment (`addMessage`, or `createThread kind:'note'` when no `thread_id`) → optional `heartbeat` → optional `updateStatus` (`reason` REQUIRED with `status` — a missing reason is `DomainError('invalid_request', 'status in post_update requires reason')`, pinned; no synthesized audit reason — the use-case's reason requirement is the point). `ask_question(task, text, assignee)` = handle→id via the Task-2 SHARED `resolveActorHandle` (the REST route flips to the same helper — no grammar fork) → `createThread kind:'question'`. `split_task` = `splitTask.run` verbatim (it mirrors `POST /tasks/:id/split` exactly, so it also gets a REST parity row). **Composites are NOT transactional**: a mid-sequence failure leaves earlier steps booked (each is its own single use-case transaction — same doctrine as the delivery loop's single statements); the harness pins that a propagating error does not mask earlier writes. **Admin actors/tokens/policy/webhooks + audit-admin lists are not exposed as tools** (YAGNI + human-domain: humans have REST/UI/OIDC (E); agents were never allowed on `/admin/*` (D-h) and MCP must not become the side door). Token/credential at-rest posture: **unchanged** — Plan D adds NO new credential, stores NO secret, and reads none (the `secret` select stays `listDue`-only).

**D-oo — Explicitly sliced out of Plan D (stated with reasons).** SSE — still §12 (D-ee unchanged). Search — FTS5 stays repo-port-only; an MCP search tool WOULD be the §12 surface arriving without the human decision (D-gg posture). CLI (`nightshift claim|report|next`) — §12: it rides the generated client; D ships the substrate, the CLI stays deferred and belongs to **E** (ships with the OIDC/UI wave per Plan A's ledger; say so now so it is not orphaned). Admin/webhook tools — D-nn. Keepalive enforcement, capability scopes, cost fields, forge webhooks, templates — §12, untouched. Playwright smoke — E. Docker/`openapi/` asset-shipping + FTS deploy-smoke arms — F. `removeAdditional` flip — queued HUMAN decision (blast radius stays as Plan B's Task 7 amendment scoped it).

## Backlog disposition (ticket #6 "Known backlog")

| Backlog item                                                                          | Where                                                                      |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `routes/admin.ts` import symmetry (one-liner, reviewer-ruled, never silently applied) | **Folded — Task 2** (shared-seams chore, zero behavior)                    |
| `removeAdditional` 400-on-extras flip                                                 | **NOT folded** — queued human decision; MCP strip-parity pinned in Task 10 |
| FTS in-migration rebuild/delete-trigger arms                                          | **NOT folded** — Plan F deploy-smoke checklist (unchanged)                 |
| Docker `openapi/` asset-shipping note                                                 | **NOT folded** — Plan F (unchanged)                                        |
| `routes/links.ts` merge                                                               | Done (Plan C Task 16) — not touched here                                   |

## File structure

**New:**

| Path                                       | Responsibility                                                                                        |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `src/adapters/mcp/bridge.ts`               | `McpTool`/`defineTool`, `McpEnvelopeError`, `okResult`/`errorResult`/`runTool` envelope bridge (D-jj) |
| `src/adapters/mcp/server.ts`               | `buildMcpServer(deps, ctx, tools)` — the ONLY place the SDK server is constructed                     |
| `src/adapters/mcp/http.ts`                 | fastify ⇄ Web Request/Response converters + hop-by-hop rules (verbatim probe code, D-hh/D-ii)         |
| `src/adapters/mcp/mount.ts`                | `mountMcp(app, deps)` — scoped route `GET/POST/DELETE /mcp`, per-request handler + identity closure   |
| `src/adapters/mcp/tools/index.ts`          | `mcpTools` registry (grows Tasks 4–8; final = 35)                                                     |
| `src/adapters/mcp/tools/tasks.ts`          | 12 task-domain tools (seeded `get_task`/`list_tasks` in Task 4; completed Task 5)                     |
| `src/adapters/mcp/tools/discussion.ts`     | 7 thread+inbox tools (`get_inbox` seeded Task 4; rest Task 6)                                         |
| `src/adapters/mcp/tools/references.ts`     | 12 links/labels/attachments/events/audit tools (Task 7)                                               |
| `src/adapters/mcp/tools/composites.ts`     | 4 spec composites (Task 8)                                                                            |
| `src/adapters/shared/resolve-handle.ts`    | `resolveActorHandle` — moved VERBATIM from `routes/threads.ts` `handleToId` (Task 2)                  |
| `src/adapters/shared/attachment-safety.ts` | `UNSAFE_INLINE` + `safeFilename` — moved from `routes/attachments.ts` (Task 2)                        |
| `src/client/schema.d.ts`                   | GENERATED — committed artifact (Task 9)                                                               |
| `src/client/index.ts`                      | `createNightshiftClient({ baseUrl, token, fetch? })` — auth middleware + typed paths (Task 9)         |
| `src/testing/mcp-client.ts`                | test harness: in-memory client pair + real-HTTP client + actor-context lookup (Tasks 3–4)             |
| colocated tests                            | `mcp/*.test.ts`, `client/*.test.ts`, `rest/mcp-parity.test.ts`                                        |

**Modified:** `package.json` (deps + `gen:client` — Tasks 1, 9) · `src/adapters/rest/app.ts` (mount — Task 4) · `src/adapters/rest/idempotency.ts` (`/mcp` skip — Task 4) · `src/adapters/rest/openapi-contract.test.ts` (`MCP_ROUTES` exemption — Task 4) · `src/adapters/rest/routes/threads.ts` (use shared resolver — Task 2) · `src/adapters/rest/routes/attachments.ts` (use shared safety helpers — Task 2) · `src/adapters/rest/routes/admin.ts` (import fold — Task 2) · `src/adapters/rest/idempotency.test.ts` (skip pin — Task 4).

**Touched by NOTHING:** `src/domain/**`, `src/application/**`, `openapi/openapi.yaml`, `migrations.ts`, `schema.ts`, `config.ts`, `deps.ts` — zero domain/application/contract churn is a Plan D success criterion; the final gate diffs them.

## Execution protocol (from Plans A+B+C, binding)

Fresh implementer subagent per task; strict serial order (Tasks 1→11) — shared wiring (`tools/index.ts`, `app.ts`) forbids parallel lanes. TDD per task steps; independent spec-review + quality-review before the next task; fix rounds re-verified by the same reviewer; amendments per the byte-sync protocol above; commit per task with the pre-chosen subject (≤72 chars, `LEFTHOOK_CONFIG=$PWD/lefthook.yaml` prefix); never-lower coverage bar; Task 1 Step 1 is the baseline confirmation — **if any baseline step is RED, STOP — the plan is blocked on main; report and wait.** Task 11 records the final gate in this header and stops: report to @tyriis, no push, no merge, no PR.

---

## Task 1: Baseline confirmation + SDK v2 dependencies

**Files:**

- Create: `src/adapters/mcp/sdk-smoke.test.ts`
- Modify: `package.json` (deps — via pnpm only)

- [ ] **Step 1: Confirm the baseline gate — if RED, STOP (plan blocked on main)**

Run: `pnpm test` — expect `416 passed`. Run: `pnpm test:coverage` — expect Stmts 99.75 / Branch 98.06 / Funcs 100 / Lines 99.9. Run: `pnpm lint && pnpm typecheck && pnpm build` — expect clean. Record the confirmation in the header's Status & provenance ("Baseline gate confirmed green at execution start by Task 1").

- [ ] **Step 2: Write the failing import smoke**

```ts
// src/adapters/mcp/sdk-smoke.test.ts
import { describe, expect, it } from 'vitest'

describe('mcp sdk v2 import surface', () => {
  it('serves the server symbols from the root barrel (D-hh: v2 root works; v1 did not)', async () => {
    const server = await import('@modelcontextprotocol/server')
    expect(typeof server.McpServer).toBe('function')
    expect(typeof server.createMcpHandler).toBe('function')
  })

  it('serves the client + transports from the client root', async () => {
    const client = await import('@modelcontextprotocol/client')
    expect(typeof client.Client).toBe('function')
    expect(typeof client.StreamableHTTPClientTransport).toBe('function')
    expect(typeof client.InMemoryTransport.createLinkedPair).toBe('function')
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm test src/adapters/mcp/sdk-smoke.test.ts`
Expected: FAIL — module not found for both `@modelcontextprotocol/*` packages. Honest RED.

- [ ] **Step 4: Install pinned dependencies**

Run: `pnpm add @modelcontextprotocol/server@2.0.0 && pnpm add -D @modelcontextprotocol/client@2.0.0`
Expected: server tree = `server → core` (zod dedupes to the repo's 4.5.4 — confirm with `pnpm why zod`: deduped, single 4.5.4; if `ERR_MODULE_NOT_FOUND: 'zod'` appears later, zod is already declared, so pnpm isolation is satisfied). `better-sqlite3` stays in `onlyBuiltDependencies`; neither new package builds.

- [ ] **Step 5: Green + full gates**

Run: `pnpm test && pnpm lint && pnpm typecheck` — all green.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/mcp/sdk-smoke.test.ts package.json
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "chore(deps): mcp sdk v2 — server runtime, client dev (D-hh)"
```

## Task 2: Shared seams — handle resolver, attachment safety, admin import fold

Zero behavior; the existing suites are the behavior pins (this is a verbatim relocation — no new RED is claimed beyond the one pure-helper test, and none is invented: the helper test must run GREEN on first execution because the helpers move unchanged; if it does not, the unit broke — fix the unit, not the story).

**Files:**

- Create: `src/adapters/shared/resolve-handle.ts`, `src/adapters/shared/attachment-safety.ts`, `src/adapters/shared/attachment-safety.test.ts`
- Modify: `src/adapters/rest/routes/threads.ts` (drop local `handleToId` at `:13`, import the shared resolver), `src/adapters/rest/routes/attachments.ts` (drop local `UNSAFE_INLINE` at `:7` + the inline filename regex at `:74`, import both), `src/adapters/rest/routes/admin.ts:4-5` (import fold)

- [ ] **Step 1: Move `handleToId` verbatim**

Copy the current function body from `routes/threads.ts:13` unchanged — error messages included (they are REST-pinned) — into:

```ts
// src/adapters/shared/resolve-handle.ts — MOVED VERBATIM from routes/threads.ts:13
// (blockquote the source hash when the move lands)
import type { AppDeps } from '#root/main/deps'

export const resolveActorHandle = async (deps: AppDeps, handle: string): Promise<string> => {
  /* verbatim relocated body — sync = shipped form after the move */
}
```

In `routes/threads.ts`: delete the local function, `import { resolveActorHandle } from '#root/adapters/shared/resolve-handle'`, replace both call sites (`:53`, `:129`) with `resolveActorHandle(deps, ...)`.

- [ ] **Step 2: Move the attachment-safety pair**

```ts
// src/adapters/shared/attachment-safety.ts — MOVED VERBATIM from routes/attachments.ts:7 + :74
export const UNSAFE_INLINE = /^text\/html|^application\/xhtml|^image\/svg/i

// filename sanitized for the disposition header: EVERY control char (\x00-\x1f, \x7f —
// node's header validator rejects anything outside \t\x20-\x7e\x80-\xff with a raw
// ERR_INVALID_CHAR 500) plus quote and backslash, all folded to '_'
export const safeFilename = (filename: string): string =>
  filename.replace(/[\x00-\x1f\x7f"\\]/g, '_')
```

In `routes/attachments.ts`: import both, replace the local regex constant and the inline `.replace(...)` with `safeFilename(row.filename)`.

- [ ] **Step 3: Fold the admin import (Plan C reviewer ruling — applied here, not silently)**

`routes/admin.ts:4-5` before:

```ts
import type { ActorKind } from '#root/domain/task'
import { ACTOR_KINDS } from '#root/domain/task'
```

after:

```ts
import { ACTOR_KINDS, type ActorKind } from '#root/domain/task'
```

- [ ] **Step 4: Pin the pure helpers (first-run GREEN by design — declared)**

```ts
// src/adapters/shared/attachment-safety.test.ts
import { describe, expect, it } from 'vitest'
import { safeFilename, UNSAFE_INLINE } from './attachment-safety'

describe('attachment safety (D-s, moved verbatim)', () => {
  it('downgrades html/xhtml/svg origins — pinned matrix', () => {
    expect(UNSAFE_INLINE.test('text/html')).toBe(true)
    expect(UNSAFE_INLINE.test('text/HTML; charset=utf-8')).toBe(true)
    expect(UNSAFE_INLINE.test('application/xhtml+xml')).toBe(true)
    expect(UNSAFE_INLINE.test('image/svg+xml')).toBe(true)
    expect(UNSAFE_INLINE.test('text/plain')).toBe(false)
    expect(UNSAFE_INLINE.test('image/png')).toBe(false)
  })

  it('folds control chars, quote and backslash to _ — never a raw ERR_INVALID_CHAR', () => {
    expect(safeFilename('a"b\\c')).toBe('a_b_c')
    expect(safeFilename('tab\there\nlf')).toBe('tab_here_lf')
    expect(safeFilename('del')).toBe('del_')
    expect(safeFilename('ünïcode ✓.md')).toBe('ünïcode ✓.md')
  })
})
```

- [ ] **Step 5: Full gates (the behavior pin)**

Run: `pnpm test && pnpm lint && pnpm typecheck` — expect unchanged-green: every `routes/*.test.ts` thread/attachment pin passes untouched.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/shared src/adapters/rest/routes/threads.ts src/adapters/rest/routes/attachments.ts src/adapters/rest/routes/admin.ts
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "refactor(api): shared handle resolver + attachment safety (D-mm)"
```

## Task 3: Envelope bridge + server builder (D-jj)

**Files:**

- Create: `src/adapters/mcp/bridge.ts`, `src/adapters/mcp/server.ts`, `src/adapters/mcp/bridge.test.ts`, `src/testing/mcp-client.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/adapters/mcp/bridge.test.ts
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineTool, McpEnvelopeError, okResult, runTool } from './bridge'
import { buildMcpServer } from './server'
import { InMemoryTransport } from '@modelcontextprotocol/client'
import { Client } from '@modelcontextprotocol/client'
import { DomainError } from '#root/domain/errors'
import type { ActorContext } from '#root/application/ports'
import type { AppDeps } from '#root/main/deps'

const ctx: ActorContext = {
  actor: { id: 'actor_fake', kind: 'human', handle: 'a_fake', display_name: 'Fake' },
  tokenId: null,
}
const deps = {} as AppDeps // the fixtures below never touch deps

const echo = defineTool({
  name: 'echo',
  description: 'echo',
  input: z.object({ msg: z.string() }),
  run: async (_d, _c, { msg }) => ({ msg }),
})

describe('mcp envelope bridge (D-jj)', () => {
  it('success envelope: { result } mirrored into text', async () => {
    const r = await runTool(echo, deps, ctx, { msg: 'hi' })
    expect(r.isError).toBeUndefined()
    expect(r.structuredContent).toEqual({ result: { msg: 'hi' } })
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({ result: { msg: 'hi' } })
  })

  it('void result normalizes to { result: null } (the 204 analog)', async () => {
    const voidTool = defineTool({
      name: 'v',
      description: 'v',
      input: z.object({}),
      run: async () => undefined,
    })
    expect((await runTool(voidTool, deps, ctx, {})).structuredContent).toEqual({ result: null })
  })

  it('DomainError lands FLAT: code, status, details at top level', async () => {
    const boom = defineTool({
      name: 'b',
      description: 'b',
      input: z.object({}),
      run: async () => {
        throw new DomainError('already_claimed', 'claimed', {
          holder_handle: 'a_x',
          claimed: false,
        })
      },
    })
    const r = await runTool(boom, deps, ctx, {})
    expect(r.isError).toBe(true)
    expect(r.structuredContent).toEqual({
      code: 'already_claimed',
      status: 409,
      holder_handle: 'a_x',
      claimed: false,
    })
  })

  it('unknown throw → internal_error 500, no stack leak (mirrors problem.ts)', async () => {
    const boom = defineTool({
      name: 'u',
      description: 'u',
      input: z.object({}),
      run: async () => {
        throw new Error('inner detail that must not surface')
      },
    })
    const r = await runTool(boom, deps, ctx, {})
    expect(r.isError).toBe(true)
    expect(r.structuredContent).toEqual({ code: 'internal_error', status: 500 })
    expect(JSON.stringify(r)).not.toContain('inner detail')
  })

  it('McpEnvelopeError rides the shared adapter vocabulary (413, D-jj)', async () => {
    const big = defineTool({
      name: 'x',
      description: 'x',
      input: z.object({}),
      run: async () => {
        throw new McpEnvelopeError({ code: 'payload_too_large', status: 413 })
      },
    })
    expect((await runTool(big, deps, ctx, {})).structuredContent).toEqual({
      code: 'payload_too_large',
      status: 413,
    })
  })
})

describe('buildMcpServer over the in-memory pair', () => {
  it('lists and calls registered tools; input validation and unknown tools stay SDK-shaped', async () => {
    const server = buildMcpServer(deps, ctx, [echo])
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-harness', version: '1.0.0' })
    await Promise.all([client.connect(clientEnd), server.connect(serverEnd)])
    try {
      const listed = await client.listTools()
      expect(listed.tools.map((t) => t.name)).toEqual(['echo'])
      const ok = await client.callTool({ name: 'echo', arguments: { msg: 'hey' } })
      expect(ok.structuredContent).toEqual({ result: { msg: 'hey' } })
      const badArgs = await client.callTool({ name: 'echo', arguments: { msg: 42 } })
      expect(badArgs.isError).toBe(true) // SDK input-validation shape — declared scope (D-jj)
      const unknown = await client.callTool({ name: 'nope', arguments: {} })
      expect(unknown.isError).toBe(true)
    } finally {
      await client.close()
    }
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/adapters/mcp/bridge.test.ts` — FAIL: cannot resolve `./bridge` / `./server`.

- [ ] **Step 3: Implement the bridge**

```ts
// src/adapters/mcp/bridge.ts
import type { CallToolResult } from '@modelcontextprotocol/server'
import type { z } from 'zod'
import type { ActorContext } from '#root/application/ports'
import { isDomainError } from '#root/domain/errors'
import type { AppDeps } from '#root/main/deps'

// A tool is a pure function of (deps, ActorContext): the exact REST twin's call
// sequence, transcribed (D-mm). `args: never` makes the erased registry list
// contravariant-safe; the ONLY legal caller is runTool, immediately after zod
// validation at the registration edge in server.ts.
export interface McpTool {
  name: string
  description: string
  input: z.ZodType
  run: (deps: AppDeps, ctx: ActorContext, args: never) => Promise<unknown>
}

export interface ToolDef<S extends z.ZodType> {
  name: string
  description: string
  input: S
  run: (deps: AppDeps, ctx: ActorContext, args: z.infer<S>) => Promise<unknown>
}

// Registry-edge erasure; run() stays schema-bound by construction.
export const defineTool = <S extends z.ZodType>(def: ToolDef<S>): McpTool =>
  def as unknown as McpTool

// Non-DomainError MCP-surface rejection sharing the REST ADAPTER code vocabulary
// (only payload_too_large is reachable — D-jj/D-mm). Domain conditions always
// throw DomainError, exactly like the REST twins.
export class McpEnvelopeError extends Error {
  constructor(readonly envelope: Record<string, unknown>) {
    super(String(envelope.code ?? 'internal_error'))
  }
}

export const okResult = (payload: unknown): CallToolResult => {
  const body = { result: payload ?? null }
  return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body }
}

export const errorResult = (envelope: Record<string, unknown>): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify(envelope) }],
  structuredContent: envelope,
})

export const runTool = async (
  tool: McpTool,
  deps: AppDeps,
  ctx: ActorContext,
  args: unknown
): Promise<CallToolResult> => {
  try {
    return okResult(await tool.run(deps, ctx, args as never))
  } catch (error) {
    if (isDomainError(error)) {
      return errorResult({ code: error.code, status: error.status, ...(error.details ?? {}) })
    }
    if (error instanceof McpEnvelopeError) return errorResult(error.envelope)
    return errorResult({ code: 'internal_error', status: 500 })
  }
}
```

```ts
// src/adapters/mcp/server.ts
import { McpServer } from '@modelcontextprotocol/server'
import type { ActorContext } from '#root/application/ports'
import { runTool } from '#root/adapters/mcp/bridge'
import type { McpTool } from '#root/adapters/mcp/bridge'
import type { AppDeps } from '#root/main/deps'

// The ONLY place an MCP server is constructed (D-hh: fresh McpServer per request,
// identity closed over by the mount). NO outputSchema anywhere (D-jj).
export const buildMcpServer = (deps: AppDeps, ctx: ActorContext, tools: McpTool[]): McpServer => {
  const server = new McpServer(
    { name: 'nightshift-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  )
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      // `as never`: satisfies the StandardSchemaWithJSON generic at the erased
      // registry edge; the runtime schema is the real zod object (probe-verified).
      { description: tool.description, inputSchema: tool.input as never },
      (args) => runTool(tool, deps, ctx, args)
    )
  }
  return server
}
```

```ts
// src/testing/mcp-client.ts — harness: in-memory pair + real-HTTP client + actor ctx lookup
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { buildMcpServer } from '#root/adapters/mcp/server'
import type { McpTool } from '#root/adapters/mcp/bridge'
import type { ActorContext } from '#root/application/ports'
import type { AppDeps } from '#root/main/deps'
import { hashToken } from '#root/application/token-hash'
// ^ Step 3 discovery pin: `rg "export const hashToken" src/` — use the ACTUAL home
// module path under #root; the pin is the function, not this guessed path (amend if moved).

export const actorContextFor = async (deps: AppDeps, rawToken: string): Promise<ActorContext> => {
  const lookup = await deps.actorsRoot.findActiveTokenByHash(hashToken(rawToken))
  if (!lookup) throw new Error('test harness: unknown token')
  return { actor: lookup.actor, tokenId: lookup.token.id }
}

export const openInMemoryPair = async (deps: AppDeps, ctx: ActorContext, tools: McpTool[]) => {
  const server = buildMcpServer(deps, ctx, tools)
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-harness', version: '1.0.0' })
  await Promise.all([client.connect(clientEnd), server.connect(serverEnd)])
  return {
    call: (tool: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name: tool, arguments: args }),
    list: () => client.listTools(),
    close: () => client.close(),
  }
}

// pin='2026-07-28' forces the modern era; pin=undefined keeps the default legacy handshake.
export const openHttpMcp = async (baseUrl: string, bearer: string, pin?: '2026-07-28') => {
  const client = new Client(
    { name: 'test-harness', version: '1.0.0' },
    pin === undefined ? undefined : { versionNegotiation: { mode: { pin } } }
  )
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
    })
  )
  return {
    call: (tool: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name: tool, arguments: args }),
    list: () => client.listTools(),
    close: () => client.close(),
  }
}
```

- [ ] **Step 4: Green + gates** — `pnpm test && pnpm lint && pnpm typecheck`.

If `registerTool`'s typings reject the bridge shapes, fix minimally and record an Amendment block (byte-sync protocol).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/mcp src/testing/mcp-client.ts
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(mcp): envelope bridge + server builder (D-jj)"
```

## Task 4: The `/mcp` mount — same hook chain, drift exemption, seed tools

Mounts behind the existing hooks (auth/idempotency/rate-limit all inherit into the scope — D-ii), registers `GET/POST/DELETE /mcp` (legacy session ops answered by the handler with 405, probed), adds the `MCP_ROUTES` drift exemption (D-ll), the idempotency `/mcp` skip (D-ii), and seeds the registry with `get_task`, `list_tasks`, `get_inbox` so identity/parity are provable NOW.

**Files:**

- Create: `src/adapters/mcp/http.ts`, `src/adapters/mcp/mount.ts`, `src/adapters/mcp/mount.test.ts`, `src/adapters/mcp/tools/index.ts`, `src/adapters/mcp/tools/tasks.ts`, `src/adapters/mcp/tools/discussion.ts`
- Modify: `src/adapters/rest/app.ts` (mount last), `src/adapters/rest/idempotency.ts` (+ pin in `idempotency.test.ts`), `src/adapters/rest/openapi-contract.test.ts`

- [ ] **Step 1: Failing mount test**

```ts
// src/adapters/mcp/mount.test.ts
import { describe, expect, it } from 'vitest'
import { makeTestApp } from '#root/testing/test-app'
import { openHttpMcp } from '#root/testing/mcp-client'

const seedQuestion = async (t: Awaited<ReturnType<typeof makeTestApp>>, assigneeHandle: string) => {
  const task = await t.app.inject({
    method: 'POST',
    url: '/tasks',
    headers: { authorization: `Bearer ${t.adminToken}` },
    payload: { title: 'seed' },
  })
  expect(task.statusCode).toBe(201)
  const thread = await t.app.inject({
    method: 'POST',
    url: `/tasks/${task.json().id}/threads`,
    headers: { authorization: `Bearer ${t.adminToken}` },
    payload: { kind: 'question', body: 'seeded?', assignee_handle: assigneeHandle },
  })
  expect(thread.statusCode).toBe(201)
}

describe('mcp mount (D-hh, D-ii)', () => {
  it('rejects unauthenticated connects through the SAME hook (problem+json 401)', async () => {
    const t = await makeTestApp()
    try {
      const baseUrl = await t.app.listen({ port: 0, host: '127.0.0.1' })
      const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client')
      const client = new Client(
        { name: 'x', version: '1.0.0' },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } }
      )
      await expect(
        client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)))
      ).rejects.toMatchObject({ code: 'CLIENT_HTTP_AUTHENTICATION' }) // era-specific class, match code (D-ii)
    } finally {
      await t.close()
    }
  })

  it('modern + legacy eras both serve get_inbox; result mirrors REST byte-for-byte; views are per-actor', async () => {
    const t = await makeTestApp()
    try {
      const baseUrl = await t.app.listen({ port: 0, host: '127.0.0.1' })
      await seedQuestion(t, 'a_nils') // inbox row for the seeded human actor (D-r)
      const modern = await openHttpMcp(baseUrl, t.adminToken, '2026-07-28')
      const legacy = await openHttpMcp(baseUrl, t.adminToken)
      const rest = await t.app.inject({
        method: 'GET',
        url: '/inbox',
        headers: { authorization: `Bearer ${t.adminToken}` },
      })
      expect(rest.statusCode).toBe(200)
      for (const mcp of [modern, legacy]) {
        const r = await mcp.call('get_inbox')
        expect(r.isError).toBeUndefined()
        expect(r.structuredContent).toEqual({ result: rest.json() }) // byte-parity, both eras
      }
      // per-actor isolation: a fresh AGENT sees an empty inbox while nils sees the seed
      const agent = await t.app.inject({
        method: 'POST',
        url: '/admin/actors',
        headers: { authorization: `Bearer ${t.adminToken}` },
        payload: { kind: 'agent', handle: 'a_iso', display_name: 'Iso' },
      })
      expect(agent.statusCode).toBe(201)
      const tok = await t.app.inject({
        method: 'POST',
        url: `/admin/actors/${agent.json().id}/tokens`,
        headers: { authorization: `Bearer ${t.adminToken}` },
        payload: { label: 'iso' },
      })
      expect(tok.statusCode).toBe(201)
      const iso = await openHttpMcp(baseUrl, tok.json().raw_token, '2026-07-28')
      expect((await iso.call('get_inbox')).structuredContent).toEqual({ result: [] })
      await modern.close()
      await legacy.close()
      await iso.close()
    } finally {
      await t.close()
    }
  })

  it('tools/list is exactly the Task-4 seed snapshot', async () => {
    const t = await makeTestApp()
    try {
      const baseUrl = await t.app.listen({ port: 0, host: '127.0.0.1' })
      const mcp = await openHttpMcp(baseUrl, t.adminToken, '2026-07-28')
      const listed = await mcp.list()
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        'get_inbox',
        'get_task',
        'list_tasks',
      ])
      await mcp.close()
    } finally {
      await t.close()
    }
  })

  it('transport surface: GET/DELETE → handler 405; malformed POST body → JSON-RPC -32700 (buffer parser kept)', async () => {
    const t = await makeTestApp()
    try {
      const baseUrl = await t.app.listen({ port: 0, host: '127.0.0.1' })
      for (const method of ['GET', 'DELETE'] as const) {
        const res = await fetch(`${baseUrl}/mcp`, {
          method,
          headers: { authorization: `Bearer ${t.adminToken}` },
        })
        expect(res.status).toBe(405)
      }
      const bad = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${t.adminToken}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: '{ not json',
      })
      expect(bad.status).toBe(400)
      expect((await bad.text()).includes('-32700')).toBe(true)
    } finally {
      await t.close()
    }
  })
})
```

The `list` line of `openHttpMcp` ships with the Task-3 harness; no RED is claimed for this test beyond "mount does not exist".

- [ ] **Step 2: Verify RED** — `pnpm test src/adapters/mcp/mount.test.ts` → fails: mount absent (`/mcp` 404s, imports unresolvable).

- [ ] **Step 3: Implement `http.ts`** (probe-verbatim; cast comments kept)

```ts
// src/adapters/mcp/http.ts — Node http ⇄ Web Request/Response, probed end-to-end (D-hh)
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import type { FastifyReply, FastifyRequest } from 'fastify'

const HOP_BY_HOP = new Set([
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'host',
  'expect',
])

// ALL non-hop-by-hop headers forward verbatim — the 2026-07-28 leg enforces the
// Mcp-Method/Mcp-Name header⇄body mirror; allow-lists break it (probed).
export const webRequestFromFastify = (
  req: FastifyRequest,
  rawBody: Uint8Array | undefined
): Request => {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase()) || value === undefined) continue
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one)
  }
  const isBodyless = req.method === 'GET' || req.method === 'HEAD'
  // Buffer ⇄ BodyInit gap under @types/node: the cast is a type lie, bytes ride intact.
  const body: BodyInit | undefined = isBodyless
    ? undefined
    : ((rawBody ?? new Uint8Array(0)) as unknown as BodyInit)
  return new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, {
    method: req.method,
    headers,
    body,
  })
}

export const writeWebResponseToFastify = async (
  webRes: Response,
  reply: FastifyReply
): Promise<void> => {
  const raw = reply.raw
  const headers: Record<string, string | string[]> = {}
  webRes.headers.forEach((value, name) => {
    if (name.toLowerCase() !== 'set-cookie') headers[name] = value
  })
  const setCookie = webRes.headers.getSetCookie()
  if (setCookie.length > 0) headers['set-cookie'] = setCookie
  raw.writeHead(webRes.status, headers)
  if (!webRes.body) {
    raw.end()
    return
  }
  // pipe honors backpressure — required if a handler ever upgrades to SSE (probed).
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(webRes.body as unknown as NodeReadableStream<Uint8Array>)
      .on('error', reject)
      .on('end', resolve)
      .pipe(raw)
  })
}
```

- [ ] **Step 4: Implement `mount.ts`**

```ts
// src/adapters/mcp/mount.ts
import { createMcpHandler } from '@modelcontextprotocol/server'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ActorContext } from '#root/application/ports'
import { mcpTools } from '#root/adapters/mcp/tools/index'
import { buildMcpServer } from '#root/adapters/mcp/server'
import { webRequestFromFastify, writeWebResponseToFastify } from '#root/adapters/mcp/http'
import { DomainError } from '#root/domain/errors'
import type { AppDeps } from '#root/main/deps'

// Identity arrives from the hook chain — same message as actorCtx (auth.ts:32),
// no second doctrine, no token re-lookup (D-ii). Unreachable in practice:
// PUBLIC_PATHS excludes /mcp, so the onRequest hook already 401'd.
const mcpActor = (request: FastifyRequest): ActorContext => {
  if (!request.actorRef) throw new DomainError('unauthenticated', 'authentication required')
  return { actor: request.actorRef, tokenId: request.tokenId }
}

export const mountMcp = (app: FastifyInstance, deps: AppDeps): void => {
  // Encapsulated scope: removeAllContentTypeParsers + the raw '*' parser are
  // SCOPE-LOCAL (REST keeps the built-in JSON parser — probe lesson: '*' alone
  // does NOT override it). Hooks inherit downward, so auth → idempotency →
  // rate-limit guard /mcp in the same order as REST (D-ii). GET/DELETE exist so
  // the 2025-era session ops reach the handler's 405, not fastify's 404.
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, payload, done) =>
      done(null, payload as Uint8Array)
    )
    scope.route({
      method: ['GET', 'POST', 'DELETE'],
      url: '/mcp',
      handler: async (request, reply: FastifyReply) => {
        const ctx = mcpActor(request) // before hijack: the defensive 401 stays problem+json
        const webRequest = webRequestFromFastify(request, request.body as Uint8Array | undefined)
        reply.hijack() // MCP owns the socket
        // Fresh handler per request carries the identity in the factory closure —
        // ~1.7 ms, no leaked timers, no process-wide state (probed, D-hh).
        const handler = createMcpHandler(() => buildMcpServer(deps, ctx, mcpTools))
        try {
          await writeWebResponseToFastify(await handler.fetch(webRequest), reply)
        } catch (error) {
          request.log.error({ err: error }, 'mcp mount failed')
          if (!reply.raw.headersSent)
            reply.raw.writeHead(500, { 'content-type': 'application/json' })
          reply.raw.end('{"error":"mcp_mount"}')
        } finally {
          await handler.close().catch(() => undefined) // modern leg only; the stateless legacy leg holds nothing
        }
      },
    })
  })
}
```

- [ ] **Step 5: Wire `app.ts`, seed the registry**

`src/adapters/rest/app.ts` — after the last route registration line inside `buildApp`:

```ts
mountMcp(app, deps) // adapters/mcp — the /mcp surface (D-hh); keeps hook order intact
```

```ts
// src/adapters/mcp/tools/tasks.ts — Task 4 seeds; Task 5 completes the family
import { z } from 'zod'
import { defineTool } from '#root/adapters/mcp/bridge'
import { toTaskDto } from '#root/adapters/rest/dto'
import { DomainError } from '#root/domain/errors'
import type { AppDeps } from '#root/main/deps'
import type { ActorContext } from '#root/application/ports'

export const getTask = defineTool({
  name: 'get_task',
  description: 'Fetch one task as public JSON (mirrors GET /tasks/{id}).',
  input: z.object({ task_id: z.string() }),
  run: async (deps: AppDeps, _ctx: ActorContext, { task_id }) => {
    const row = await deps.tasksRoot.findWithCounts(task_id)
    if (!row) throw new DomainError('not_found', `task ${task_id} not found`) // ghost-404 verbatim
    return toTaskDto(row)
  },
})

export const listTasks = defineTool({
  name: 'list_tasks',
  description: 'All tasks as public JSON, position-ordered (mirrors GET /tasks).',
  input: z.object({}),
  run: async (deps) => (await deps.tasksRoot.listAllWithCounts()).map(toTaskDto),
})

export const TASK_TOOLS = [getTask, listTasks]
```

```ts
// src/adapters/mcp/tools/discussion.ts — Task 4 seeds get_inbox; Task 6 completes
import { z } from 'zod'
import { defineTool } from '#root/adapters/mcp/bridge'

export const getInbox = defineTool({
  name: 'get_inbox',
  description: 'The acting actor inbox, newest first (mirrors GET /inbox).',
  input: z.object({
    unread_only: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  // handler-side default 50 lives HERE because the REST handler owns it (D-mm)
  run: async (deps, ctx, q) =>
    deps.inboxRoot.listForActor(ctx.actor.id, {
      unreadOnly: q.unread_only ?? false,
      limit: q.limit ?? 50,
    }),
})

export const DISCUSSION_TOOLS = [getInbox]
```

```ts
// src/adapters/mcp/tools/index.ts — the frozen surface, grown Tasks 4–8
import type { McpTool } from '#root/adapters/mcp/bridge'
import { DISCUSSION_TOOLS } from './discussion'
import { TASK_TOOLS } from './tasks'

export const mcpTools: McpTool[] = [...TASK_TOOLS, ...DISCUSSION_TOOLS]
```

- [ ] **Step 6: Idempotency `/mcp` skip + pin (D-ii)**

In `src/adapters/rest/idempotency.ts`, at the top of the existing `onRequest` hook body:

```ts
// MCP is at-most-once JSON-RPC (D-ii): a hijacked response never fires onSend,
// so a reservation opened here could never complete. Not a new hook — a skip.
if (request.url.startsWith('/mcp')) return
```

Pin in `idempotency.test.ts` (append one test):

```ts
it('never reserves for /mcp — replayed keys there never 409 (D-ii)', async () => {
  const t = await makeTestApp()
  try {
    for (const _ of [1, 2]) {
      const r = await t.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${t.adminToken}`, 'idempotency-key': 'k-mcp' },
        payload: 'not json',
      })
      expect(r.statusCode).toBe(400) // JSON-RPC parse error, NOT idempotency_in_flight
    }
    const after = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { authorization: `Bearer ${t.adminToken}`, 'idempotency-key': 'k-mcp' },
      payload: { title: 'key was free' },
    })
    expect(after.statusCode).toBe(201) // the key was never reserved by the /mcp calls
  } finally {
    await t.close()
  }
})
```

(Note: the fastify default JSON parser would stringify the string payload `not json` — inject with `payload: 'not json'` + header `content-type: application/json` reaches the scope's buffer parser as raw bytes, mirroring the mount.test malformed case. If inject semantics fight this, use `JSON.stringify({ broken: true })`-free raw via `payload: Buffer.from('{ not json')` — the pin is: no 409 `idempotency_in_flight`, ever, for `/mcp`.)

- [ ] **Step 7: Drift-test exemption (D-ll)**

In `src/adapters/rest/openapi-contract.test.ts`, replace the `routeKeys ⇄ specKeys` comparison (and keep the loud out-of-grammar throw untouched) with:

```ts
// /mcp is the JSON-RPC transport mount — the yaml cannot describe MCP (D-ll).
// The exemption is an EXACT set: a fourth /mcp verb, or any non-/mcp route
// hidden here, fails the pin. The MCP surface is pinned by the tools-list
// snapshot + the §11.4 parity harness instead.
const MCP_ROUTES = ['DELETE /mcp', 'GET /mcp', 'POST /mcp']
const mcpPresent = routeKeys.filter((key) => key.endsWith(' /mcp')).sort()
expect(mcpPresent).toEqual(MCP_ROUTES)
expect(specKeys.some((key) => key.includes('/mcp'))).toBe(false)
expect(routeKeys.filter((key) => !mcpPresent.includes(key))).toEqual(specKeys)
```

- [ ] **Step 8: Green + full gates** — `pnpm test && pnpm lint && pnpm typecheck && pnpm build`. The drift suite passing with the exact-set pin IS the honest-green declaration for Step 7 (first-run green claimed, none invented).

- [ ] **Step 9: Commit**

```bash
git add src/adapters/mcp src/adapters/rest/app.ts src/adapters/rest/idempotency.ts src/adapters/rest/idempotency.test.ts src/adapters/rest/openapi-contract.test.ts
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(mcp): /mcp mount behind the same auth chain (D-hh, D-ii)"
```

## Task 5: Task-domain 1:1 tools (the byte-parity heart)

**Files:**

- Modify: `src/adapters/mcp/tools/tasks.ts` (add 10 tools, grow `TASK_TOOLS` to 12), `src/adapters/mcp/tools/index.ts` (untouched — registry grows via `TASK_TOOLS`)
- Test: `src/adapters/mcp/tools/tasks.test.ts`

**Transcription duty (before coding):** open `src/adapters/rest/routes/tasks.ts` and mirror each body schema's bounds into the zod objects below (min/max lengths, enums); the blocks below carry the field sets as of `2d6c7d8`. If shipped bounds differ, amend.

- [ ] **Step 1: Failing tests**

```ts
// src/adapters/mcp/tools/tasks.test.ts
import { describe, expect, it } from 'vitest'
import { TASK_TOOLS } from './tasks'
import { actorContextFor, openInMemoryPair } from '#root/testing/mcp-client'
import { makeTestApp } from '#root/testing/test-app'

const withMcp = async (
  fn: (
    mcp: Awaited<ReturnType<typeof openInMemoryPair>>,
    t: Awaited<ReturnType<typeof makeTestApp>>
  ) => Promise<void>
) => {
  const t = await makeTestApp()
  try {
    const ctx = await actorContextFor(t.deps, t.adminToken)
    const mcp = await openInMemoryPair(t.deps, ctx, TASK_TOOLS)
    try {
      await fn(mcp, t)
    } finally {
      await mcp.close()
    }
  } finally {
    await t.close()
  }
}

const jsonOf = (r: { content: unknown }) => JSON.parse((r.content[0] as { text: string }).text)

describe('task-domain tools (D-mm)', () => {
  it('create → get → list round-trip with the re-fetched TaskDto shape', () =>
    withMcp(async (mcp) => {
      const created = await mcp.call('create_task', { title: 'alpha', labels: ['ops'] })
      const task = (created.structuredContent as { result: { id: string } }).result
      expect(task).toMatchObject({
        title: 'alpha',
        status: 'todo',
        child_count: 0,
        unmet_blockers: 0,
      })
      const got = await mcp.call('get_task', { task_id: task.id })
      expect(got.structuredContent).toEqual(created.structuredContent) // same serializer, twice
      const listed = await mcp.call('list_tasks')
      expect((listed.structuredContent as { result: unknown[] }).result).toHaveLength(1)
      const ghost = await mcp.call('get_task', { task_id: 'ts_ghost' })
      expect(ghost.isError).toBe(true)
      expect(ghost.structuredContent).toEqual({ code: 'not_found', status: 404 })
      expect(jsonOf(ghost)).toEqual(ghost.structuredContent) // text ⇄ structuredContent mirror (D-jj)
    }))

  it('update_task discards the uc return and re-fetches (counts ride)', () =>
    withMcp(async (mcp) => {
      const parent = await mcp.call('create_task', { title: 'p' })
      const pid = (parent.structuredContent as { result: { id: string } }).result.id
      await mcp.call('create_task', { title: 'c', parent_id: pid })
      const patched = await mcp.call('update_task', { task_id: pid, patch: { description: 'why' } })
      const t2 = (patched.structuredContent as { result: { child_count: number } }).result
      expect(t2.child_count).toBe(1) // a bare UpdateTask return has NO counts — proof of re-fetch
    }))

  it('claim twice → second lands the FLAT already_claimed envelope (holder details ride)', () =>
    withMcp(async (mcp) => {
      const task = await mcp.call('create_task', { title: 'claimed?' })
      const id = (task.structuredContent as { result: { id: string } }).result.id
      const first = await mcp.call('claim_task', { task_id: id })
      expect(first.structuredContent).toMatchObject({
        result: { lease_token: expect.stringMatching(/:/), generation: expect.any(Number) },
      })
      const second = await mcp.call('claim_task', { task_id: id })
      expect(second.isError).toBe(true)
      expect(second.structuredContent).toEqual({
        code: 'already_claimed',
        status: 409,
        holder_handle: 'a_nils',
        holder_display_name: 'Nils',
        claimed: false,
      })
    }))

  it('bogus lease → 412 stale_lease with FLAT claimed: true (heartbeat and status)', () =>
    withMcp(async (mcp) => {
      const task = await mcp.call('create_task', { title: 'lease' })
      const id = (task.structuredContent as { result: { id: string } }).result.id
      const hb = await mcp.call('heartbeat_task', { task_id: id, lease_token: 'bogus:0' })
      expect(hb.structuredContent).toEqual({ code: 'stale_lease', status: 412, claimed: true })
      const st = await mcp.call('update_task_status', {
        task_id: id,
        to: 'in_progress',
        reason: 'go',
        lease_token: 'bogus:0',
      })
      expect(st.structuredContent).toEqual({ code: 'stale_lease', status: 412, claimed: true })
    }))

  it('status happy path re-fetches TaskDto; blocks round-trip as {result:null} (204 analog)', () =>
    withMcp(async (mcp) => {
      const a = await mcp.call('create_task', { title: 'a' })
      const b = await mcp.call('create_task', { title: 'b' })
      const [ida, idb] = [a, b].map(
        (r) => (r.structuredContent as { result: { id: string } }).result.id
      )
      const moved = await mcp.call('update_task_status', {
        task_id: ida,
        to: 'in_progress',
        reason: 'started',
      })
      expect(moved.structuredContent).toMatchObject({ result: { status: 'in_progress' } })
      const blocked = await mcp.call('add_block', { task_id: ida, blocker_id: idb })
      expect(blocked.structuredContent).toEqual({ result: null })
      const ready = await mcp.call('list_ready_tasks')
      expect((ready.structuredContent as { result: unknown[] }).result).toHaveLength(1) // only b
      const [ctxBundle] = [
        (await mcp.call('get_task_context', { task_id: ida })).structuredContent as {
          result: { blockers: unknown[]; task: { id: string } }
        },
      ]
      expect(ctxBundle.result.task.id).toBe(ida)
      expect(ctxBundle.result.blockers).toHaveLength(1) // un-DTO'd bundle (D-mm)
      expect(
        (await mcp.call('remove_block', { task_id: ida, blocker_id: idb })).structuredContent
      ).toEqual({ result: null })
    }))

  it('release returns the re-fetched TaskDto (claim fields cleared)', () =>
    withMcp(async (mcp) => {
      const task = await mcp.call('create_task', { title: 'release me' })
      const id = (task.structuredContent as { result: { id: string } }).result.id
      await mcp.call('claim_task', { task_id: id })
      const rel = await mcp.call('release_task', { task_id: id })
      expect(rel.structuredContent).toMatchObject({
        result: { claim_token_id: null, status: 'in_progress' },
      })
    }))
})
```

Expected-first-run notes: `holder_handle: 'a_nils', holder_display_name: 'Nils'` — the harness seeds exactly that human (repo-map §5); adjust ONLY if `makeTestApp` seeds differ (then amend — do not guess).

- [ ] **Step 2: Verify RED** — new-tool calls land `Tool not found` (`isError` true), not envelopes.

- [ ] **Step 3: Implement the 10 tools** (append to `tasks.ts`; every body transcribes its REST twin incl. re-fetch sites)

```ts
import { TASK_STATUSES } from '#root/domain/task'

export const createTask = defineTool({
  name: 'create_task',
  description: 'Create a task (mirrors POST /tasks; re-fetched TaskDto).',
  input: z.object({
    title: z.string(),
    description: z.string().optional(),
    acceptance_criteria: z.string().optional(),
    parent_id: z.string().optional(),
    labels: z.array(z.string()).optional(),
  }),
  run: async (deps, ctx, body) => {
    const task = await deps.useCases.createTask.run({ ...body, ...ctx })
    return toTaskDto((await deps.tasksRoot.findWithCounts(task.id))!) // REST re-fetch site
  },
})

export const updateTask = defineTool({
  name: 'update_task',
  description: 'Patch task fields (mirrors PATCH /tasks/{id}; uc return discarded per REST).',
  input: z.object({
    task_id: z.string(),
    patch: z.object({
      title: z.string().optional(),
      description: z.string().optional(),
      acceptance_criteria: z.string().optional(),
      assignee_id: z.string().nullable().optional(),
      blocked_flag: z.boolean().optional(),
    }),
  }),
  run: async (deps, ctx, { task_id, patch }) => {
    await deps.useCases.updateTask.run({ taskId: task_id, patch, ...ctx })
    return toTaskDto((await deps.tasksRoot.findWithCounts(task_id))!)
  },
})

export const updateTaskStatus = defineTool({
  name: 'update_task_status',
  description: 'Move a task along the board (mirrors PATCH /tasks/{id}/status).',
  input: z.object({
    task_id: z.string(),
    to: z.enum(TASK_STATUSES),
    reason: z.string().min(1),
    lease_token: z.string().optional(),
  }),
  run: async (deps, ctx, { task_id, to, reason, lease_token }) => {
    const task = await deps.useCases.updateStatus.run({
      taskId: task_id,
      to,
      reason,
      lease_token,
      ...ctx,
    })
    return toTaskDto((await deps.tasksRoot.findWithCounts(task.id))!)
  },
})

export const claimTask = defineTool({
  name: 'claim_task',
  description:
    'Atomically claim a ready task, receiving its lease (mirrors POST /tasks/{id}/claim).',
  input: z.object({ task_id: z.string() }),
  run: async (deps, ctx, { task_id }) => deps.useCases.claimTask.run({ taskId: task_id, ...ctx }),
})

export const releaseTask = defineTool({
  name: 'release_task',
  description: 'Release your claim (mirrors POST /tasks/{id}/release).',
  input: z.object({ task_id: z.string() }),
  run: async (deps, ctx, { task_id }) => {
    const task = await deps.useCases.releaseClaim.run({ taskId: task_id, ...ctx })
    return toTaskDto((await deps.tasksRoot.findWithCounts(task.id))!)
  },
})

export const heartbeatTask = defineTool({
  name: 'heartbeat_task',
  description: 'Refresh a claim lease (mirrors POST /tasks/{id}/heartbeat).',
  input: z.object({ task_id: z.string(), lease_token: z.string() }),
  run: async (deps, ctx, { task_id, lease_token }) => {
    const task = await deps.useCases.heartbeat.run({ taskId: task_id, lease_token, ...ctx })
    return toTaskDto((await deps.tasksRoot.findWithCounts(task.id))!)
  },
})

export const listReadyTasks = defineTool({
  name: 'list_ready_tasks',
  description: 'Ready work — leaf, todo, unblocked, unclaimed (mirrors GET /tasks/next).',
  input: z.object({
    label: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  run: async (deps, _ctx, { label, limit }) =>
    (await deps.useCases.getNext.run({ label, limit })).map(toTaskDto),
})

export const getTaskContext = defineTool({
  name: 'get_task_context',
  description:
    'The one-call bundle for working a task (mirrors GET /tasks/{id}/context; spec-fixed shape).',
  input: z.object({ task_id: z.string() }),
  run: async (deps, _ctx, { task_id }) => deps.useCases.getContext.run({ taskId: task_id }),
})

export const addBlock = defineTool({
  name: 'add_block',
  description: 'Blocker edge task blocked-by blocker (mirrors PUT /tasks/{id}/blocks/{blockerId}).',
  input: z.object({ task_id: z.string(), blocker_id: z.string() }),
  run: async (deps, ctx, { task_id, blocker_id }) => {
    await deps.useCases.addBlock.run({ taskId: task_id, blocker_id, ...ctx })
  },
})

export const removeBlock = defineTool({
  name: 'remove_block',
  description: 'Remove a blocker edge (mirrors DELETE /tasks/{id}/blocks/{blockerId}).',
  input: z.object({ task_id: z.string(), blocker_id: z.string() }),
  run: async (deps, ctx, { task_id, blocker_id }) => {
    await deps.useCases.removeBlock.run({ taskId: task_id, blocker_id, ...ctx })
  },
})
```

and grow: `export const TASK_TOOLS = [getTask, listTasks, createTask, updateTask, updateTaskStatus, claimTask, releaseTask, heartbeatTask, listReadyTasks, getTaskContext, addBlock, removeBlock]` (12).

Field-name pin duty: use-case input keys (`taskId`, `blocker_id`, `lease_token`, `to`, `reason`…) follow `src/application/usecases/*` as-of `2d6c7d8`; if a key differs at compile time, fix to the port and amend.

- [ ] **Step 4: Green + gates** — `pnpm test && pnpm lint && pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/mcp/tools/tasks.ts src/adapters/mcp/tools/tasks.test.ts
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(mcp): task-domain 1:1 tools (byte-parity, D-mm)"
```

## Task 6: Discussion + inbox tools

**Files:**

- Modify: `src/adapters/mcp/tools/discussion.ts` (add 6 tools → `DISCUSSION_TOOLS` = 7)
- Test: `src/adapters/mcp/tools/discussion.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/adapters/mcp/tools/discussion.test.ts
import { describe, expect, it } from 'vitest'
import { DISCUSSION_TOOLS } from './discussion'
import { TASK_TOOLS } from './tasks'
import { actorContextFor, openInMemoryPair } from '#root/testing/mcp-client'
import { makeTestApp } from '#root/testing/test-app'

const ALL = [...TASK_TOOLS, ...DISCUSSION_TOOLS]

const withMcp = async (
  fn: (
    mcp: Awaited<ReturnType<typeof openInMemoryPair>>,
    t: Awaited<ReturnType<typeof makeTestApp>>
  ) => Promise<void>
) => {
  const t = await makeTestApp()
  try {
    const mcp = await openInMemoryPair(t.deps, await actorContextFor(t.deps, t.adminToken), ALL)
    try {
      await fn(mcp, t)
    } finally {
      await mcp.close()
    }
  } finally {
    await t.close()
  }
}
const result = <T>(r: { structuredContent?: unknown }) =>
  (r.structuredContent as { result: T }).result

describe('discussion + inbox tools (D-mm)', () => {
  it('note thread lands {thread, message}; list_threads nests messages; ghost-404 first', () =>
    withMcp(async (mcp) => {
      const ghost = await mcp.call('list_threads', { task_id: 'ts_ghost' })
      expect(ghost.structuredContent).toEqual({ code: 'not_found', status: 404 })
      const task = result<{ id: string }>(await mcp.call('create_task', { title: 'discuss' }))
      const made = result<{ thread: { id: string }; message: { body: string } }>(
        await mcp.call('create_thread', { task_id: task.id, kind: 'note', body: 'hello' })
      )
      expect(made.message.body).toBe('hello')
      const listed = result<{ thread: { id: string }; messages: unknown[] }[]>(
        await mcp.call('list_threads', { task_id: task.id })
      )
      expect(listed).toHaveLength(1)
      expect(listed[0]!.thread.id).toBe(made.thread.id)
      expect(listed[0]!.messages).toHaveLength(1)
    }))

  it('question lifecycle: assign → answer {message, thread} order → resolve; invalid transition pins question_transition', () =>
    withMcp(async (mcp) => {
      const task = result<{ id: string }>(await mcp.call('create_task', { title: 'gate' }))
      const q = result<{ thread: { id: string; state: string }; message: { id: string } }>(
        await mcp.call('create_thread', {
          task_id: task.id,
          kind: 'question',
          body: 'which port?',
          assignee_handle: 'a_nils',
        })
      )
      expect(q.thread.state).toBe('open')
      const answered = result<{ message: { id: string }; thread: { state: string } }>(
        await mcp.call('answer_question', { thread_id: q.thread.id, body: '8080' })
      )
      expect(answered.thread.state).toBe('answered')
      const invalid = await mcp.call('update_question', { thread_id: q.thread.id, state: 'open' })
      expect(invalid.isError).toBe(true)
      expect(invalid.structuredContent).toMatchObject({ code: 'question_transition', status: 409 })
      const resolved = result<{ state: string }>(
        await mcp.call('update_question', { thread_id: q.thread.id, state: 'resolved' })
      )
      expect(resolved.state).toBe('resolved')
    }))

  it('add_message appends, mark_inbox_read is {result:null} + unread_only view flips, unknown assignee matches the REST twin', () =>
    withMcp(async (mcp, t) => {
      const task = result<{ id: string }>(await mcp.call('create_task', { title: 'inbox' }))
      const q = result<{ thread: { id: string } }>(
        await mcp.call('create_thread', {
          task_id: task.id,
          kind: 'question',
          body: 'ping?',
          assignee_handle: 'a_nils',
        })
      )
      const msg = result<{ seq: number }>(
        await mcp.call('add_message', { thread_id: q.thread.id, body: 'also' })
      )
      expect(msg.seq).toBe(2) // D-y per-thread seq
      const inbox = result<{ id: string; read: boolean }[]>(
        await mcp.call('get_inbox', { unread_only: true })
      )
      expect(inbox).toHaveLength(1)
      expect(
        (await mcp.call('mark_inbox_read', { item_id: inbox[0]!.id })).structuredContent
      ).toEqual({ result: null })
      expect((await mcp.call('get_inbox', { unread_only: true })).structuredContent).toEqual({
        result: [],
      })
      // unknown handle: MCP ⇄ REST same code+status out of the SHARED resolver (Task 2)
      const mcpErr = await mcp.call('create_thread', {
        task_id: task.id,
        kind: 'question',
        body: 'x',
        assignee_handle: 'a_ghost',
      })
      const restErr = await t.app.inject({
        method: 'POST',
        url: `/tasks/${task.id}/threads`,
        headers: { authorization: `Bearer ${t.adminToken}` },
        payload: { kind: 'question', body: 'x', assignee_handle: 'a_ghost' },
      })
      expect(mcpErr.structuredContent).toMatchObject({
        code: restErr.json().code,
        status: restErr.statusCode,
      })
    }))
})
```

- [ ] **Step 2: Verify RED** — `pnpm test src/adapters/mcp/tools/discussion.test.ts` → tool-not-found isErrors for the five new tools.

- [ ] **Step 3: Implement (append to `discussion.ts`, mirroring `routes/threads.ts` + `routes/inbox.ts` call sites exactly)**

```ts
import { DomainError } from '#root/domain/errors'
import { resolveActorHandle } from '#root/adapters/shared/resolve-handle'

export const listThreads = defineTool({
  name: 'list_threads',
  description: 'Task discussion as [{ thread, messages[] }] (mirrors GET /tasks/{id}/threads).',
  input: z.object({ task_id: z.string() }),
  run: async (deps, _ctx, { task_id }) => {
    const task = await deps.tasksRoot.findById(task_id)
    if (!task) throw new DomainError('not_found', `task ${task_id} not found`) // existence first — "no discussion" is not acceptable for a typo'd id
    return deps.threadsRoot.listForTask(task_id)
  },
})

export const createThread = defineTool({
  name: 'create_thread',
  description: 'Open a note or question thread (mirrors POST /tasks/{id}/threads).',
  input: z.object({
    task_id: z.string(),
    kind: z.enum(['note', 'question']),
    body: z.string().min(1),
    assignee_handle: z.string().min(1).max(60).optional(),
    meta_note: z.boolean().optional(),
  }),
  // handle→id via the SHARED resolver — the REST route uses the same function (D-nn: no grammar fork)
  run: async (deps, ctx, { task_id, kind, body, assignee_handle, meta_note }) => {
    const assigneeId =
      assignee_handle === undefined ? undefined : await resolveActorHandle(deps, assignee_handle)
    return deps.useCases.createThread.run({
      taskId: task_id,
      kind,
      body,
      assignee_id: assigneeId,
      metaNote: meta_note,
      ...ctx,
    })
  },
})

export const addMessage = defineTool({
  name: 'add_message',
  description: 'Append a message to a thread (mirrors POST /tasks/{id}/threads/{tid}/messages).',
  input: z.object({ thread_id: z.string(), body: z.string().min(1) }),
  run: async (deps, ctx, { thread_id, body }) =>
    deps.useCases.addMessage.run({ threadId: thread_id, body, ...ctx }),
})

export const answerQuestion = defineTool({
  name: 'answer_question',
  description:
    'Answer a question thread atomically (mirrors POST /tasks/{id}/threads/{tid}/answer).',
  input: z.object({ thread_id: z.string(), body: z.string().min(1) }),
  run: async (deps, ctx, { thread_id, body }) =>
    deps.useCases.answerQuestion.run({ threadId: thread_id, body, ...ctx }),
})

export const updateQuestion = defineTool({
  name: 'update_question',
  description: 'Transition / reassign a question (mirrors PATCH /tasks/{id}/threads/{tid}).',
  input: z.object({
    thread_id: z.string(),
    state: z.enum(['open', 'answered', 'resolved', 'wont_fix']).optional(),
    assignee_handle: z.string().min(1).max(60).optional(),
  }),
  run: async (deps, ctx, { thread_id, state, assignee_handle }) => {
    const assigneeId =
      assignee_handle === undefined ? undefined : await resolveActorHandle(deps, assignee_handle)
    return deps.useCases.updateQuestion.run({
      threadId: thread_id,
      state,
      assignee_id: assigneeId,
      ...ctx,
    })
  },
})

export const markInboxRead = defineTool({
  name: 'mark_inbox_read',
  description: 'Mark one inbox item read (mirrors POST /inbox/{id}/read; owner-only 404 doctrine).',
  input: z.object({ item_id: z.string() }),
  run: async (deps, ctx, { item_id }) => {
    await deps.useCases.markInboxRead.run({ itemId: item_id, ...ctx })
  },
})

export const DISCUSSION_TOOLS = [
  getInbox,
  listThreads,
  createThread,
  addMessage,
  answerQuestion,
  updateQuestion,
  markInboxRead,
]
```

Key pin duty: `kind`/`state` literal sets and use-case input keys (`assignee_id`, `metaNote`…) transcribed from `routes/threads.ts` + the use-case ports as of `2d6c7d8`; compile errors land in amendments, not guesses.

- [ ] **Step 4: Green + gates**, then commit:

```bash
git add src/adapters/mcp/tools/discussion.ts src/adapters/mcp/tools/discussion.test.ts
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(mcp): discussion + inbox tools (1:1, D-mm)"
```

## Task 7: Reference tools — links, labels, attachments, events, audit

**Files:**

- Modify: `src/adapters/mcp/tools/references.ts` (new), `src/adapters/mcp/tools/index.ts` (grow), `src/adapters/rest/routes/events.ts` (`toEvent` → exported const — zero behavior, the route keeps using it)
- Test: `src/adapters/mcp/tools/references.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/adapters/mcp/tools/references.test.ts
import { describe, expect, it } from 'vitest'
import { DISCUSSION_TOOLS } from './discussion'
import { REFERENCE_TOOLS } from './references'
import { TASK_TOOLS } from './tasks'
import { actorContextFor, openInMemoryPair } from '#root/testing/mcp-client'
import { makeTestApp } from '#root/testing/test-app'

const ALL = [...TASK_TOOLS, ...DISCUSSION_TOOLS, ...REFERENCE_TOOLS]
const withMcp = async (
  fn: (
    mcp: Awaited<ReturnType<typeof openInMemoryPair>>,
    t: Awaited<ReturnType<typeof makeTestApp>>
  ) => Promise<void>,
  overrides: NodeJS.ProcessEnv = {}
) => {
  const t = await makeTestApp(overrides)
  try {
    const mcp = await openInMemoryPair(t.deps, await actorContextFor(t.deps, t.adminToken), ALL)
    try {
      await fn(mcp, t)
    } finally {
      await mcp.close()
    }
  } finally {
    await t.close()
  }
}
const result = <T>(r: { structuredContent?: unknown }) =>
  (r.structuredContent as { result: T }).result

describe('reference tools (D-mm)', () => {
  it('links: insert-or-get always 201-class identical rows; ghost-404; remove → {result:null}', () =>
    withMcp(async (mcp) => {
      const task = result<{ id: string }>(await mcp.call('create_task', { title: 'refs' }))
      const ghost = await mcp.call('list_links', { task_id: 'ts_ghost' })
      expect(ghost.structuredContent).toEqual({ code: 'not_found', status: 404 })
      const first = result<{ id: string; url: string }>(
        await mcp.call('add_link', { task_id: task.id, kind: 'pr', url: 'https://example.test/1' })
      )
      const again = result<{ id: string }>(
        await mcp.call('add_link', { task_id: task.id, kind: 'pr', url: 'https://example.test/1' })
      )
      expect(again.id).toBe(first.id) // D-t insert-or-get
      expect(
        (await mcp.call('remove_link', { task_id: task.id, link_id: first.id })).structuredContent
      ).toEqual({ result: null })
    }))

  it('labels: create/list/attach/detach', () =>
    withMcp(async (mcp) => {
      const task = result<{ id: string }>(await mcp.call('create_task', { title: 'lab' }))
      const label = result<{ id: string; name: string }>(
        await mcp.call('create_label', { name: 'ops', color: '#fff' })
      )
      expect(
        result<unknown[]>(await mcp.call('list_labels')).map((l) => (l as { name: string }).name)
      ).toEqual(['ops'])
      expect(
        (await mcp.call('attach_label', { task_id: task.id, label_id: label.id })).structuredContent
      ).toEqual({ result: null })
      expect(
        (await mcp.call('detach_label', { task_id: task.id, label_id: label.id })).structuredContent
      ).toEqual({ result: null })
    }))

  it('attachments: upload exposes sha256 (D-s); content serves the UNSAFE_INLINE downgrade through the shared helpers', () =>
    withMcp(async (mcp) => {
      const task = result<{ id: string }>(await mcp.call('create_task', { title: 'files' }))
      const png = result<{ id: string; sha256: string }>(
        await mcp.call('upload_attachment', {
          task_id: task.id,
          filename: 'p.png',
          content_type: 'image/png',
          content_base64: Buffer.from('pretend-png').toString('base64'),
        })
      )
      expect(png.sha256).toMatch(/^[0-9a-f]{64}$/)
      const inline = result<{
        content_type: string
        content_disposition: string
        bytes_base64: string
      }>(await mcp.call('get_attachment_content', { attachment_id: png.id }))
      expect(inline.content_type).toBe('image/png')
      expect(inline.content_disposition).toBe('inline; filename="p.png"')
      expect(Buffer.from(inline.bytes_base64, 'base64').toString()).toBe('pretend-png')
      const svg = result<{ id: string }>(
        await mcp.call('upload_attachment', {
          task_id: task.id,
          filename: 's"1.svg',
          content_type: 'image/svg+xml',
          content_base64: Buffer.from('<svg/>').toString('base64'),
        })
      )
      const down = result<{
        content_type: string
        content_disposition: string
        x_content_type_options: string
      }>(await mcp.call('get_attachment_content', { attachment_id: svg.id }))
      expect(down.content_type).toBe('application/octet-stream')
      expect(down.content_disposition).toBe('attachment; filename="s_1.svg"') // shared safeFilename (Task 2)
      expect(down.x_content_type_options).toBe('nosniff')
    }))

  it('oversize upload → payload_too_large from the shared adapter vocabulary (D-jj)', () =>
    withMcp(
      async (mcp) => {
        const task = result<{ id: string }>(await mcp.call('create_task', { title: 'big' }))
        const big = await mcp.call('upload_attachment', {
          task_id: task.id,
          filename: 'b.bin',
          content_type: 'application/octet-stream',
          content_base64: Buffer.from('way too many bytes').toString('base64'),
        })
        expect(big.structuredContent).toEqual({ code: 'payload_too_large', status: 413 })
      },
      { NS_MAX_UPLOAD_BYTES: '4' }
    ))

  it('events carry cursor (AuditRow minus payloads); audit keeps before/after (D-aa)', () =>
    withMcp(async (mcp) => {
      const task = result<{ id: string }>(await mcp.call('create_task', { title: 'feed' }))
      const events = result<{ cursor: number; action: string }[]>(await mcp.call('get_events', {}))
      expect(events.length).toBeGreaterThan(0)
      const feedKeys = Object.keys(events[0]!).sort()
      expect(feedKeys).toEqual([
        'action',
        'actor_id',
        'created_at',
        'cursor',
        'entity_id',
        'entity_type',
        'reason',
        'token_id',
      ]) // NO before/after (D-aa)
      const audit = result<Record<string, unknown>[]>(
        await mcp.call('search_audit', { entity_type: 'task', entity_id: task.id })
      )
      expect(Object.keys(audit[0]!).sort()).toContain('before')
      expect(audit[0]!.action).toBe('task_created')
    }))
})
```

(`task_created` duty: transcribe the actual create audit action from `usecases/create-task.ts` at execution; amend if the shipped action string differs — do NOT reword anything.)

- [ ] **Step 2: Verify RED**, then implement.

- [ ] **Step 3: Export the FeedEvent mapper from its REST home (single source, D-mm):** in `routes/events.ts` change `const toEvent` to `export const toEvent` (no body change; the route keeps using it). The drift/behavior suite is the pin; no RED claimed.

- [ ] **Step 4: Implement `references.ts`**

```ts
// src/adapters/mcp/tools/references.ts
import { z } from 'zod'
import { McpEnvelopeError, defineTool } from '#root/adapters/mcp/bridge'
import { UNSAFE_INLINE, safeFilename } from '#root/adapters/shared/attachment-safety'
import { toEvent } from '#root/adapters/rest/routes/events'
import { DomainError } from '#root/domain/errors'

export const listLinks = defineTool({
  name: 'list_links',
  description: 'Task links, oldest first (mirrors GET /tasks/{id}/links).',
  input: z.object({ task_id: z.string() }),
  run: async (deps, _ctx, { task_id }) => {
    const task = await deps.tasksRoot.findById(task_id)
    if (!task) throw new DomainError('not_found', `task ${task_id} not found`)
    return deps.linksRoot.listForTask(task_id)
  },
})

export const addLink = defineTool({
  name: 'add_link',
  description: 'Attach a URL (insert-or-get, always success, D-t; mirrors POST /tasks/{id}/links).',
  input: z.object({
    task_id: z.string(),
    kind: z.enum(['pr', 'commit', 'doc', 'other']),
    url: z.string().url(),
  }),
  run: async (deps, ctx, { task_id, kind, url }) =>
    deps.useCases.addLink.run({ taskId: task_id, kind, url, ...ctx }),
})

export const removeLink = defineTool({
  name: 'remove_link',
  description: 'Remove a link (mirrors DELETE /tasks/{id}/links/{linkId}).',
  input: z.object({ task_id: z.string(), link_id: z.string() }),
  run: async (deps, ctx, { task_id, link_id }) => {
    await deps.useCases.removeLink.run({ taskId: task_id, linkId: link_id, ...ctx })
  },
})

export const listLabels = defineTool({
  name: 'list_labels',
  description: 'All labels by name (mirrors GET /labels).',
  input: z.object({}),
  run: async (deps) => deps.labelsRoot.list(),
})

export const createLabel = defineTool({
  name: 'create_label',
  description: 'Create a label (mirrors POST /labels).',
  input: z.object({ name: z.string(), color: z.string().optional() }),
  run: async (deps, ctx, body) => deps.useCases.createLabel.run({ ...body, ...ctx }),
})

export const attachLabel = defineTool({
  name: 'attach_label',
  description: 'Attach a label to a task (mirrors PUT /tasks/{id}/labels/{labelId}).',
  input: z.object({ task_id: z.string(), label_id: z.string() }),
  run: async (deps, ctx, { task_id, label_id }) => {
    await deps.useCases.attachLabel.run({ taskId: task_id, labelId: label_id, ...ctx })
  },
})

export const detachLabel = defineTool({
  name: 'detach_label',
  description: 'Detach a label (mirrors DELETE /tasks/{id}/labels/{labelId}).',
  input: z.object({ task_id: z.string(), label_id: z.string() }),
  run: async (deps, ctx, { task_id, label_id }) => {
    await deps.useCases.detachLabel.run({ taskId: task_id, labelId: label_id, ...ctx })
  },
})

export const listAttachments = defineTool({
  name: 'list_attachments',
  description:
    'Task attachments incl. sha256 (D-s nothing hidden; mirrors GET /tasks/{id}/attachments).',
  input: z.object({ task_id: z.string() }),
  run: async (deps, _ctx, { task_id }) => {
    const task = await deps.tasksRoot.findById(task_id)
    if (!task) throw new DomainError('not_found', `task ${task_id} not found`)
    return deps.attachmentsRoot.listForTask(task_id)
  },
})

export const uploadAttachment = defineTool({
  name: 'upload_attachment',
  description:
    'Upload a file as base64 (mirrors POST /tasks/{id}/attachments; MCP has no octet-stream body, D-mm).',
  input: z.object({
    task_id: z.string(),
    filename: z.string().min(1),
    content_type: z.string().min(1),
    content_base64: z.base64(),
  }),
  run: async (deps, ctx, { task_id, filename, content_type, content_base64 }) => {
    const content = Buffer.from(content_base64, 'base64')
    // REST enforces the cap at the route; MCP self-checks with the SAME config value
    // and the SAME adapter code name (D-mm/D-jj) — 413 never comes from zod.
    if (content.byteLength > deps.config.maxUploadBytes) {
      throw new McpEnvelopeError({ code: 'payload_too_large', status: 413 })
    }
    return deps.useCases.uploadAttachment.run({
      taskId: task_id,
      filename,
      contentType: content_type,
      content,
      ...ctx,
    })
  },
})

export const getAttachmentContent = defineTool({
  name: 'get_attachment_content',
  description:
    'Download an attachment as base64 with the computed safety headers (mirrors GET /attachments/{id}/content).',
  input: z.object({ attachment_id: z.string() }),
  run: async (deps, _ctx, { attachment_id }) => {
    const row = await deps.attachmentsRoot.find(attachment_id)
    if (!row) throw new DomainError('not_found', `attachment ${attachment_id} not found`)
    const bytes = await deps.files.get(row.sha256)
    if (!bytes) throw new DomainError('not_found', 'stored blob is missing') // second distinct 404, verbatim
    const safe = UNSAFE_INLINE.test(row.content_type)
    return {
      content_type: safe ? 'application/octet-stream' : row.content_type,
      content_disposition: `${safe ? 'attachment' : 'inline'}; filename="${safeFilename(row.filename)}"`,
      x_content_type_options: 'nosniff',
      bytes_base64: Buffer.from(bytes).toString('base64'),
    }
  },
})

export const getEvents = defineTool({
  name: 'get_events',
  description:
    'The audit-spine cursor feed, ascending (mirrors GET /events; cursor = audit_log.id, D-aa).',
  input: z.object({
    cursor: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  run: async (deps, _ctx, { cursor, limit }) =>
    (await deps.auditRoot.tail(cursor, limit)).map(toEvent),
})

export const searchAudit = defineTool({
  name: 'search_audit',
  description: 'Audit rows, newest first, payloads included (mirrors GET /audit).',
  input: z.object({
    entity_type: z.string().optional(),
    entity_id: z.string().optional(),
    limit: z.number().int().min(1).max(500).default(50),
  }),
  run: async (deps, _ctx, q) => deps.auditRoot.search(q),
})

export const REFERENCE_TOOLS = [
  listLinks,
  addLink,
  removeLink,
  listLabels,
  createLabel,
  attachLabel,
  detachLabel,
  listAttachments,
  uploadAttachment,
  getAttachmentContent,
  getEvents,
  searchAudit,
]
```

(`listAttachments` mirrors the ghost-404 idiom verbatim from `routes/attachments.ts:61-62` — existence first, the SAME message; the attachments suite is the behavior pin, no new RED claimed.)

`tools/index.ts` grows to:

```ts
import { COMPOSITE_TOOLS } from './composites' // added in Task 8
import { DISCUSSION_TOOLS } from './discussion'
import { REFERENCE_TOOLS } from './references'
import { TASK_TOOLS } from './tasks'

export const mcpTools: McpTool[] = [...TASK_TOOLS, ...DISCUSSION_TOOLS, ...REFERENCE_TOOLS]
```

- [ ] **Step 5: Green + gates**, then commit:

```bash
git add src/adapters/mcp src/adapters/rest/routes/events.ts
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(mcp): reference, attachment, event + audit tools (D-mm)"
```

## Task 8: Spec §7.1 composites (D-nn)

**Files:**

- Create: `src/adapters/mcp/tools/composites.ts`, `src/adapters/mcp/tools/composites.test.ts`
- Modify: `src/adapters/mcp/tools/index.ts` (add `...COMPOSITE_TOOLS` → registry = 35)

- [ ] **Step 1: Write the failing tests**

```ts
// src/adapters/mcp/tools/composites.test.ts
import { describe, expect, it } from 'vitest'
import { COMPOSITE_TOOLS } from './composites'
import { DISCUSSION_TOOLS } from './discussion'
import { REFERENCE_TOOLS } from './references'
import { TASK_TOOLS } from './tasks'
import { actorContextFor, openInMemoryPair } from '#root/testing/mcp-client'
import { makeTestApp } from '#root/testing/test-app'

const ALL = [...TASK_TOOLS, ...DISCUSSION_TOOLS, ...REFERENCE_TOOLS, ...COMPOSITE_TOOLS]
const withMcp = async (
  fn: (mcp: Awaited<ReturnType<typeof openInMemoryPair>>) => Promise<void>
) => {
  const t = await makeTestApp()
  try {
    const mcp = await openInMemoryPair(t.deps, await actorContextFor(t.deps, t.adminToken), ALL)
    try {
      await fn(mcp)
    } finally {
      await mcp.close()
    }
  } finally {
    await t.close()
  }
}
const result = <T>(r: { structuredContent?: unknown }) =>
  (r.structuredContent as { result: T }).result

describe('spec §7.1 composites (D-nn)', () => {
  it('claim_next: empty is data, then claims the first ready task atomically', () =>
    withMcp(async (mcp) => {
      expect(result(await mcp.call('claim_next'))).toEqual({
        claimed: false,
        task: null,
        claim: null,
      })
      await mcp.call('create_task', { title: 'work' })
      const got = result<{
        claimed: boolean
        task: { status: string }
        claim: { lease_token: string }
      }>(await mcp.call('claim_next'))
      expect(got.claimed).toBe(true)
      expect(got.task.status).toBe('in_progress') // D-a: claim flips todo→in_progress
      expect(got.claim.lease_token).toMatch(/:/) // "<task_id>:<generation>" (D-b)
    }))

  it('post_update: comment-only creates a note thread; with lease+status the full loop lands', () =>
    withMcp(async (mcp) => {
      const task = result<{ id: string }>(await mcp.call('create_task', { title: 'loop' }))
      const note = result<{ thread: { kind: string }; message: { body: string } }>(
        await mcp.call('post_update', { task_id: task.id, body: 'progress: half' })
      )
      expect(note.thread.kind).toBe('note')
      const claim = result<{ lease_token: string }>(
        await mcp.call('claim_task', { task_id: task.id })
      )
      const full = result<{ task: { status: string } }>(
        await mcp.call('post_update', {
          task_id: task.id,
          thread_id: note.thread.id,
          body: 'ready for review',
          lease_token: claim.lease_token,
          status: 'in_review',
          reason: 'work complete',
        })
      )
      expect(full.task.status).toBe('in_review')
    }))

  it('post_update: missing reason with status is invalid_request (no synthesized audit reason, D-nn)', () =>
    withMcp(async (mcp) => {
      const task = result<{ id: string }>(await mcp.call('create_task', { title: 'why' }))
      const err = await mcp.call('post_update', {
        task_id: task.id,
        body: 'x',
        status: 'in_progress',
      })
      expect(err.isError).toBe(true)
      expect(err.structuredContent).toEqual({
        code: 'invalid_request',
        status: 400,
        detail: 'status in post_update requires reason',
      })
    }))

  it('post_update is NOT transactional: a stale lease propagates AFTER the comment stayed booked (D-nn)', () =>
    withMcp(async (mcp) => {
      const task = result<{ id: string }>(await mcp.call('create_task', { title: 'partial' }))
      const err = await mcp.call('post_update', {
        task_id: task.id,
        body: 'booked',
        lease_token: 'bogus:0',
      })
      expect(err.structuredContent).toMatchObject({ code: 'stale_lease', status: 412 })
      const threads = result<{ messages: unknown[] }[]>(
        await mcp.call('list_threads', { task_id: task.id })
      )
      expect(threads[0]!.messages).toHaveLength(1) // the comment is in the board — no rollback fiction
    }))

  it('ask_question resolves the handle via the shared resolver and opens the gate question', () =>
    withMcp(async (mcp) => {
      const task = result<{ id: string }>(await mcp.call('create_task', { title: 'ask' }))
      const q = result<{ thread: { kind: string; state: string }; message: { body: string } }>(
        await mcp.call('ask_question', {
          task_id: task.id,
          text: 'which port?',
          assignee: 'a_nils',
        })
      )
      expect(q.thread).toMatchObject({ kind: 'question', state: 'open' })
      const ghost = await mcp.call('ask_question', {
        task_id: task.id,
        text: 'x',
        assignee: 'a_ghost',
      })
      expect(ghost.isError).toBe(true)
      expect(ghost.structuredContent).toMatchObject({ code: 'not_found', status: 404 })
    }))

  it('split_task mirrors POST /tasks/{id}/split verbatim (parent claim released, pinned reason rides)', () =>
    withMcp(async (mcp) => {
      const parent = result<{ id: string }>(await mcp.call('create_task', { title: 'parent' }))
      await mcp.call('claim_task', { task_id: parent.id })
      const split = result<{
        parent: { claim_token_id: string | null }
        created: { status: string }[]
      }>(
        await mcp.call('split_task', {
          task_id: parent.id,
          children: [{ title: 'child one' }, { title: 'child two', status: 'backlog' }],
        })
      )
      expect(split.parent.claim_token_id).toBeNull() // D-d release rides
      expect(split.created.map((c) => c.status)).toEqual(['todo', 'backlog']) // Dev-2 defaults
      const audit = result<{ reason: string }[]>(
        await mcp.call('search_audit', { entity_type: 'task', entity_id: parent.id })
      )
      expect(audit.some((a) => a.reason === 'claim released by split')).toBe(true) // grep-pinned string, forward-pinned (D-d)
    }))
})
```

- [ ] **Step 2: Verify RED** (composite tools not found).

- [ ] **Step 3: Implement `composites.ts`** — every composite is a plain sequence of the SAME use-case calls, nothing more (D-nn)

```ts
// src/adapters/mcp/tools/composites.ts
import { z } from 'zod'
import { defineTool } from '#root/adapters/mcp/bridge'
import { toTaskDto } from '#root/adapters/rest/dto'
import { TASK_STATUSES } from '#root/domain/task'
import { DomainError } from '#root/domain/errors'
import { resolveActorHandle } from '#root/adapters/shared/resolve-handle'

export const claimNext = defineTool({
  name: 'claim_next',
  description: 'Take the next ready task atomically (composite: next + claim, spec §7.1).',
  input: z.object({ label: z.string().optional() }),
  run: async (deps, ctx, { label }) => {
    const ready = await deps.useCases.getNext.run({ label, limit: 1 })
    if (ready.length === 0) return { claimed: false, task: null, claim: null } // empty is DATA (D-nn)
    const head = ready[0]!
    const claim = await deps.useCases.claimTask.run({ taskId: head.id, ...ctx }) // lost race ⇒ ordinary already_claimed FLAT envelope + D-cc inbox copy — no new string, no new code
    return {
      claimed: true,
      task: toTaskDto((await deps.tasksRoot.findWithCounts(head.id))!),
      claim,
    }
  },
})

export const postUpdate = defineTool({
  name: 'post_update',
  description:
    'Comment, optionally refresh the lease and move status — the §7.4 loop in one call (composite, spec §7.1).',
  input: z.object({
    task_id: z.string(),
    body: z.string().min(1),
    thread_id: z.string().optional(),
    lease_token: z.string().optional(),
    status: z.enum(TASK_STATUSES).optional(),
    reason: z.string().min(1).optional(),
  }),
  // Order: comment → heartbeat → status. NOT transactional (D-nn): each step is its
  // own use-case transaction; a propagating error leaves earlier steps booked.
  run: async (deps, ctx, a) => {
    let thread: unknown = null
    let message: unknown = null
    if (a.thread_id === undefined) {
      const created = await deps.useCases.createThread.run({
        taskId: a.task_id,
        kind: 'note',
        body: a.body,
        ...ctx,
      })
      thread = created.thread
      message = created.message
    } else {
      message = await deps.useCases.addMessage.run({ threadId: a.thread_id, body: a.body, ...ctx })
    }
    if (a.lease_token !== undefined) {
      await deps.useCases.heartbeat.run({ taskId: a.task_id, lease_token: a.lease_token, ...ctx })
    }
    if (a.status !== undefined) {
      if (a.reason === undefined) {
        throw new DomainError('invalid_request', 'status in post_update requires reason') // pinned test string — never reworded
      }
      await deps.useCases.updateStatus.run({
        taskId: a.task_id,
        to: a.status,
        reason: a.reason,
        ...ctx,
      })
    }
    return { thread, message, task: toTaskDto((await deps.tasksRoot.findWithCounts(a.task_id))!) }
  },
})

export const askQuestion = defineTool({
  name: 'ask_question',
  description:
    'Open a gate question for a human assignee (composite: handle + question thread, spec §7.1).',
  input: z.object({ task_id: z.string(), text: z.string().min(1), assignee: z.string().min(1) }),
  run: async (deps, ctx, { task_id, text, assignee }) => {
    const assigneeId = await resolveActorHandle(deps, assignee) // same resolver as REST (Task 2) — no grammar fork
    return deps.useCases.createThread.run({
      taskId: task_id,
      kind: 'question',
      body: text,
      assignee_id: assigneeId,
      ...ctx,
    })
  },
})

export const splitTask = defineTool({
  name: 'split_task',
  description: 'Atomically split a task into children (spec §7.1 name for POST /tasks/{id}/split).',
  input: z.object({
    task_id: z.string(),
    children: z
      .array(z.object({ title: z.string(), status: z.enum(TASK_STATUSES).optional() }))
      .min(1),
  }),
  run: async (deps, ctx, { task_id, children }) =>
    deps.useCases.splitTask.run({ taskId: task_id, children, ...ctx }),
})

export const COMPOSITE_TOOLS = [claimNext, postUpdate, askQuestion, splitTask]
```

SplitChildDraft key duty: transcribe the child draft's exact fields from `SplitTaskInput` (`src/application/ports.ts`) — the block carries `{title, status?}`; amend if the draft carries optional description/criteria (then mirror them — REST parity demands the same draft shape).

- [ ] **Step 4: Grow the registry to the frozen 35** — `tools/index.ts`:

```ts
export const mcpTools: McpTool[] = [
  ...TASK_TOOLS,
  ...DISCUSSION_TOOLS,
  ...REFERENCE_TOOLS,
  ...COMPOSITE_TOOLS,
]
```

- [ ] **Step 5: Green + gates**, then commit:

```bash
git add src/adapters/mcp
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(mcp): spec §7.1 composites (D-nn)"
```

## Task 9: `nightshift-client` — generated schema, drift pin, typed wrapper (D-kk)

**Files:**

- Create: `src/client/schema.d.ts` (generated + committed), `src/client/index.ts`, `src/client/drift.test.ts`, `src/client/client.test.ts`
- Modify: `package.json` (deps via pnpm + `gen:client` script)

- [ ] **Step 1: Write the failing tests**

```ts
// src/client/drift.test.ts — regeneration ⇄ committed artifact, byte-for-byte (D-kk)
import { execFile } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)

describe('nightshift-client drift pin (D-kk)', () => {
  it('committed schema.d.ts equals a fresh regen + prettier, byte-for-byte', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ns-client-drift-'))
    const tmp = join(dir, 'schema.d.ts')
    await run('pnpm', ['exec', 'openapi-typescript', 'openapi/openapi.yaml', '-o', tmp])
    await run('pnpm', ['exec', 'prettier', '--write', tmp])
    const fresh = await readFile(tmp)
    const committed = await readFile(new URL('./schema.d.ts', import.meta.url))
    expect(fresh.equals(committed)).toBe(true)
  }, 120_000)
})
```

```ts
// src/client/client.test.ts — the client is LOAD-BEARING (D-kk): smoke through the real app
import { describe, expect, it } from 'vitest'
import { createNightshiftClient } from './index'
import { makeTestApp } from '#root/testing/test-app'

// inject-backed fetch: zero sockets, the same hook chain (auth middleware rides a real
// Request, so the client exercises the same 401 path a network consumer would)
const injectFetch: typeof globalThis.fetch = async (input, init) => {
  const t = CURRENT
  const request = new Request(input, init)
  const url = new URL(request.url)
  const res = await t.app.inject({
    method: request.method as 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: `${url.pathname}${url.search}`,
    headers: Object.fromEntries(request.headers),
    ...(request.body === null ? {} : { body: Buffer.from(await request.arrayBuffer()) }),
  })
  return new Response(res.rawPayload, { status: res.statusCode, headers: res.headers })
}
let CURRENT: Awaited<ReturnType<typeof makeTestApp>>

describe('nightshift-client smoke (D-kk)', () => {
  it('creates via typed paths and branches on the problem code — no text parsing (spec §11 preamble)', async () => {
    CURRENT = await makeTestApp()
    try {
      const client = createNightshiftClient({
        baseUrl: 'http://nightshift.test',
        token: CURRENT.adminToken,
        fetch: injectFetch,
      })
      const created = await client.POST('/tasks', { body: { title: 'via client' } })
      expect(created.error).toBeUndefined()
      expect(created.data?.title).toBe('via client')
      const id = created.data!.id
      const first = await client.POST('/tasks/{id}/claim', { params: { path: { id } } })
      expect(first.error).toBeUndefined()
      const loser = await client.POST('/tasks/{id}/claim', { params: { path: { id } } })
      expect(loser.data).toBeUndefined()
      expect((loser.error as { code?: string }).code).toBe('already_claimed') // problem+json typed (D-kk probe-proven)
      expect((loser.error as { claimed?: boolean }).claimed).toBe(false) // FLAT details ride through typed
    } finally {
      await CURRENT.close()
    }
  })
})
```

Path keys: `openapi-typescript` names operations exactly as the yaml declares paths (`/tasks/{id}/claim`, params bag `params.path.id`) — if a key differs, the compiler says so: fix the call, never cast around it. The two casts on `loser.error` narrow the typed error union to the FLAT details the yaml `Problem` schema does not enumerate (`claimed`/`holder_*` ride the flat envelope, D-jj) — the smoke's own assertions pin them.

- [ ] **Step 2: Verify RED** (module absent; drift artifact absent).

- [ ] **Step 3: Install + generate + commit the artifact**

```bash
pnpm add openapi-fetch@0.17.0 && pnpm add -D openapi-typescript@7.13.0
node -e "const p=require('./package.json'); p.scripts['gen:client']='openapi-typescript openapi/openapi.yaml -o src/client/schema.d.ts && prettier --write src/client/schema.d.ts'; require('fs').writeFileSync('package.json', JSON.stringify(p,null,2)+'\n')"
pnpm gen:client
```

(`gen:client` = the D-kk script line, added via a one-shot node edit — same effect as hand-editing `package.json`; if the prettier invocation normalizes the whole file, keep that normalization, it's the formatter's own output. Alternative: edit `package.json` scripts by hand — same result.)

- [ ] **Step 4: Implement the wrapper**

```ts
// src/client/index.ts — nightshift-client (spec §7.1): generated paths + auth + problem-typed results
import createClient, { type Middleware } from 'openapi-fetch'
import type { paths } from './schema'

export interface NightshiftClientOptions {
  baseUrl: string
  token: string
  fetch?: typeof globalThis.fetch
}

// This module IS the spec's `nightshift-client`; extracting a publishable npm
// package is a later human call (D-kk). The drift test keeps `paths` pinned to the
// contract; consumers get typed data/error unions and nothing hand-rolled.
export const createNightshiftClient = (opts: NightshiftClientOptions) => {
  const client = createClient<paths>({
    baseUrl: opts.baseUrl,
    ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
  })
  const auth: Middleware = {
    onRequest({ request }) {
      request.headers.set('authorization', `Bearer ${opts.token}`)
      return request
    },
  }
  client.use(auth)
  return client
}

export type { paths } from './schema'
```

- [ ] **Step 5: Green + gates + build** (`tsc` compiles the committed `.d.ts`; `pnpm build` unaffected).

- [ ] **Step 6: Commit**

```bash
git add src/client package.json
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(client): generated schema + typed wrapper + drift pin (D-kk)"
```

## Task 10: §11.4 parity harness — every tool, success AND error, ⇄ REST

**Files:**

- Create: `src/adapters/rest/mcp-parity.test.ts`

Scope, stated once (pinned by the snapshot test, not hand-waved): the **31 mirrors + `split_task`** carry REST rows (spec §11.4); `claim_next`/`post_update`/`ask_question` are rest-less by definition — their §11.4 identity is the identity of their constituents, pinned in Task 8. SDK-level input-validation ⇄ REST-400 rows compare "rejected ⇄ rejected" (D-jj scope). Error rows are NON-CONSUMING where the doctrine allows (races resolved in favor of the REST call so both sides land the identical rejection; ghosts are perpetual).

- [ ] **Step 1: Harness + the full row table (write it, watch it pass — first-run green declared for the DATA rows exactly where the tool tasks already proved behavior; the ERROR rows are the new pins and every taxonomy mismatch fails loud)**

```ts
// src/adapters/rest/mcp-parity.test.ts — spec §11.4: each MCP tool ⇄ REST behavior identical
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mcpTools } from '#root/adapters/mcp/tools/index'
import { makeTestApp } from '#root/testing/test-app'
import { openHttpMcp } from '#root/testing/mcp-client'

type T = Awaited<ReturnType<typeof makeTestApp>>
type M = Awaited<ReturnType<typeof openHttpMcp>>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
interface World {
  t: T
  mcp: M
  bearer: string
  ids: Record<string, string>
}
interface Row {
  tool: string
  args: (w: World) => Record<string, unknown> // MCP-side args; ok/err/reject build the REST-side twin call
  ok?: {
    method: Method
    path: (w: World) => string
    body?: unknown
    headers?: Record<string, string>
  }
  err?: {
    mcpArgs: (w: World) => Record<string, unknown>
    rest: {
      method: Method
      path: (w: World) => string
      body?: unknown
      headers?: Record<string, string>
    }
  }
  // reject row: validation-class inputs — both sides merely REJECT (REST 400 ⇄ SDK input-validation);
  // comparing bodies across those two transport shapes is out of scope (D-jj), comparing rejection is not
  reject?: {
    mcpArgs: (w: World) => Record<string, unknown>
    rest: { method: Method; path: (w: World) => string; body?: unknown }
  }
}

// Write rows run REST on an R-fixture and MCP on an M-fixture (both seeded identical); bodies
// may legitimately differ only in per-resource identity — norm() removes exactly that.
// Everything that survives normalization must be EQUAL — that IS the pin.
// 'name' is volatile for the twin create_label rows (distinct fixture names); claim_generation,
// claim_token_id and sha256 are NOT volatile — fresh twin claims are generation-identical and the
// upload row pins the content hash; they MUST match.
const VOLATILE = new Set([
  'id',
  'created_at',
  'updated_at',
  'position',
  'lease_token',
  'last_heartbeat_at',
  'name',
  'parent_id',
  'thread_id',
  'task_id',
  'answer_message_id',
])
const norm = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(norm)
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => !VOLATILE.has(k))
        .map(([k, x]) => [k, norm(x)])
    )
  }
  return v
}
```

Harness core (write first, then the rows):

```ts
const flat = (b: Record<string, unknown>) => {
  const { type: _t, title: _ti, detail: _d, ...extras } = b
  return extras // compare the TAXONOMY + FLAT details, not transport prose (D-jj)
}

const restCall = async (
  w: World,
  r: {
    method: Method
    path: (w: World) => string
    body?: unknown
    headers?: Record<string, string>
  }
) => {
  const res = await w.t.app.inject({
    method: r.method,
    url: r.path(w),
    headers: { authorization: `Bearer ${w.bearer}`, ...(r.headers ?? {}) },
    ...(r.body === undefined ? {} : { payload: r.body }), // Buffer bodies ride raw (octet-stream upload rows)
  })
  return res
}

const expectOk = async (w: World, row: Row) => {
  const res = await restCall(w, row.ok!)
  expect(res.statusCode, `${row.tool} REST ok-side status`).toBeLessThan(300)
  const r = await w.mcp.call(row.tool, row.args(w))
  expect(r.isError, `${row.tool} ok-path errored: ${JSON.stringify(r.content)}`).toBeUndefined()
  const restBody = res.statusCode === 204 ? null : res.json()
  expect(norm((r.structuredContent as { result: unknown }).result)).toEqual(norm(restBody)) // D-jj: result ⇄ REST body modulo per-resource identity
}

const expectErr = async (w: World, row: Row) => {
  const res = await restCall(w, row.err!.rest)
  const r = await w.mcp.call(row.tool, row.err!.mcpArgs(w))
  expect(r.isError, `${row.tool} error-path succeeded`).toBe(true)
  expect(r.structuredContent).toEqual(flat(res.json() as Record<string, unknown>)) // byte-exact taxonomy + FLAT details (D-jj)
}

const expectReject = async (w: World, row: Row) => {
  const res = await restCall(w, row.reject!.rest)
  expect(res.statusCode, `${row.tool} REST reject-side accepted`).toBe(400)
  const r = await w.mcp.call(row.tool, row.reject!.mcpArgs(w))
  expect(r.isError, `${row.tool} MCP reject-side accepted`).toBe(true) // SDK input-validation shape — "rejected ⇄ rejected" only (D-jj)
}
```

World setup — `seedWorld` builds every fixture through the REST twin (admin), recording ids + seed leases:

```ts
const seedWorld = async (w: World) => {
  const api = async (
    method: Method,
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {}
  ) => {
    const res = await w.t.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${w.bearer}`, ...headers },
      ...(payload === undefined ? {} : { payload }),
    })
    expect(res.statusCode, `seed ${method} ${url} -> ${res.body}`).toBeLessThan(400)
    return res
  }
  const idOf = (res: { json(): unknown }) => String((res.json() as { id: string }).id)
  const ids = w.ids
  for (const [key, title] of [
    ['taskA', 'parity A'],
    ['taskB', 'parity B'],
    ['taskB2', 'parity B'],
    ['taskC', 'parity C'],
    ['taskC2', 'parity C'],
    ['taskD', 'parity D'],
    ['taskD2', 'parity D'],
    ['claimR', 'parity claim'],
    ['claimM', 'parity claim'],
    ['relR', 'parity rel'],
    ['relM', 'parity rel'],
    ['host', 'parity host'],
    ['hostM', 'parity host'],
    ['attachS', 'parity attach'],
  ] as const)
    ids[key] = idOf(await api('POST', '/tasks', { title }))
  await api('POST', `/tasks/${ids.taskA}/claim`) // the permanent already_claimed seed (holder = admin, the harness bearer)
  ids.leaseRelR = (
    (await api('POST', `/tasks/${ids.relR}/claim`)).json() as { lease_token: string }
  ).lease_token
  ids.leaseRelM = (
    (await api('POST', `/tasks/${ids.relM}/claim`)).json() as { lease_token: string }
  ).lease_token
  const newThread = async (hostKey: 'host' | 'hostM', payload: Record<string, unknown>) =>
    String(
      (
        (await api('POST', `/tasks/${ids[hostKey]}/threads`, payload)).json() as {
          thread: { id: string }
        }
      ).thread.id
    )
  ids.noteR = await newThread('host', { kind: 'note', body: 'seed note' })
  ids.noteM = await newThread('hostM', { kind: 'note', body: 'seed note' })
  ids.qR = await newThread('host', { kind: 'question', body: 'seed q?', assignee_handle: 'a_nils' })
  ids.qM = await newThread('hostM', {
    kind: 'question',
    body: 'seed q?',
    assignee_handle: 'a_nils',
  })
  ids.qA = await newThread('host', { kind: 'question', body: 'seed q?', assignee_handle: 'a_nils' })
  ids.qB = await newThread('hostM', {
    kind: 'question',
    body: 'seed q?',
    assignee_handle: 'a_nils',
  })
  ids.qE = await newThread('host', { kind: 'question', body: 'seed q?', assignee_handle: 'a_nils' })
  ids.qF = await newThread('hostM', {
    kind: 'question',
    body: 'seed q?',
    assignee_handle: 'a_nils',
  })
  await api('POST', `/tasks/${ids.host}/threads/${ids.qA}/answer`, { body: 'seed answer' }) // qA/qB answered (update_question ok-rows); qR/qM stay OPEN for answer_question; qE/qF stay open for the transition err
  await api('POST', `/tasks/${ids.hostM}/threads/${ids.qB}/answer`, { body: 'seed answer' })
  ids.lkR = idOf(
    await api('POST', `/tasks/${ids.host}/links`, {
      kind: 'other',
      url: 'https://parity.test/seed-r',
    })
  )
  ids.lkM = idOf(
    await api('POST', `/tasks/${ids.host}/links`, {
      kind: 'other',
      url: 'https://parity.test/seed-m',
    })
  )
  ids.labelS = idOf(await api('POST', '/labels', { name: 'parity-seed-label' }))
  const up = await w.t.app.inject({
    method: 'POST',
    url: `/tasks/${ids.host}/attachments?filename=seed.txt&content_type=text/plain`,
    headers: { authorization: `Bearer ${w.bearer}`, 'content-type': 'application/octet-stream' },
    payload: Buffer.from('seed bytes'),
  })
  expect(up.statusCode).toBe(201) // inline-disposition fixture for the get_attachment_content custom pin
  ids.att = String((up.json() as { id: string }).id)
  const inbox = (
    await w.t.app.inject({
      method: 'GET',
      url: '/inbox?limit=200',
      headers: { authorization: `Bearer ${w.bearer}` },
    })
  ).json() as { id: string; thread_id: string | null }[]
  ids.inboxR = inbox.find((i) => i.thread_id === ids.qA)!.id // a_nils IS the admin actor — assignment burned their own budget
  ids.inboxM = inbox.find((i) => i.thread_id === ids.qB)!.id
}
```

```ts
const ROWS: Row[] = [
  // ---- task family
  {
    tool: 'get_task',
    args: (w) => ({ task_id: w.ids.taskA }),
    ok: { method: 'GET', path: (w) => `/tasks/${w.ids.taskA}` },
    err: {
      mcpArgs: () => ({ task_id: 'ts_ghost' }),
      rest: { method: 'GET', path: () => '/tasks/ts_ghost' },
    },
  },
  { tool: 'list_tasks', args: () => ({}), ok: { method: 'GET', path: () => '/tasks' } },
  { tool: 'list_ready_tasks', args: () => ({}), ok: { method: 'GET', path: () => '/tasks/next' } },
  {
    tool: 'get_task_context',
    args: (w) => ({ task_id: w.ids.taskA }),
    ok: { method: 'GET', path: (w) => `/tasks/${w.ids.taskA}/context` },
    err: {
      mcpArgs: () => ({ task_id: 'ts_ghost' }),
      rest: { method: 'GET', path: () => '/tasks/ts_ghost/context' },
    },
  },
  {
    tool: 'create_task',
    args: () => ({ title: 'parity-row-create' }),
    ok: { method: 'POST', path: () => '/tasks', body: { title: 'parity-row-create' } },
  },
  {
    tool: 'update_task',
    args: (w) => ({ task_id: w.ids.taskB2, patch: { description: 'parity' } }),
    ok: { method: 'PATCH', path: (w) => `/tasks/${w.ids.taskB}`, body: { description: 'parity' } },
  }, // REST on taskB, tool on its twin taskB2 (D-mm: twins per side)
  {
    tool: 'update_task_status',
    args: (w) => ({ task_id: w.ids.taskC2, to: 'in_progress', reason: 'parity' }),
    ok: {
      method: 'PATCH',
      path: (w) => `/tasks/${w.ids.taskC}/status`,
      body: { to: 'in_progress', reason: 'parity' },
    },
    err: {
      mcpArgs: (w) => ({
        task_id: w.ids.taskA,
        to: 'in_review',
        reason: 'x',
        lease_token: 'bogus:0',
      }),
      rest: {
        method: 'PATCH',
        path: (w) => `/tasks/${w.ids.taskA}/status`,
        body: { to: 'in_review', reason: 'x', lease_token: 'bogus:0' },
      },
    },
    reject: {
      mcpArgs: (w) => ({ task_id: w.ids.taskA, to: 'not-a-status', reason: 'x' }),
      rest: {
        method: 'PATCH',
        path: (w) => `/tasks/${w.ids.taskA}/status`,
        body: { to: 'not-a-status', reason: 'x' },
      },
    },
  },
  {
    tool: 'claim_task',
    args: (w) => ({ task_id: w.ids.claimM }),
    ok: { method: 'POST', path: (w) => `/tasks/${w.ids.claimR}/claim` }, // twins claim independently — generation 1 on both (lease itself is volatile by rule)
    err: {
      mcpArgs: (w) => ({ task_id: w.ids.taskA }),
      rest: { method: 'POST', path: (w) => `/tasks/${w.ids.taskA}/claim` },
    },
  }, // taskA permanently claimed at seed — both sides land the identical already_claimed FLAT envelope (the deterministic race pin)
  {
    tool: 'heartbeat_task',
    args: (w) => ({ task_id: w.ids.relM, lease_token: w.ids.leaseRelM }),
    ok: {
      method: 'POST',
      path: (w) => `/tasks/${w.ids.relR}/heartbeat`,
      body: { lease_token: w.ids.leaseRelR },
    },
    err: {
      mcpArgs: (w) => ({ task_id: w.ids.taskA, lease_token: 'bogus:0' }),
      rest: {
        method: 'POST',
        path: (w) => `/tasks/${w.ids.taskA}/heartbeat`,
        body: { lease_token: 'bogus:0' },
      },
    },
  },
  {
    tool: 'release_task',
    args: (w) => ({ task_id: w.ids.relM }),
    ok: { method: 'POST', path: (w) => `/tasks/${w.ids.relR}/release` }, // AFTER heartbeat (ROW order) — releases the seed claims
    err: {
      mcpArgs: (w) => ({ task_id: w.ids.taskC2 }),
      rest: { method: 'POST', path: (w) => `/tasks/${w.ids.taskC}/release` },
    },
  }, // unclaimed release — same rejection both sides (no code prediction — live⇄live)
  {
    tool: 'add_block',
    args: (w) => ({ task_id: w.ids.taskB2, blocker_id: w.ids.taskC2 }),
    ok: { method: 'PUT', path: (w) => `/tasks/${w.ids.taskB}/blocks/${w.ids.taskC}` },
    err: {
      mcpArgs: (w) => ({ task_id: w.ids.taskB2, blocker_id: 'ts_ghost' }),
      rest: { method: 'PUT', path: (w) => `/tasks/${w.ids.taskB}/blocks/ts_ghost` },
    },
  },
  {
    tool: 'remove_block',
    args: (w) => ({ task_id: w.ids.taskB2, blocker_id: w.ids.taskC2 }),
    ok: { method: 'DELETE', path: (w) => `/tasks/${w.ids.taskB}/blocks/${w.ids.taskC}` },
  },
  {
    tool: 'split_task',
    args: (w) => ({ task_id: w.ids.taskD2, children: [{ title: 'parity child' }] }),
    ok: {
      method: 'POST',
      path: (w) => `/tasks/${w.ids.taskD}/split`,
      body: { children: [{ title: 'parity child' }] },
    },
    err: {
      mcpArgs: () => ({ task_id: 'ts_ghost', children: [{ title: 'x' }] }),
      rest: {
        method: 'POST',
        path: () => '/tasks/ts_ghost/split',
        body: { children: [{ title: 'x' }] },
      },
    },
  },
  // ---- discussion + inbox (host/hostM are leaf hosts for thread fixtures)
  {
    tool: 'list_threads',
    args: (w) => ({ task_id: w.ids.host }),
    ok: { method: 'GET', path: (w) => `/tasks/${w.ids.host}/threads` },
    err: {
      mcpArgs: () => ({ task_id: 'ts_ghost' }),
      rest: { method: 'GET', path: () => '/tasks/ts_ghost/threads' },
    },
  },
  {
    tool: 'create_thread',
    args: (w) => ({ task_id: w.ids.hostM, kind: 'note', body: 'parity note' }),
    ok: {
      method: 'POST',
      path: (w) => `/tasks/${w.ids.host}/threads`,
      body: { kind: 'note', body: 'parity note' },
    },
    err: {
      mcpArgs: (w) => ({
        task_id: w.ids.host,
        kind: 'question',
        body: 'x',
        assignee_handle: 'a_ghost',
      }),
      rest: {
        method: 'POST',
        path: (w) => `/tasks/${w.ids.host}/threads`,
        body: { kind: 'question', body: 'x', assignee_handle: 'a_ghost' },
      },
    },
  },
  {
    tool: 'add_message',
    args: (w) => ({ thread_id: w.ids.noteM, body: 'parity msg' }),
    ok: {
      method: 'POST',
      path: (w) => `/tasks/${w.ids.host}/threads/${w.ids.noteR}/messages`,
      body: { body: 'parity msg' },
    },
    err: {
      mcpArgs: () => ({ thread_id: 'th_ghost', body: 'x' }),
      rest: {
        method: 'POST',
        path: (w) => `/tasks/${w.ids.host}/threads/th_ghost/messages`,
        body: { body: 'x' },
      },
    },
  }, // both noteR/noteM seeded with one message → appended seq is 2 on both
  {
    tool: 'answer_question',
    args: (w) => ({ thread_id: w.ids.qM, body: 'parity answer' }),
    ok: {
      method: 'POST',
      path: (w) => `/tasks/${w.ids.host}/threads/${w.ids.qR}/answer`,
      body: { body: 'parity answer' },
    },
    err: {
      mcpArgs: (w) => ({ thread_id: w.ids.noteM, body: 'x' }),
      rest: {
        method: 'POST',
        path: (w) => `/tasks/${w.ids.hostM}/threads/${w.ids.noteM}/answer`,
        body: { body: 'x' },
      },
    },
  }, // answering a note thread — live⇄live rejection
  {
    tool: 'update_question',
    args: (w) => ({ thread_id: w.ids.qB, state: 'wont_fix' }), // qA/qB answered at seed → answered→wont_fix is D-n-legal on both
    ok: {
      method: 'PATCH',
      path: (w) => `/tasks/${w.ids.host}/threads/${w.ids.qA}`,
      body: { state: 'wont_fix' },
    },
    err: {
      mcpArgs: (w) => ({ thread_id: w.ids.qF, state: 'answered' }), // qE/qF open → open→answered out-of-band = question_transition on both (D-n)
      rest: {
        method: 'PATCH',
        path: (w) => `/tasks/${w.ids.host}/threads/${w.ids.qE}`,
        body: { state: 'answered' },
      },
    },
  },
  {
    tool: 'get_inbox',
    args: () => ({}),
    ok: { method: 'GET', path: () => '/inbox' },
    reject: {
      mcpArgs: () => ({ limit: 999 }),
      rest: { method: 'GET', path: () => '/inbox?limit=999' },
    },
  },
  {
    tool: 'mark_inbox_read',
    args: (w) => ({ item_id: w.ids.inboxM }),
    ok: { method: 'POST', path: (w) => `/inbox/${w.ids.inboxR}/read` }, // items from the qA/qB assignments (seed-captured)
    err: {
      mcpArgs: () => ({ item_id: 'ib_ghost' }),
      rest: { method: 'POST', path: () => '/inbox/ib_ghost/read' },
    },
  }, // owner-only 404 doctrine — ghost and not-owned identical (D-r)
  // ---- references
  {
    tool: 'list_links',
    args: (w) => ({ task_id: w.ids.host }),
    ok: { method: 'GET', path: (w) => `/tasks/${w.ids.host}/links` },
    err: {
      mcpArgs: () => ({ task_id: 'ts_ghost' }),
      rest: { method: 'GET', path: () => '/tasks/ts_ghost/links' },
    },
  },
  {
    tool: 'add_link',
    args: (w) => ({ task_id: w.ids.host, kind: 'doc', url: 'https://parity.test/harness' }),
    ok: {
      method: 'POST',
      path: (w) => `/tasks/${w.ids.host}/links`,
      body: { kind: 'doc', url: 'https://parity.test/harness' },
    }, // SAME (task,kind,url): D-t insert-or-get → the tool gets the REST-created row back → byte-equal including the id
    err: {
      mcpArgs: () => ({ task_id: 'ts_ghost', kind: 'doc', url: 'https://x.test' }),
      rest: {
        method: 'POST',
        path: () => '/tasks/ts_ghost/links',
        body: { kind: 'doc', url: 'https://x.test' },
      },
    },
  },
  {
    tool: 'remove_link',
    args: (w) => ({ task_id: w.ids.host, link_id: w.ids.lkM }),
    ok: { method: 'DELETE', path: (w) => `/tasks/${w.ids.host}/links/${w.ids.lkR}` }, // two seeded links, one per side
    err: {
      mcpArgs: (w) => ({ task_id: w.ids.host, link_id: 'lk_ghost' }),
      rest: { method: 'DELETE', path: (w) => `/tasks/${w.ids.host}/links/lk_ghost` },
    },
  },
  { tool: 'list_labels', args: () => ({}), ok: { method: 'GET', path: () => '/labels' } }, // no reachable 4xx — declared, none invented
  {
    tool: 'create_label',
    args: (w) => ({ name: 'parity-mcp', color: '#0a0a0a' }),
    ok: { method: 'POST', path: () => '/labels', body: { name: 'parity-rest', color: '#0a0a0a' } }, // distinct names (name is volatile by rule); record shape/color pinned
    reject: {
      mcpArgs: () => ({ color: '#fff' }),
      rest: { method: 'POST', path: () => '/labels', body: { color: '#fff' } },
    },
  },
  {
    tool: 'attach_label',
    args: (w) => ({ task_id: w.ids.attachS, label_id: w.ids.labelS }),
    ok: { method: 'PUT', path: (w) => `/tasks/${w.ids.host}/labels/${w.ids.labelS}` }, // same label, distinct targets
    err: {
      mcpArgs: (w) => ({ task_id: w.ids.attachS, label_id: 'lb_ghost' }),
      rest: { method: 'PUT', path: (w) => `/tasks/${w.ids.host}/labels/lb_ghost` },
    },
  },
  {
    tool: 'detach_label',
    args: (w) => ({ task_id: w.ids.attachS, label_id: w.ids.labelS }),
    ok: { method: 'DELETE', path: (w) => `/tasks/${w.ids.host}/labels/${w.ids.labelS}` },
  }, // AFTER attach (ROW order)
  {
    tool: 'list_attachments',
    args: (w) => ({ task_id: w.ids.host }),
    ok: { method: 'GET', path: (w) => `/tasks/${w.ids.host}/attachments` },
    err: {
      mcpArgs: () => ({ task_id: 'ts_ghost' }),
      rest: { method: 'GET', path: () => '/tasks/ts_ghost/attachments' },
    },
  },
  {
    tool: 'upload_attachment',
    args: (w) => ({
      task_id: w.ids.host,
      filename: 'parity.bin',
      content_type: 'application/octet-stream',
      content_base64: Buffer.from('parity bytes').toString('base64'),
    }),
    ok: {
      method: 'POST',
      path: () =>
        `/tasks/${w.ids.host}/attachments?filename=parity.bin&content_type=application/octet-stream`,
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from('parity bytes'),
    },
    err: {
      mcpArgs: () => ({
        task_id: 'ts_ghost',
        filename: 'x',
        content_type: 'text/plain',
        content_base64: Buffer.from('x').toString('base64'),
      }),
      rest: {
        method: 'POST',
        path: () => '/tasks/ts_ghost/attachments?filename=x&content_type=text/plain',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from('x'),
      },
    },
  }, // D-s insert-or-get: same (task,sha,filename) → the tool gets the REST row back — byte-equal incl. sha256
  {
    tool: 'get_events',
    args: () => ({ cursor: 0, limit: 500 }),
    ok: { method: 'GET', path: () => '/events?cursor=0&limit=500' },
  }, // no reachable 4xx — declared
  {
    tool: 'search_audit',
    args: (w) => ({ entity_type: 'task', entity_id: w.ids.taskA, limit: 50 }),
    ok: { method: 'GET', path: (w) => `/audit?entity_type=task&entity_id=${w.ids.taskA}&limit=50` },
  }, // payloads ride — byte under norm (D-aa)
]
```

**Order & honesty note:** vitest runs the registered pins in declaration order — the row-order dependencies (heartbeat→release, attach→detach, add_block→remove_block, get_inbox before mark_inbox_read, seed-answers before update_question) are structural, not incidental. No RED is claimed for the ok-table (the tools shipped green in Tasks 4–8; none is invented); the ERROR/REJECT rows are the new §11.4 pins, and every taxonomy mismatch fails loud.

```ts
describe('mcp ⇄ rest parity (spec §11.4)', () => {
  let w: World
  beforeAll(async () => {
    const t = await makeTestApp()
    const baseUrl = await t.app.listen({ port: 0, host: '127.0.0.1' })
    const mcp = await openHttpMcp(baseUrl, t.adminToken, '2026-07-28')
    w = { t, mcp, bearer: t.adminToken, ids: {} as Record<string, string> } as World
    await seedWorld(w) // the seedWorld block above: REST-inject creates + claim captures, ids filled
  }, 60_000)
  afterAll(async () => {
    await w.mcp.close()
    await w.t.close()
  })

  for (const row of ROWS) {
    if (row.ok)
      it(`${row.tool} ⇄ REST identical (success)`, async () => {
        await expectOk(w, row)
      })
    if (row.err)
      it(`${row.tool} ⇄ REST identical (error)`, async () => {
        await expectErr(w, row)
      })
    if (row.reject)
      it(`${row.tool} ⇄ REST rejected ⇄ rejected (D-jj scope)`, async () => {
        await expectReject(w, row)
      })
  }

  it('get_attachment_content ⇄ REST headers+bytes identical (binary ⇄ base64, D-mm)', async () => {
    const res = await w.t.app.inject({
      method: 'GET',
      url: `/attachments/${w.ids.att}/content`,
      headers: { authorization: `Bearer ${w.bearer}` },
    })
    expect(res.statusCode).toBe(200)
    const r = await w.mcp.call('get_attachment_content', { attachment_id: w.ids.att })
    const v = (r.structuredContent as { result: Record<string, string> }).result
    expect(String(res.headers['content-type'])).toBe(v.content_type)
    expect(String(res.headers['content-disposition'])).toBe(v.content_disposition)
    expect(String(res.headers['x-content-type-options'])).toBe(v.x_content_type_options)
    expect(v.bytes_base64).toBe(res.rawPayload.toString('base64'))
  })

  it('frozen tool surface: exactly 35 tools, no admin/webhook/token surface, ever (D-nn)', async () => {
    const listed = await w.mcp.list()
    const names = listed.tools.map((x) => x.name).sort()
    expect(names).toEqual([...mcpTools.map((x) => x.name)].sort()) // registry ⇄ wire ⇄ list all one set
    expect(names.filter((n) => /token|webhook|policy|actor/.test(n))).toEqual([]) // side-door pin (D-h precedent)
    expect(names.length).toBe(35)
  })

  it('strip-parity status quo: smuggled keys are STRIPPED both sides (removeAdditional doctrine)', async () => {
    const r = await w.mcp.call('create_task', { title: 'smuggle', smuggled_actor: 'evil' })
    expect(r.isError).toBeUndefined()
    expect(JSON.stringify(r)).not.toContain('evil')
  })

  it('/mcp burns the per-actor rate budget like any surface (D-dd doctrine)', async () => {
    const t2 = await makeTestApp({ NS_RATE_LIMIT_PER_MIN: '2' })
    try {
      const baseUrl = await t2.app.listen({ port: 0, host: '127.0.0.1' })
      for (let i = 1; i <= 2; i++) {
        const res = await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${t2.adminToken}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: '{',
        })
        expect(res.status).toBe(400) // MCP parse error — budget consumed
      }
      const third = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${t2.adminToken}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: '{',
      })
      expect(third.status).toBe(429) // rate_limited before the MCP layer — hook order intact
    } finally {
      await t2.close()
    }
  })
})
```

The **registry is the single source of the tool set**: the frozen-list `it` compares wire ⇄ registry ⇄ count — renaming or adding a tool fails THERE, and the frozen 35 are reviewed by @tyriis at sign-off (this line is the contract gate). `openHttpMcp.list` ships with the Task-3 harness.

- [ ] **Step 2: Run** — `pnpm test src/adapters/rest/mcp-parity.test.ts`. Every FAIL is a real fork: fix the TOOL (not the assertion) until identical; where the REST side itself surprises (key order irrelevant, `toEqual` ignores it), fix the tool's serializer usage per D-mm.

- [ ] **Step 3: Full gates**, then commit:

```bash
git add src/adapters/rest/mcp-parity.test.ts
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "test(acceptance): §11.4 mcp⇄rest parity harness, every tool"
```

## Task 11: Final whole-plan gate + record + STOP

**Files:**

- Modify: this header (final-gate record)

- [ ] **Step 1: Zero-churn proof (success criterion, not a ritual)**

Run: `git diff main --stat -- src/domain src/application openapi/ migrations.ts src/main/config.ts` → expect **empty**. The taxonomy stays one map because NOTHING touched it; if any line appears, the plan broke an invariant — stop and repair before gating.

- [ ] **Step 2: The gate**

Run: `pnpm test:coverage && pnpm lint && pnpm typecheck && pnpm build`
Expect: every axis ≥ baseline (Stmts 99.75 / Branch 98.06 / Funcs 100 / Lines 99.9 — never-lower HELD); documented-uncovered set unchanged plus at most honest `src/adapters/**` arms justified in the record below (global floor 85 far away). New test/file counts recorded honestly.

- [ ] **Step 3: Append the final-gate record to this header** (format: Plan C's — figures, uncovered-set delta with one-line justifications per new arm, "no new domain/contract files touched" line from Step 1 verbatim).

- [ ] **Step 4: Commit + STOP**

```bash
git add docs/superpowers/plans/2026-09-09-nightshift-plan-d-mcp-client.md
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "docs(plan): plan D final gate record"
```

Stop. Report to @tyriis. No push, no merge, no PR (binding).

---

## Execution handoff

Plan complete and saved. Two execution options (per the superpowers workflow):

1. **Subagent-Driven (recommended)** — fresh implementer subagent per task, independent spec + quality reviews before advancing, fix rounds re-verified by the same reviewer (the proven Plans A/B+C rhythm).
2. **Inline Execution** — `executing-plans` in-session with checkpoints.

Either way, the working agreements at the top of this file are part of every task, not suggestions — and per ticket #6, execution starts only after @tyriis signs off on this plan.
