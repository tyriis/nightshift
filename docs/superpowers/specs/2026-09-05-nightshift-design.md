# nightshift — Design Specification (v1)

Date: 2026-09-05
Status: draft for review
Repo: `~/projects/tyriis/nightshift`

## 1. Summary

nightshift is a self-hosted task board where humans and AI agents are **first-class,
equal actors**. A small circle of humans (family/friends) and any number of coding-agent
sessions (Claude Code, Codex, OpenCode, …) share one workspace: anyone can file,
discuss, split, and move tasks. The board is **passive** — it never executes or
dispatches agents; agents come to it through an OpenAPI REST interface and an MCP
server, claim work atomically, post progress, and hand results to humans for review.

Origin: build-it-our-own after a market survey (Sep 2026) found the human+agent board
category exists (Multica, Vikunja+veans, Plane) but no self-hosted, license-free tool
covered claim/lease semantics for *multi-instance* agents plus first-class decomposition
and question routing without license or SaaS strings.

## 2. Goals (v1)

1. Multi-user board for a small circle (≤ ~10 humans), one deployment, one workspace.
2. Agents are actors: assignable, attributable, wakeable — with tokens an admin creates.
3. Tree tasks: any task can be split into children; work happens on leaves only.
4. Question threads that are assignable to a human or agent and gate review.
5. Conflict-free multi-instance agents: atomic claim + fencing tokens.
6. OpenAPI-first public contract + MCP adapter; nothing hidden behind UI-only flows.
7. Runs on the homelab: single container + static UI, SQLite storage, zero external services.

## 3. Non-goals (v1)

- No agent run dispatch/orchestration (passive board — daemon/runner design lives later).
- No keepalive **enforcement** (heartbeat is recorded only; sweeper is deferred, see §12).
- No multi-workspace, no private/hidden tasks, no per-item ACLs.
- No email/mobile apps; no task-file (markdown) two-way sync.
- No Postgres support yet — only the port boundaries that make it possible later.

## 4. Decision record

| # | Decision | Choice | Why |
|---|----------|--------|-----|
| D1 | v1 audience | Small circle (family/friends), multi-user | Real accounts needed, but single deployment |
| D2 | Agent model | Passive board; agents visit via API/MCP | Avoids owning run orchestration; fits existing CLIs |
| D3 | System of record | Database-owned (SQLite, WAL) | Real threads/relations/notifications; git stays where work happens |
| D4 | Visibility | Nothing hidden: all actors see everything | Explicit product principle; roles are admin/member only |
| D5 | Decomposition | Parent tasks = same entity, `parent_id`, arbitrary depth; **no epics concept** | Splits emerge from escalated discussion; parent keeps all features |
| D6 | Work scope | Work only on leaves; parent with children is not claimable | One task, one claim holder, no ambiguity |
| D7 | Session ownership | Atomic claim returns fencing token; state transitions require it | Multi-instance safety from day one; lease/keepalive builds on it later |
| D8 | Grilling | Plain comments + `question` threads (assignable, stateful) — no exotic protocol | User explicitly declined a special protocol |
| D9 | Stack | TypeScript, n-tier/clean architecture | Swap SQLite→Postgres behind an infra port |
| D10 | API | OpenAPI 3.1 contract first; MCP mirrors it | Agents integrate via existing systems |
| D11 | Human auth | OIDC authorization code → cookie sessions (Pocket ID) | Already the homelab IdP |
| D12 | Agent auth | Admin-created API tokens (bearer) | Simple; revocable; per-actor audit |
| D13 | UI | Minimal web UI, SvelteKit (static) | Family won't curl the API; design polish deferred to build phase |
| D14 | Product license | Apache-2.0 for nightshift itself; permissive-license dependencies only | User may want to commercialize later; no AGPL runtime deps |

## 5. Actors and roles

- **Human**: signs in via OIDC. Roles: `admin`, `member`. Members can do everything
  except manage actors/tokens/policy.
- **Agent**: named actor created by an admin (display name, avatar, description,
  one or more tokens). Tokens: random 256-bit, stored hashed (SHA-256 — inputs are
  high-entropy, no slow-KDF needed), shown once, revocable; audit records which token acted.
- Both actor kinds appear identically in assignees, comments, audit, inbox routing.
- "Nothing hidden": every authenticated actor may read everything in the workspace.

## 6. Domain model

### 6.1 Task

Single `Task` entity (no epic type):

- `id`, `parent_id` (nullable, FK self), `position` (board order within siblings)
- `title`, `description` (markdown), **`acceptance_criteria`** (separate markdown field)
- `status`: `backlog | todo | in_progress | in_review | done | canceled` (soft-cancel only)
- `blocked_flag`: boolean, set/cleared manually by any actor (distinct from dependency-blocked, see 6.3)
- `assignee`: one actor (human | agent | none); `watchers`: actors
- `labels[]`, `created_by`, timestamps, soft-delete forbidden (cancel is terminal)

### 6.2 Tree and split

- Any task may be created as child of any task (`parent_id`); roots group the board.
- **`POST /tasks/{id}/split`** (atomic, transactional): creates N children from a
  template payload (each: title/description/AC/status), records audit entries linking
  parent↔children. MCP composite `split_task(id, children[])`.
- If the parent was `in_progress` with an active claim, the split **auto-releases the
  claim** (audit note "claim released by split"; generation bump invalidates the old
  fencing token) — the ex-claimant continues by claiming one of the children.
- **Conversation moves to the child**: after a split, new top-level threads on the
  parent are rejected with `409 threads_on_parent` (machine code) pointing at the
  children. Humans may force a `meta-note` (query flag in UI only, audited).

### 6.3 Dependencies

- Directed edges `A blocks B` with **cycle detection** (reject with `409 dependency_cycle`).
- A task is **dependency-blocked** if any direct blocker has status ≠ `done`; for a
  blocker that is a parent, it is satisfied only when that parent is `done` (which by
  invariant requires all its descendants done).
- `ready(task)` ≡ leaf (no children) ∧ `todo` ∧ not dependency-blocked ∧ not claimed ∧
  `blocked_flag` unset.

### 6.4 Invariants (enforced in domain layer, tested exhaustively)

1. **Leaf-claim**: claim requires no children (else `409 not_a_leaf`).
2. **Descendant-done**: a task cannot become `done` while any descendant is open
   (else `409 open_descendants`).
3. **Token-fenced writes**: all transitions of a task held by a claim require the
   claim's fencing token at its current generation (else `412 stale_lease`).
4. **Claim exclusivity**: at most one active claim per task (compare-and-swap; else
   `409 already_claimed` carrying the current holder's public identity).
5. **Review gate** (workspace policy, default on): only **human** actors may set
   `done`; agents may set `in_review`. `403 agent_close_forbidden`.
6. **Question gate**: an agent may not set `in_review` while an open question
   assigned to a *human* exists on that task (else `409 open_questions`).
7. **No cycles** in `blocks` and in `parent_id`.

### 6.5 Threads, notes, questions

- Each task has `threads[]` (top-level), each thread has ordered `messages[]`.
- Thread kind: `note` | `question`.
- Question: `assignee` (actor), `state: open → answered → resolved | wont_fix`,
  `answer_link` to a message. Assignee change = re-assignment, inbox event for new assignee.
- `@handle` mentions in any message route inbox entries (see 6.8).

### 6.6 Attachments and links

- File attachments per task (specs, plans, architecture docs): disk-backed storage
  behind a `FileStore` port (S3-portable later), content-addressed (sha256), size cap
  configurable. Markdown images served from attachments.
- External links per task (`pr`, `commit`, `doc`, `other` + URL) — used for PR handoff.

### 6.7 Audit log

Append-only. Every mutation: `(actor, actor_token_id, action, entity, before/after
summary, optional reason, timestamp)`. Status transitions always carry a machine-readable
reason (including "claim released by split", "lease expired" later). UI shows it as an
activity tab. Audit is the system's memory — never purged in v1.

### 6.8 Inbox & events

- Per-actor `InboxItem`: assigned / mentioned / question-assigned / claim-conflict.
  Read/unread state. No email in v1.
- Global **event feed**: monotonic cursor; `GET /events?cursor=…` returns task/thread/
  claim mutations (everything audit-worthy minus payloads). Agents tail it; UI polls it
  for live board updates (SSE wrapper later).
- **Webhooks**: admin registers per-agent callback URLs with secret; delivery of
  `{event, task_id, cursor}` best-effort with retries; used to wake agent runners
  ("task assigned to me" without the board doing the running).

## 7. Agent interface (API-first)

### 7.1 Contract

- **OpenAPI 3.1 spec in-repo is the product contract**; committed spec diff = API change.
- Generated TypeScript client ships in the repo (`nightshift-client`).
- **MCP server = thin adapter over the same use-cases**: 1:1 tools plus composites:
  `claim_next` (next + claim), `post_update` (comment + optional heartbeat + optional
  status), `ask_question(task, text, assignee)`, `split_task(id, children[])`.

### 7.2 Core endpoints (REST, bearer token for agents, cookie session for humans)

| Endpoint | Notes |
|---|---|
| `GET /tasks/next` | ready-work query; label filter; `POST /tasks/{id}/claim` is the atomic CAS |
| `POST /tasks/{id}/claim` | returns `lease_token` (generation-bearing fencing token) |
| `POST /tasks/{id}/release` | releases claim |
| `POST /tasks/{id}/heartbeat` | records liveness timestamp (no enforcement in v1) |
| `GET /tasks/{id}/context` | **one-call context bundle**: task + AC + ancestor chain (titles/AC) + open questions + unmet blockers + labels + attachments list + external links |
| `PATCH /tasks/{id}/status` | requires valid lease token when the task is claimed |
| `POST /tasks/{id}/split` | atomic children creation |
| `POST /tasks/{id}/threads`, `…/messages` | thread/message creation; 409 on parent |
| `GET /events?cursor=` | feed; `GET /inbox` per actor |
| CRUD | tasks, dependencies (`PUT/DELETE /tasks/{id}/blocks/{other}`), labels, attachments (upload), links, questions (state changes) |
| Admin | actors, tokens, policy flags, webhooks, audit search |

### 7.3 Idempotency

All non-idempotent methods accept `Idempotency-Key`; stored {key → response} replayed
for retries. This is a v1 requirement — agent sessions crash mid-request routinely.

### 7.4 Typical agent loop (success path)

```
GET  /tasks/next?label=infra
POST /tasks/NS-12/claim            → lease_token
GET  /tasks/NS-12/context             → spec, AC, parent discussion
POST /tasks/NS-12/threads (note)      "starting, plan: …"   + heartbeat
POST /tasks/NS-12/threads (question)  assigned @nils        → state open; gates review
POST /tasks/NS-12/split               (if scope grew)       → continue on a child
… work in git, open PR …
POST /tasks/NS-12/links {pr}          ; PATCH status → in_review (with reason)
human reviews, PATCH status → done
```

## 8. Human UI (v1 minimal)

SvelteKit static assets served by the same container. Views:

1. **Board**: columns = status; rows = swimlanes grouped by root task, collapsed
   subtree with rollup (`done-leaves / total-leaves`), filter chips: assignee, label, blocked, ready-only.
2. **Task detail**: header (status, assignee, labels), tabs:
   conversation (threads/notes/questions) · children tree · dependencies · attachments+links · activity (audit) · context.
3. **Inbox**: my items; jump-to-task.
4. **Admin**: humans (via OIDC first-login), agents + tokens, labels, policy flags, webhooks, audit search.
5. Login via OIDC; no registration page (admin enables accounts on first login or by allow-list).

Design polish is a build-phase concern (@designer); structure above is the requirement.

## 9. Architecture

Clean architecture, n-tier, one repo:

```
domain/        pure TS entities + invariants (§6.4). No imports from outer layers.
application/   use-cases (ClaimTask, SplitTask, AskQuestion, …) + ports:
               Clock, IdGen, EventBus, TaskRepo, AuditRepo, InboxRepo, FileStore,
               TokenHasher, DeliveryQueue
adapters/      rest/ (Fastify, OpenAPI-first), mcp/ (same use-cases), sveltekit/ (UI)
infra/         sqlite/ (Kysely + better-sqlite3, WAL mode), disk FileStore, in-proc
               event bus + outbox table → webhook delivery loop, migrations/
main/          single entrypoint wiring infra→app→adapters; env config (zod)
```

- SQLite in WAL mode; single-writer is fine at this scale; the **repo ports** keep the
  Postgres swap to `infra/postgres/`.
- FTS5 table for deferred search (built now, no UI yet) — nearly free with SQLite.
- Single Docker image (multi-stage build: UI static → server static-serve + API + MCP).
- Deployment to homelab (HelmRelease in home-ops) is a later build-plan phase.

## 10. Security

- OIDC RP with PKCE; sessions signed httpOnly cookies; CSRF token on state-changing
  browser requests. Agents: bearer only.
- Tokens hashed at rest; last-used timestamp; per-actor rate limit (configurable).
- File uploads: size cap, content-addressed, served with correct content-type; no
  HTML rendering from attachment origin.
- Audit integrity: append-only table; no delete/update paths exist for it.
- MCP server runs in-process behind the same auth middleware — same guards, no bypass.

## 11. Error handling & testing

**Errors**: RFC 9457 `application/problem+json` with stable `code` field for every
domain rejection (`already_claimed`, `not_a_leaf`, `open_descendants`,
`dependency_cycle`, `stale_lease`, `open_questions`, `agent_close_forbidden`,
`threads_on_parent`) so agents can branch on cause instead of parsing text.

**Testing**:

1. Domain unit + property tests: all §6.4 invariants, incl. split-under-claim and
   claim/release interleavings (model-based).
2. API integration tests on ephemeral SQLite: full happy loop (§7.4) + every 4xx code
   + idempotency replay + webhook delivery + event cursor replay.
3. Contract test: served routes vs committed OpenAPI spec (no drift).
4. Parity test: each MCP tool ⇄ REST behavior identical.
5. UI: Playwright smoke (login → board → task → comment → status).

## 12. Deferred backlog (design sketched, not built)

- **Keepalive enforcement**: lease carries `interval` + `timeout`; sweeper flags stale
  claims, then reverts task to `todo` with audit reason; fencing **generation**
  prevents a zombie session from committing after revert. (Heartbeat + token
  generations already exist in v1 to make this additive.)
- Agent capability scopes (tokens restricted to labels).
- Self-reported cost/effort fields at completion; per-agent stats.
- Run-transcript URL on claim.
- Forge webhooks (branch `NS-123` → link PR, propose close on merge).
- Task templates per root; scheduled autopilot tasks (cron-created audits).
- FTS-backed search UI, saved filters, undo/restore.
- CLI (`nightshift claim|report|next` via generated client); SSE feed wrapper; email.

## 13. Out of scope (standing)

Multi-workspace; private visibility; run dispatch/orchestration; Postgres; mobile;
markdown-file sync; billing; i18n.

## 14. v1 acceptance (end-to-end)

1. Two humans sign in via Pocket ID; admin creates Agent "hermes-1".
2. Human files task + uploads spec.md + acceptance criteria → `todo`.
3. Two concurrent agent sessions race to claim: exactly one wins (`409 already_claimed`).
4. Winner posts plan, splits task into 2 children, claim released, claims child.
5. Agent asks a question → gates review until human answers.
6. Agent links PR, sets `in_review`; other agent claims sibling; both humans close.
7. Audit log reconstructs the whole story; board shows rollups; zero hidden state.
