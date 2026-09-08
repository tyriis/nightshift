# nightshift Plan B — Threads, Questions & Review Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A curl-testable discussion layer on the shipped Plan A core: threads (notes + questions) with ordered messages and `@mention` routing, question lifecycle (`open → answered → resolved | wont_fix`) wired to the invariant-6 review gate (`409 open_questions`), per-actor inbox with read state, content-addressed attachments behind a `FileStore` port, and per-task external links — the conversation half of spec §14.

**Architecture:** Same clean-architecture seams as Plan A (`src/domain` pure, `src/application` use-cases + ports, `src/adapters/rest` Fastify, `src/infra/sqlite` Kysely). Plan A reserved the seams this plan fills: `open_questions`/`threads_on_parent` codes in `errors.ts` (already in the yaml enum and the drift-test pin), the invariant-6 seam comment in `update-status.ts`, and `TaskContextBundle.open_questions/links/attachments` typed `unknown[]` in `get-context.ts`. New ports: `ThreadRepo`, `InboxRepo`, `AttachmentRepo`, `LinkRepo`, `FileStore`.

**Tech Stack:** unchanged from Plan A — TypeScript (nodenext, strict), Node 24, Fastify 5.12.3, Kysely 0.29.5, better-sqlite3 13.0.3, zod 4.5.4, vitest 4. **No new runtime dependencies** (uploads are raw-body, not multipart).

**Spec:** `docs/superpowers/specs/2026-09-05-nightshift-design.md` — Plan B covers §6.2 (threads_on_parent + meta-note), §6.4.6 (invariant 6), §6.5 (threads/questions), §6.6 (attachments/links), §6.8 (inbox — see deferrals), §7.2 (thread/CRUD endpoints, context bundle completion), §10 (upload sanitization, per-actor rate limit), §14 steps 2/5/6 (agent-side).

**Inputs (all in-repo):** spec above; Plan A record `docs/superpowers/plans/2026-09-06-nightshift-plan-a-agent-core.md` (decision record D-a…D-l, Ruling A, amendment lineage); contract `openapi/openapi.yaml`; acceptance `src/adapters/rest/scenarios.test.ts`.

---

## Deliberately deferred (stated per ticket)

- **Event cursor feed (`GET /events?cursor=`), SSE wrapper, webhook delivery → Plan C.** Reasons: (1) the Plan A record already assigned event feed/webhooks to C ("Deliberately NOT in Plan A"); (2) they share one outbox/`EventBus`/`DeliveryQueue` infrastructure (spec §9) orthogonal to the discussion surface — slicing it half-in here designs a cursor table without its consumers; (3) spec §6.8 defers SSE itself ("SSE wrapper later") and §14 acceptance needs no async push — the inbox covers human-side visibility; agents poll `/tasks/next` as shipped. FTS5 stays in C (Plan A assignment). Plan B still helps C: `audit_log.id` stays the natural future cursor (append-only, already indexed by entity).
- **`claim-conflict` inbox item kind (§6.8 list) — deferred, D-s.** The race loser is present at the 409; `already_claimed` already carries `holder_handle`/`holder_display_name` (shipped, grep-pinned). An async copy adds nothing until runner wake paths exist (C).
- **Not touched:** MCP + generated client (D), OIDC/human login + UI (E), Docker incl. the `openapi/` asset-shipping backlog note (F), FTS search (C).
- **Per-actor rate limiting is NOT deferred** — Plan A assigned it "to Plan B with the other HTTP-surface work"; it lands as Task 14.

## Binding rulings inherited from Plan A (obey — do not re-litigate)

- `ready()` = leaf ∧ todo ∧ unblocked ∧ unclaimed ∧ ¬blocked_flag — **no parent-status gate** (Ruling A). This plan touches `ready`/`listReady` in no way.
- Claims: single-statement CAS with generation; release bumps generation; presented-but-dead lease ⇒ `stale_lease {claimed:false}`; absent lease on an unclaimed task stays allowed. Unchanged here.
- Split children: explicit status wins; backlog parent ⇒ backlog children, else `todo` — a default, never a gate. Unchanged here.
- Error taxonomy is one map: every new code goes in `src/domain/errors.ts` (`DOMAIN_ERROR_STATUS`) **and** the yaml `Problem.code` enum in the _same commit_ — the drift test turns RED otherwise (`openapi-contract.test.ts`).
- Audit is append-only, never purged (v1); machine reason strings `claim released by split` / `claim released on review` are grep-pinned by `scenarios.test.ts` — **never reword**. New reason strings introduced here are pinned forward by this plan's tests.
- `PUBLIC_PATHS` stays exactly `{/ping, /openapi.yaml}` (Task 16 normalizes the _lookup_ only, never the set). `actorCtx` is the single identity source and must spread **last** in any body-merge. `requireHuman` stays async (sync-void preHandler deadlocks fastify 5's hook iterator — don't regress).
- §6.3 stays spec-literal: canceled blockers count as unmet forever.
- Machine quirks: better-sqlite3 13.x via pnpm `onlyBuiltDependencies`; mise pins node 24 / pnpm 10.33 (local 26.x fine). Tests never read `.env`/secret paths; temp files come from `os.tmpdir()`.

## Decision record for this plan (spec-derived interpretations)

Locked here so implementers don't re-litigate (lettering continues Plan A's D-a…D-l):

- **D-m** A question **is a thread** (`kind='question'`): one `threads` table carries `state`/`assignee_id`/`answer_message_id` with CHECKs (`(kind='question') = (state is not null)`, question ⇒ assignee NOT NULL). No separate `questions` table — §6.5 models question as a thread kind, and the invariant-6 count becomes one indexed query. (Plan A already used "D-m" informally in an inline test comment for `canceled_terminal`; this record is authoritative for the letter's _plan_ meaning — the shipped code needs no change.)
- **D-n** Question transitions: `open → {answered, wont_fix}`, `answered → {resolved, wont_fix}`, `resolved`/`wont_fix` terminal. `open → resolved` is rejected (resolve implies it was answered). Invalid move ⇒ new code `question_transition` (409). Answering is its own endpoint (`POST …/answer`): atomically appends the answer message, links it (`answer_message_id`), moves `open → answered`; answering a non-open question ⇒ `question_transition`.
- **D-o** Invariant-6 gate = `to === 'in_review'` ∧ `actor.kind === 'agent'` ∧ ∃ thread on the task (kind='question', state='open', assignee.kind='human'). **The Plan A seam comment sits inside the `done` branch; §6.4.6 gates `in_review`, so the gate lands just above that branch and the stale comment is replaced** (documented relocation — the spec text, not the comment's branch, is binding). Humans are never gated; `answered` un-gates (§14.5 "gates review until a human answers"); reassigning to an agent un-gates (§6.4.6 says "assigned to a _human_", literal). The `review_gate` policy (§6.4.5) does NOT switch invariant 6 off — the two gates are independent.
- **D-p** `threads_on_parent` predicate = task **has children** (the post-split state; re-deriving "a split happened" is unobservable and irrelevant). Meta-note escape: query flag `?meta_note=true` honored **only for human actors posting a note** — an agent, or a question thread, still gets the 409 (spec: "query flag in UI only", literal). Meta-notes audit reason: `meta-note on parent (spec §6.2)` (grep-pinned by Task 7's test).
- **D-q** Mention syntax: `@handle`, handle chars `[A-Za-z0-9][A-Za-z0-9_-]*`, boundary-anchored (start/whitespace/`(`) so `a@b.com` never mentions. Resolved against existing handles at post time; unknown silently dropped; author never self-notified; each handle notified once per message.
- **D-r** Inbox kinds built: `assigned` (task assignee change via PATCH only — claim is self-assignment (D-a) and needs no inbox), `mentioned`, `question_assigned` (creation and reassignment, not self). Inbox reads are per-actor (own items only); mark-read is owner-only (404 otherwise). Read-state changes are NOT audited (audit is workspace state — the causing action is audited; read receipts would drown the activity tab).
- **D-s** Upload = **raw body** (`application/octet-stream`) + querystring `filename`/`content_type` — a multipart plugin would add a runtime dep and nothing (agents curl bytes). `FileStore` port: `put(bytes) → {sha256, bytes}` (hashing lives in infra, keeping node:crypto out of the app layer, same rationale as the sanctioned token-hash utility). Disk impl writes `<dataDir>/files/<sha[0:2]>/<sha>` tmp+rename, content-addressed ⇒ idempotent. Re-upload of the same (task, sha256, filename) returns the existing row without a second audit. Serving: HTML/XML/SVG are downgraded to `application/octet-stream` with `attachment` disposition; every response carries `X-Content-Type-Options: nosniff` (spec §10 "no HTML rendering from attachment origin").
- **D-t** Links: `kind ∈ {pr,commit,doc,other}`; URL must parse as `http(s)`; `unique(task_id,kind,url)`; POST is insert-or-get (idempotent, always 201 with the row).
- **D-u** Adapter-level problem codes are NOT DomainErrors — they are transport facts. `problem.ts` gains `ADAPTER_ERROR_CODES = {internal_error:500, payload_too_large:413, unsupported_media_type:415}`; the drift-test pin becomes `domain ∪ adapter`; yaml enum carries both (closes the backlog item "non-DomainError 415/413 surface as 500"). `rate_limited` by contrast IS a domain code (D-v) — the limiter raises `DomainError` like every other rejection.
- **D-v** Rate limit (spec §10, per-actor): new domain code `rate_limited` (429); fixed one-minute window counter in memory per authenticated actor id; `NS_RATE_LIMIT_PER_MIN` default 120, `0` disables. Applies after auth (unauthenticated requests are rejected cheaply anyway); single-process in-memory is honest for the single-container model (§9). `makeTestApp` overrides the limit to 0 (disabled) so the suite never trips; the rate-limit test builds an app with the limit at 2.
- **D-w** New env: `NS_DATA_DIR` (default `./data`), `NS_MAX_UPLOAD_BYTES` (default 20971520), `NS_RATE_LIMIT_PER_MIN` (default 120). All three land in `config.ts` in Task 11 (one test churn), consumed by Tasks 11/12/14.
- **D-x** Question mutation is open to every authenticated actor (§5 "nothing hidden"; roles are admin|member only and arrive with E): any actor may answer, resolve, close, or reassign. ACLs are §13 standing out-of-scope.
- **D-y** Message ordering: `seq` per thread (INTEGER, `max(seq)+1` computed inside `appendMessage`, unique(thread_id,seq)) — clock-stable, unlike created_at ties. Threads listed oldest-first by (created_at, id).
- **D-z** ID prefixes join the RandomIdGen family: `th_` threads, `ms_` messages, `ib_` inbox items, `at_` attachments, `lk_` links.

## File structure (target, after all tasks)

```
openapi/openapi.yaml                        + threads/messages/answer, inbox, attachments, links paths;
                                            ContextBundle items typed; Problem.code grows:
                                            question_transition, rate_limited (Task 1),
                                            payload_too_large, unsupported_media_type (Task 2)
src/
  domain/
    discussion.ts        ThreadKind/QuestionState/LinkKind, transition map, nextQuestionStates (Task 1)
    mentions.ts          extractMentions pure parser                                        (Task 1)
    errors.ts/.test.ts   + question_transition 409, rate_limited 429                        (Task 1)
  application/
    ports.ts             + Thread/Message/Inbox/Attachment/Link records & repos, FileStore  (Tasks 4, 11)
    usecases/
      create-thread.ts   CreateThread (question creation, threads_on_parent, meta-note,
                          mentions → inbox, question_assigned inbox)                        (Task 5)
      add-message.ts     AddMessage + mention routing                                       (Task 5)
      route-mentions.ts  shared mention→inbox helper                                        (Task 5)
      answer-question.ts AnswerQuestion (message + answer link + answered)                  (Task 6)
      update-question.ts UpdateQuestion (transitions, reassignment + inbox)                 (Task 6)
      update-task.ts     + assigned-inbox producer (constructor gains IdGen)               (Task 9)
      mark-inbox-read.ts MarkInboxRead                                                      (Task 9)
      get-context.ts     seams populated (open_questions/links/attachments)                (Task 10)
      upload-attachment.ts UploadAttachment (FileStore.put + metadata row)                 (Task 12)
      manage-links.ts    AddLink / RemoveLink                                              (Task 13)
      update-status.ts   invariant-6 gate above the done branch (D-o)                       (Task 8)
  adapters/rest/
    problem.ts           ADAPTER_ERROR_CODES + 413/415 mapping                             (Task 2)
    openapi-contract.test.ts  pin: domain ∪ adapter codes                                  (Task 2)
    auth.ts              trailing-slash lookup fix + sanctioned-import note                (Task 16)
    rate-limit.ts        registerRateLimit (per-actor fixed window, throws rate_limited)   (Task 14)
    app.ts               + parseAs-buffer octet-stream parser, registerThreadRoutes,
                          registerInboxRoutes, registerAttachmentRoutes, registerLinkRoutes,
                          registerRateLimit                                                (Tasks 7,9,12,13,14)
    routes/threads.ts    GET/POST /tasks/:id/threads; POST /tasks/:id/threads/:tid/messages;
                          POST /tasks/:id/threads/:tid/answer; PATCH /tasks/:id/threads/:tid (Task 7)
    routes/inbox.ts      GET /inbox; POST /inbox/:id/read                                   (Task 9)
    routes/attachments.ts POST/GET /tasks/:id/attachments; GET /attachments/:id/content    (Task 12)
    routes/links.ts      POST/GET /tasks/:id/links; DELETE /tasks/:id/links/:linkId         (Task 13)
    scenarios-discussion.test.ts  §14 discussion-side story                                 (Task 15)
  infra/
    files/disk-file-store.ts  DiskFileStore implements FileStore                            (Task 11)
    sqlite/schema.ts     + Threads/Messages/InboxItems/Attachments/Links tables
    sqlite/migrations.ts + '2026-09-11_discussion'                                          (Task 3)
    sqlite/thread-repo.ts  SqliteThreadRepo (incl. openHumanAssigned, openQuestionsForTask) (Task 4)
    sqlite/inbox-repo.ts / attachment-repo.ts / link-repo.ts                                 (Task 4)
    sqlite/uow.ts        Repos gains threads/inbox/attachments/links                        (Task 4)
  main/
    config.ts            + dataDir, maxUploadBytes, rateLimitPerMin                         (Task 11)
    deps.ts              + threadsRoot/inboxRoot/attachmentsRoot/linksRoot/files/use-cases  (Tasks 4,5,6,9,10,12,13)
  testing/
    fixtures.ts          + seedThread/seedMessage helpers                                   (Task 4)
    test-app.ts          makeTestApp(env overrides); rate limit off by default              (Task 11)
.github/workflows/ci.yaml  pnpm test → pnpm test:coverage                                   (Task 16)
```

Conventions for every task (inherited, binding): run `pnpm test <file>` for red/green checks, `pnpm test && pnpm lint && pnpm typecheck` before commit; commit with `LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "<subject>"`, conventional style, **subject ≤ 72 chars**; all timestamps ISO-8601 UTC; all tests colocated `*.test.ts`; **coverage thresholds unchanged** (global ≥85, `src/domain/**` 100); machine reason strings never reworded.

**Plan ⇄ shipped byte-sync protocol (same as Plan A):** the code blocks below are the planned text. If shipped code lands byte-different from a block (review repair, lint normalization, API correction), the implementer appends a `> **Amendment (Task N, <who/what>):** …` blockquote to that task's section in THIS file, quoting what changed (with `git show <hash>` for review repairs) and re-labels the block `sync = shipped form` once identical. Never leave the plan silently describing code that does not exist.

---

### Task 1: Domain discussion vocabulary + `question_transition` / `rate_limited` codes

**Files:**

- Create: `src/domain/discussion.ts`, `src/domain/mentions.ts` (+ colocated tests)
- Modify: `src/domain/errors.ts`, `src/domain/errors.test.ts`, `openapi/openapi.yaml` (Problem.code enum only)

- [ ] **Step 1.1: Write the failing test** `src/domain/discussion.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  LINK_KINDS,
  QUESTION_STATES,
  THREAD_KINDS,
  canTransitionQuestion,
} from '#root/domain/discussion'

describe('discussion vocabulary (spec §6.5/§6.6)', () => {
  it('freezes the kinds/states/link-kinds vocabularies', () => {
    expect(THREAD_KINDS).toEqual(['note', 'question'])
    expect(QUESTION_STATES).toEqual(['open', 'answered', 'resolved', 'wont_fix'])
    expect(LINK_KINDS).toEqual(['pr', 'commit', 'doc', 'other'])
  })
})

describe('question transitions (decision D-n)', () => {
  // full matrix — domain carries a 100% branch threshold, exhaustive is cheap here
  const matrix: Array<[string, string, boolean]> = [
    ['open', 'open', false],
    ['open', 'answered', true],
    ['open', 'resolved', false], // resolve implies it was answered (D-n)
    ['open', 'wont_fix', true],
    ['answered', 'open', false],
    ['answered', 'answered', false],
    ['answered', 'resolved', true],
    ['answered', 'wont_fix', true],
    ['resolved', 'open', false],
    ['resolved', 'answered', false],
    ['resolved', 'resolved', false],
    ['resolved', 'wont_fix', false],
    ['wont_fix', 'open', false],
    ['wont_fix', 'answered', false],
    ['wont_fix', 'resolved', false],
    ['wont_fix', 'wont_fix', false],
  ]
  it.each(matrix)('%s → %s allowed: %s', (from, to, allowed) => {
    expect(canTransitionQuestion(from as never, to as never)).toBe(allowed)
  })
})
```

- [ ] **Step 1.2: Write the failing test** `src/domain/mentions.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { extractMentions } from '#root/domain/mentions'

describe('extractMentions (decision D-q)', () => {
  it('extracts @handles once each, first-seen order', () => {
    expect(extractMentions('@nils ping @ana and @nils again')).toEqual(['nils', 'ana'])
  })
  it('requires a boundary before the @ — emails never mention', () => {
    expect(extractMentions('write a@b.com please')).toEqual([])
  })
  it('accepts a paren-thrown mention and handle characters', () => {
    expect(extractMentions('(hermes-1) on it')).toEqual(['hermes-1'])
  })
  it('stops the token at non-handle characters', () => {
    expect(extractMentions('@nils, hi')).toEqual(['nils'])
  })
  it('returns [] for plain text', () => {
    expect(extractMentions('no mentions at all')).toEqual([])
  })
})
```

- [ ] **Step 1.3: RED** — `pnpm test src/domain` → FAIL "Cannot find module … discussion / mentions".

- [ ] **Step 1.4: Implement** `src/domain/discussion.ts`:

```ts
// Discussion vocabulary (spec §6.5/§6.6). Pure — the domain layer imports nothing (spec §9).

export const THREAD_KINDS = ['note', 'question'] as const
export type ThreadKind = (typeof THREAD_KINDS)[number]

export const QUESTION_STATES = ['open', 'answered', 'resolved', 'wont_fix'] as const
export type QuestionState = (typeof QUESTION_STATES)[number]

// Decision D-n: open → {answered, wont_fix}; answered → {resolved, wont_fix};
// resolved/wont_fix terminal. Full matrix pinned exhaustively in tests.
const TRANSITIONS: Record<QuestionState, readonly QuestionState[]> = {
  open: ['answered', 'wont_fix'],
  answered: ['resolved', 'wont_fix'],
  resolved: [],
  wont_fix: [],
}

export const canTransitionQuestion = (from: QuestionState, to: QuestionState): boolean =>
  TRANSITIONS[from].includes(to)

export const LINK_KINDS = ['pr', 'commit', 'doc', 'other'] as const
export type LinkKind = (typeof LINK_KINDS)[number]
```

- [ ] **Step 1.5: Implement** `src/domain/mentions.ts`:

```ts
// Decision D-q: a mention is @handle with handle = [A-Za-z0-9][A-Za-z0-9_-]*,
// boundary-anchored (start/whitespace/open-paren) so email-shaped text never fires.
const MENTION = /(^|\s|\()@([A-Za-z0-9][A-Za-z0-9_-]*)/g

/** Distinct mentioned handles, first-seen order. */
export const extractMentions = (body: string): string[] =>
  [...body.matchAll(MENTION)].map((m) => m[2] as string).filter((h, i, all) => all.indexOf(h) === i)
```

- [ ] **Step 1.6: Green check** — `pnpm test src/domain` → PASS; `pnpm test:coverage` → `discussion.ts`/`mentions.ts` at 100% (domain threshold).

- [ ] **Step 1.7: New domain codes (one map = one commit with the yaml enum).** In `src/domain/errors.ts`: add `| 'question_transition'` and `| 'rate_limited'` to the union after `| 'threads_on_parent'`; add `question_transition: 409,` and `rate_limited: 429,` to `DOMAIN_ERROR_STATUS` after `threads_on_parent: 409,`. In `src/domain/errors.test.ts` add after the `threads_on_parent` table row:

```ts
    ['question_transition', 409],
    ['rate_limited', 429],
```

In `openapi/openapi.yaml`, add `question_transition,` and `rate_limited,` to the `Problem.properties.code.enum` list immediately after `threads_on_parent,`.

- [ ] **Step 1.8: Verify + commit** — `pnpm test && pnpm lint && pnpm typecheck` (the enum-pin test proves union ⇄ yaml). Commit:

```bash
git add -A
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(domain): discussion vocabulary, question transitions, mentions"
```

> **Amendment (Task 1, mentions test — planned text was unsatisfiable):** Step 1.2's third case read `extractMentions('(hermes-1) on it')` — no `@` in the input, so no D-q-conformant parser can return `['hermes-1']` (accepting it would require `@`-less matching, which breaks the email rule the same suite pins). Shipped input: `extractMentions('(@hermes-1) on it')` — same name, same expectation, and it exercises exactly the claimed pair (open-paren boundary + `hermes-1` handle chars). Block sync = shipped form.

> **Amendment (Task 1, mentions.ts lint):** Step 1.5's `.map((m) => m[2] as string)` trips `@typescript-eslint/no-unnecessary-type-assertion` — `RegExpMatchArray[2]` is already `string` here — so the assertion is removed: `.map((m) => m[2])`. Block sync = shipped form.

> **Amendment (Task 1, post-approval review carry-in):** `INBOX_ITEM_KINDS`/`InboxItemKind` (the D-r kind list) joined `discussion.ts` during Task 3's quality-review repair, as the vocabulary single-source for the `inbox_items` DDL and row type; the freeze test in `discussion.test.ts` pins it. Lands in the child fix commit of `6acaf76` (a commit cannot quote its own hash — resolve via `git log`).

---

### Task 2: Adapter-level problem codes — the 413/415 backlog fix

Backlog item: "problem.ts: non-DomainError 415/413 currently surface as 500 internal_error — map client errors properly." Decision D-u.

**Files:**

- Modify: `src/adapters/rest/problem.ts`, `src/adapters/rest/openapi-contract.test.ts`, `openapi/openapi.yaml` (Problem.code enum)
- Test: `src/adapters/rest/problem.test.ts` (create)

- [ ] **Step 2.1: Write the failing test** `src/adapters/rest/problem.test.ts` (probe-route idiom follows `idempotency.test.ts`'s `/idem-echo` — routes attach before first inject):

```ts
import { describe, expect, it } from 'vitest'
import { makeTestApp } from '#root/testing/test-app'

const nils = (t: { adminToken: string }): Record<string, string> => ({
  authorization: `Bearer ${t.adminToken}`,
})

describe('adapter error mapping (backlog: 413/415 surfaced as 500)', () => {
  it('unsupported content-type on a JSON route → 415 problem unsupported_media_type', async () => {
    const t = await makeTestApp()
    const res = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { ...nils(t), 'content-type': 'text/plain' },
      payload: 'hello',
    })
    expect(res.statusCode).toBe(415)
    expect(res.headers['content-type']).toContain('application/problem+json')
    expect(res.json().code).toBe('unsupported_media_type')
    await t.close()
  })

  it('body over the route limit → 413 problem payload_too_large', async () => {
    const t = await makeTestApp()
    t.app.post('/probe-body-limit', { config: { bodyLimit: 8 } }, async () => ({ ok: true }))
    const res = await t.app.inject({
      method: 'POST',
      url: '/probe-body-limit',
      headers: nils(t),
      payload: { s: '0123456789' },
    })
    expect(res.statusCode).toBe(413)
    expect(res.json().code).toBe('payload_too_large')
    await t.close()
  })

  it('unknown thrown error still funnels to 500 internal_error (no regression)', async () => {
    const t = await makeTestApp()
    t.app.get('/probe-boom', async () => {
      throw new Error('kaboom')
    })
    const res = await t.app.inject({ method: 'GET', url: '/probe-boom', headers: nils(t) })
    expect(res.statusCode).toBe(500)
    expect(res.json().code).toBe('internal_error')
    await t.close()
  })
})
```

- [ ] **Step 2.2: RED** — `pnpm test src/adapters/rest/problem.test.ts` → the 415/413 cases answer 500 `internal_error` (that IS the backlog bug).

- [ ] **Step 2.3: Implement.** In `src/adapters/rest/problem.ts`, after the `ProblemBody` interface add:

```ts
// Decision D-u: adapter-level codes are NOT DomainErrors — they are transport facts
// (media type, body limit). The OpenAPI drift test pins this map against the yaml
// Problem.code enum exactly like DOMAIN_ERROR_STATUS (domain ∪ adapter = the enum).
// rate_limited is deliberately absent — it IS a domain code (D-v).
export const ADAPTER_ERROR_CODES = {
  internal_error: 500,
  payload_too_large: 413,
  unsupported_media_type: 415,
} as const
```

(Keep the shipped comment above `problem()` and everything else verbatim.)

In `registerProblemHandlers`, replace the block from `const status = …` through the final `return sendProblem(...)` with:

```ts
const status = typeof error.statusCode === 'number' ? error.statusCode : 500
if (status === 400) return sendProblem(reply, 400, 'invalid_request', error.message)
if (status === 413) return sendProblem(reply, 413, 'payload_too_large', error.message)
if (status === 415) return sendProblem(reply, 415, 'unsupported_media_type', error.message)
app.log.error(error)
return sendProblem(
  reply,
  status === 401 ? 401 : 500,
  status === 401 ? 'unauthenticated' : 'internal_error',
  status === 401 ? error.message : 'internal error'
)
```

In `src/adapters/rest/openapi-contract.test.ts`: import `ADAPTER_ERROR_CODES` from `'#root/adapters/rest/problem'`; replace

```ts
const domainCodes = Object.keys(DOMAIN_ERROR_STATUS).concat('internal_error').sort()
expect(spec.components.schemas.Problem.properties.code.enum.sort()).toEqual(domainCodes)
```

with

```ts
// domain ∪ adapter (D-u): transport codes join the same pinned vocabulary
const expectedCodes = Object.keys(DOMAIN_ERROR_STATUS)
  .concat(Object.keys(ADAPTER_ERROR_CODES))
  .sort()
expect(spec.components.schemas.Problem.properties.code.enum.sort()).toEqual(expectedCodes)
```

In `openapi/openapi.yaml` `Problem.code.enum`, add `payload_too_large,` and `unsupported_media_type,` after `idempotency_in_flight,`.

- [ ] **Step 2.4: Verify green + commit:**

```bash
pnpm test && pnpm lint && pnpm typecheck
git add -A
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "fix(rest): map 413/415 transport failures to problem codes (backlog)"
```

> **Amendment (Task 2, probe routes — planned probes could not reach the transport errors):** Two API corrections in the Step 2.1 block. (1) 415: fastify registers default content-type parsers for both `application/json` and `text/plain` (`lib/content-type-parser.js`), so a `text/plain` probe parses fine and dies at route body-validation with 400 `invalid_request` — it never reaches the 415 path. Shipped input: content-type `application/x-sh` (a type no parser will ever register — `FST_ERR_CTP_INVALID_MEDIA_TYPE`, statusCode 415); the case title now reads "unparseable content-type…". (2) 413: fastify reads the per-route body limit from the direct route option `bodyLimit` (`lib/route.js`: `bodyLimit: opts.bodyLimit` into the context, `context._parserOptions.limit = opts.bodyLimit || null`) — `{ config: { bodyLimit: 8 } }` is silently inert (the probe answered 200). Shipped option: `{ bodyLimit: 8 }`. With these corrections RED lands exactly as planned: both probes answer 500 `internal_error` on the shipped handler. Block sync = shipped form.

> **Amendment (Task 2, quality review):** the map↔yaml pin was airtight but nothing tied the HANDLER to the vocabulary — a future `if (status === 416)` branch calling `sendProblem(reply, 416, 'range_not_satisfiable', …)` would pass drift test, typecheck and suite GREEN while emitting an undocumented code (the silent-GREEN class this repo pins fail-loud). Repair: `sendProblem`'s `code` parameter is no longer `string` but the closed union `DomainErrorCode | keyof typeof ADAPTER_ERROR_CODES` (`type DomainErrorCode` imported from `#root/domain/errors`); all six literal call sites are inside the union, and a probe with an out-of-vocabulary code now fails `tsc` — verified both directions. No status→code dispatch table (YAGNI, reviewer-confirmed). Companion: the drift test's stale comment ("`internal_error` … unioned explicitly") now reads "`internal_error` rides in `ADAPTER_ERROR_CODES` with the other transport codes (D-u)." Repairs the shipped form of `21d5586`; this amendment lands in its child fix commit (a commit cannot quote its own hash — resolve via `git log` on this file). Block sync = shipped form.

---

### Task 3: Migration + schema — discussion, inbox, attachments, links tables

**Files:**

- Modify: `src/infra/sqlite/schema.ts`, `src/infra/sqlite/migrations.ts`, `src/infra/sqlite/migrations.test.ts`

- [ ] **Step 3.1: Extend the failing test.** In `src/infra/sqlite/migrations.test.ts`, extend the `TABLES` array with `'threads', 'messages', 'inbox_items', 'attachments', 'links'`, and append the constraint-contract test (after the existing 'rejects invalid status…' test):

```ts
it('pins discussion DDL constraints (question⇔state/assignee, orderings, uniqueness)', async () => {
  const db = makeDb(':memory:')
  await migrateToLatest(db)
  await seedActorAndTask(db) // existing helper: seeds a_x (human) + t_x
  await sql`insert into actors (id, kind, handle, display_name, description, created_at)
              values ('a_ag','agent','ag','Ag','','2026-01-01')`.execute(db)
  // note thread: state must stay NULL
  await sql`insert into threads (id, task_id, kind, created_by, created_at, updated_at)
              values ('th_n','t_x','note','a_x','2026-01-01','2026-01-01')`.execute(db)
  await expect(
    sql`insert into threads (id, task_id, kind, state, created_by, created_at, updated_at)
          values ('th_bad','t_x','note','open','a_x','2026-01-01','2026-01-01')`.execute(db)
  ).rejects.toThrow(/CHECK|check/i)
  // question thread requires assignee; state vocabulary enforced
  await expect(
    sql`insert into threads (id, task_id, kind, state, created_by, created_at, updated_at)
          values ('th_q','t_x','question','open','a_x','2026-01-01','2026-01-01')`.execute(db)
  ).rejects.toThrow(/CHECK|check/i)
  await sql`insert into threads (id, task_id, kind, state, assignee_id, created_by,
              created_at, updated_at)
              values ('th_q2','t_x','question','open','a_ag','a_x','2026-01-01','2026-01-01')`.execute(
    db
  )
  await expect(
    sql`insert into threads (id, task_id, kind, state, assignee_id, created_by,
              created_at, updated_at)
              values ('th_q3','t_x','question','shipped','a_ag','a_x','2026-01-01','2026-01-01')`.execute(
      db
    )
  ).rejects.toThrow(/CHECK|check/i)
  // messages: unique seq per thread (D-y ordering)
  await sql`insert into messages (id, thread_id, seq, author_id, body, created_at)
              values ('ms_1','th_n',1,'a_x','hi','2026-01-01')`.execute(db)
  await expect(
    sql`insert into messages (id, thread_id, seq, author_id, body, created_at)
          values ('ms_2','th_n',1,'a_x','again','2026-01-01')`.execute(db)
  ).rejects.toThrow(/UNIQUE/i)
  // links: kind check + idempotency uniqueness (D-t)
  await sql`insert into links (id, task_id, kind, url, created_by, created_at)
              values ('lk_1','t_x','pr','https://x/1','a_x','2026-01-01')`.execute(db)
  await expect(
    sql`insert into links (id, task_id, kind, url, created_by, created_at)
          values ('lk_2','t_x','wiki','https://x/2','a_x','2026-01-01')`.execute(db)
  ).rejects.toThrow(/CHECK|check/i)
  await expect(
    sql`insert into links (id, task_id, kind, url, created_by, created_at)
          values ('lk_3','t_x','pr','https://x/1','a_x','2026-01-01')`.execute(db)
  ).rejects.toThrow(/UNIQUE/i)
  // inbox: kind vocabulary — claim_conflict deliberately NOT in the vocabulary (D-r)
  await sql`insert into inbox_items (id, actor_id, kind, task_id, read, created_at)
              values ('ib_1','a_x','assigned','t_x',0,'2026-01-01')`.execute(db)
  await expect(
    sql`insert into inbox_items (id, actor_id, kind, task_id, read, created_at)
          values ('ib_2','a_x','claim_conflict','t_x',0,'2026-01-01')`.execute(db)
  ).rejects.toThrow(/CHECK|check/i)
  // attachments: per-task content identity (D-s dedupe anchor)
  await sql`insert into attachments (id, task_id, filename, content_type, sha256, bytes,
                  created_by, created_at)
                  values ('at_1','t_x','a.md','text/markdown','ab',1,'a_x','2026-01-01')`.execute(
    db
  )
  await expect(
    sql`insert into attachments (id, task_id, filename, content_type, sha256, bytes,
                  created_by, created_at)
                  values ('at_2','t_x','a.md','text/markdown','ab',1,'a_x','2026-01-01')`.execute(
      db
    )
  ).rejects.toThrow(/UNIQUE/i)
  await db.destroy()
})
```

- [ ] **Step 3.2: RED** — `pnpm test src/infra/sqlite/migrations.test.ts` → fails on missing tables.

- [ ] **Step 3.3: Schema types.** In `src/infra/sqlite/schema.ts` extend the domain import: `import type { LinkKind, QuestionState, ThreadKind } from '#root/domain/discussion'` (alongside the existing `ActorKind, TaskStatus` import from `#root/domain/task`), then append:

```ts
export interface ThreadsTable {
  id: string
  task_id: string
  kind: ThreadKind
  state: QuestionState | null
  assignee_id: string | null
  answer_message_id: string | null
  created_by: string
  created_at: string
  updated_at: string
}

export interface MessagesTable {
  id: string
  thread_id: string
  seq: number
  author_id: string
  body: string
  created_at: string
}

export interface InboxItemsTable {
  id: string
  actor_id: string
  kind: 'assigned' | 'mentioned' | 'question_assigned'
  task_id: string
  thread_id: string | null
  read: number
  created_at: string
}

export interface AttachmentsTable {
  id: string
  task_id: string
  filename: string
  content_type: string
  sha256: string
  bytes: number
  created_by: string
  created_at: string
}

export interface LinksTable {
  id: string
  task_id: string
  kind: LinkKind
  url: string
  created_by: string
  created_at: string
}
```

and add to `interface DB`: `threads: ThreadsTable`, `messages: MessagesTable`, `inbox_items: InboxItemsTable`, `attachments: AttachmentsTable`, `links: LinksTable`.

- [ ] **Step 3.4: Migration.** In `src/infra/sqlite/migrations.ts`, add a second key to the `migrations` map, after `'2026-09-06_init'`:

```ts
  '2026-09-11_discussion': {
    up: async (db: Kysely<DB>) => {
      // D-m: question IS a thread (kind='question'); the CHECKs encode the shape rules
      // so a malformed row cannot exist no matter which code path wrote it.
      await sql`create table threads (
        id text primary key,
        task_id text not null references tasks(id),
        kind text not null check (kind in ('note','question')),
        state text check (state in ('open','answered','resolved','wont_fix')),
        assignee_id text references actors(id),
        answer_message_id text,
        created_by text not null references actors(id),
        created_at text not null,
        updated_at text not null,
        check ((kind = 'question') = (state is not null)),
        check (kind = 'note' or assignee_id is not null)
      )`.execute(db)
      await sql`create index threads_task_idx on threads (task_id)`.execute(db)
      // answer_message_id carries no FK by design: threads⇄messages would cycle the FK
      // creation order; its only writer is AnswerQuestion inside one transaction (D-n).

      await sql`create table messages (
        id text primary key,
        thread_id text not null references threads(id),
        seq integer not null,
        author_id text not null references actors(id),
        body text not null,
        created_at text not null,
        unique (thread_id, seq)
      )`.execute(db)

      await sql`create table inbox_items (
        id text primary key,
        actor_id text not null references actors(id),
        kind text not null check (kind in ('assigned','mentioned','question_assigned')),
        task_id text not null references tasks(id),
        thread_id text references threads(id),
        read integer not null default 0 check (read in (0,1)),
        created_at text not null
      )`.execute(db)
      // (actor, read)-leading index: GET /inbox?unread is THE inbox read path; small
      // circle ⇒ the two hot filters are covered by this one index.
      await sql`create index inbox_actor_idx on inbox_items (actor_id, read)`.execute(db)

      await sql`create table attachments (
        id text primary key,
        task_id text not null references tasks(id),
        filename text not null,
        content_type text not null,
        sha256 text not null,
        bytes integer not null,
        created_by text not null references actors(id),
        created_at text not null,
        unique (task_id, sha256, filename)
      )`.execute(db)

      await sql`create table links (
        id text primary key,
        task_id text not null references tasks(id),
        kind text not null check (kind in ('pr','commit','doc','other')),
        url text not null,
        created_by text not null references actors(id),
        created_at text not null,
        unique (task_id, kind, url)
      )`.execute(db)
    },
  },
```

- [ ] **Step 3.5: Verify + commit** — `pnpm test && pnpm lint && pnpm typecheck`:

```bash
git add -A
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(infra): threads, messages, inbox, attachments, links"
```

> **Amendment (Task 3, quality review):** Three repairs to the shipped form of `6acaf76`. (1) The `threads` constraint test gains two isolated probes: `th_q4` (`kind='question'`, `state` NULL, `assignee_id` set) pins the biconditional's previously unpinned question-arm — mutation-verified: weakening `check ((kind = 'question') = (state is not null))` to the `or` form reddens exactly this probe (restored green after); `th_k` (`kind='bogus'`, `assignee_id` set) isolates the `kind` vocabulary check the same way (mutation: removing the inline `check (kind in ('note','question'))` reddens exactly it). (2) The `answer_message_id` no-FK comment was factually wrong — SQLite accepts forward FK refs at CREATE (verified live), creation order was never the constraint; it now names the real guarantee, `AnswerQuestion`'s single transaction (D-n). (3) Both index comments follow the init idiom with EXPLAIN-verified claims, quoted honestly: with the indexes the task-filtered `threads` reads (plain list + the `kind`/`state` gate variant) print `SEARCH threads USING INDEX threads_task_idx (task_id=?)` and the unread-inbox read prints `SEARCH inbox_items USING INDEX inbox_actor_idx (actor_id=? AND read=?)`; dropping either index yields a full `SCAN` (the `created_at` ordering stays a TEMP B-TREE in both shapes — not claimed otherwise; the surviving `sqlite_autoindex_*` are the text PKs only). (4) `schema.ts` imports `InboxItemKind` from `#root/domain/discussion` in place of the inline union (export added under the Task 1 carry-in amendment). Lands in the child fix commit of `6acaf76` (a commit cannot quote its own hash — resolve via `git log`). Block sync = shipped form.

---

### Task 4: Ports + SQLite repos (threads/inbox/attachments/links) + wiring

**Files:**

- Modify: `src/application/ports.ts`, `src/infra/sqlite/uow.ts`, `src/main/deps.ts`, `src/testing/fixtures.ts`
- Create: `src/infra/sqlite/thread-repo.ts`, `src/infra/sqlite/inbox-repo.ts`, `src/infra/sqlite/attachment-repo.ts`, `src/infra/sqlite/link-repo.ts` (+ colocated tests)

- [ ] **Step 4.1: Extend `src/application/ports.ts`.** Extend the top type import with discussion types (line 1 becomes: `import type { LinkKind, QuestionState, ThreadKind } from '#root/domain/discussion'` plus the existing `import type { ActorKind, TaskDraft, TaskRecord, TaskStatus } from '#root/domain/task'`). Insert before the `// ---- wiring seams` section:

```ts
// ---- threads, messages, questions (spec §6.5, D-m/D-n/D-y)

export interface ThreadDraft {
  id: string
  task_id: string
  kind: ThreadKind
  state: QuestionState | null
  assignee_id: string | null
  answer_message_id: string | null
  created_by: string
  created_at: string
  updated_at: string
}

export interface ThreadRecord extends ThreadDraft {}

export interface MessageRecord {
  id: string
  thread_id: string
  seq: number
  author_id: string
  body: string
  created_at: string
}

export interface ThreadWithMessages {
  thread: ThreadRecord
  messages: MessageRecord[]
}

export interface OpenQuestionRow {
  id: string
  state: QuestionState
  assignee_handle: string
  /** body of the first message — the question text (spec §7.2 context bundle) */
  question: string
}

export interface ThreadRepo {
  create(draft: ThreadDraft): Promise<ThreadRecord>
  find(id: string): Promise<ThreadRecord | null>
  /** Threads (oldest first) each carrying its messages ordered by seq. */
  listForTask(taskId: string): Promise<ThreadWithMessages[]>
  /** seq = per-thread max+1, computed here (D-y); callers never pass seq. */
  appendMessage(input: {
    id: string
    threadId: string
    authorId: string
    body: string
    created_at: string
  }): Promise<MessageRecord>
  setQuestionFields(
    threadId: string,
    patch: { state?: QuestionState; assignee_id?: string; answer_message_id?: string },
    updated_at: string
  ): Promise<void>
  /** Invariant-6 count (D-o): open questions on the task assigned to a HUMAN actor. */
  openHumanAssigned(taskId: string): Promise<number>
  /** Context bundle rows (spec §7.2): OPEN questions with first-message text. */
  openQuestionsForTask(taskId: string): Promise<OpenQuestionRow[]>
}

// ---- inbox (spec §6.8, D-r)

export type InboxKind = 'assigned' | 'mentioned' | 'question_assigned'

export interface InboxItemDraft {
  id: string
  actor_id: string
  kind: InboxKind
  task_id: string
  thread_id: string | null
  created_at: string
}

export interface InboxItemRecord extends InboxItemDraft {
  read: boolean
}

export interface InboxRepo {
  add(draft: InboxItemDraft): Promise<void>
  listForActor(
    actorId: string,
    filter: { unreadOnly: boolean; limit: number }
  ): Promise<InboxItemRecord[]>
  /** Owner-only mark-read; false when absent or not owned. */
  markRead(itemId: string, actorId: string): Promise<boolean>
}

// ---- attachments + links (spec §6.6, D-s/D-t)

export interface AttachmentRecord {
  id: string
  task_id: string
  filename: string
  content_type: string
  sha256: string
  bytes: number
  created_by: string
  created_at: string
}

export interface AttachmentRepo {
  add(draft: AttachmentRecord): Promise<AttachmentRecord>
  find(id: string): Promise<AttachmentRecord | null>
  listForTask(taskId: string): Promise<AttachmentRecord[]>
  findByTaskShaFilename(
    taskId: string,
    sha256: string,
    filename: string
  ): Promise<AttachmentRecord | null>
}

export interface LinkDraft {
  id: string
  task_id: string
  kind: LinkKind
  url: string
  created_by: string
  created_at: string
}

export interface LinkRecord extends LinkDraft {}

export interface LinkRepo {
  add(draft: LinkDraft): Promise<LinkRecord>
  find(id: string): Promise<LinkRecord | null>
  findByTaskKindUrl(taskId: string, kind: LinkKind, url: string): Promise<LinkRecord | null>
  remove(id: string): Promise<void>
  listForTask(taskId: string): Promise<LinkRecord[]>
}
```

and extend `Repos`:

```ts
export interface Repos {
  tasks: TaskRepo
  audit: AuditRepo
  deps: DependencyRepo
  labels: LabelRepo
  actors: ActorRepo
  threads: ThreadRepo
  inbox: InboxRepo
  attachments: AttachmentRepo
  links: LinkRepo
}
```

- [ ] **Step 4.2: Write failing repo tests.** `src/infra/sqlite/thread-repo.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { SqliteThreadRepo } from '#root/infra/sqlite/thread-repo'
import { freshDb, seedActor, seedTask } from '#root/testing/fixtures'
import type { ThreadDraft } from '#root/application/ports'

const note = (over: Partial<ThreadDraft> = {}): ThreadDraft => ({
  id: 'th_1',
  task_id: 't_1',
  kind: 'note',
  state: null,
  assignee_id: null,
  answer_message_id: null,
  created_by: 'a_human',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  ...over,
})

const question = (over: Partial<ThreadDraft> = {}): ThreadDraft =>
  note({
    id: 'th_q',
    kind: 'question',
    state: 'open',
    assignee_id: over.kind === 'note' ? null : 'a_ag',
    ...over,
  })

const setup = async () => {
  const db = await freshDb()
  await seedActor(db, 'a_human', 'human', 'nils')
  await seedActor(db, 'a_ag', 'agent', 'hermes-1')
  await seedActor(db, 'a_h2', 'human', 'ana')
  await seedTask(db, 't_1')
  await seedTask(db, 't_2')
  return { db, repo: new SqliteThreadRepo(db) }
}

const msg = (id: string, threadId: string, body: string) => ({
  id,
  threadId,
  authorId: 'a_human',
  body,
  created_at: '2026-01-01T00:00:00.000Z',
})

describe('SqliteThreadRepo', () => {
  it('creates, finds, appends ordered messages, lists with messages', async () => {
    const { db, repo } = await setup()
    const th = await repo.create(note())
    expect(th.state).toBeNull()
    const m1 = await repo.appendMessage(msg('ms_1', 'th_1', 'first'))
    const m2 = await repo.appendMessage(msg('ms_2', 'th_1', 'second'))
    expect([m1.seq, m2.seq]).toEqual([1, 2])
    expect(await repo.find('th_1')).toMatchObject({ id: 'th_1', kind: 'note' })
    expect(await repo.find('th_x')).toBeNull()
    const listed = await repo.listForTask('t_1')
    expect(listed).toHaveLength(1)
    expect(listed[0]!.messages.map((m) => m.body)).toEqual(['first', 'second'])
    await db.destroy()
  })

  it('setQuestionFields patches state/assignee/answer atomically', async () => {
    const { db, repo } = await setup()
    await repo.create(question())
    await repo.appendMessage(msg('ms_q', 'th_q', 'which db?'))
    await repo.setQuestionFields(
      'th_q',
      { state: 'answered', answer_message_id: 'ms_q' },
      '2026-01-02T00:00:00.000Z'
    )
    const t = (await repo.find('th_q'))!
    expect(t).toMatchObject({ state: 'answered', answer_message_id: 'ms_q', assignee_id: 'a_ag' })
    await db.destroy()
  })

  it('openHumanAssigned: open+human=1; answered/agent/other-task excluded', async () => {
    const { db, repo } = await setup()
    await repo.create(question()) // t_1, open, a_ag is AGENT → not counted
    await repo.setQuestionFields('th_q', { assignee_id: 'a_h2' }, '2026-01-02T00:00:00.000Z')
    expect(await repo.openHumanAssigned('t_1')).toBe(1)
    await repo.setQuestionFields('th_q', { state: 'answered' }, '2026-01-03T00:00:00.000Z')
    expect(await repo.openHumanAssigned('t_1')).toBe(0)
    await repo.create(question({ id: 'th_q9', task_id: 't_2' }))
    expect(await repo.openHumanAssigned('t_1')).toBe(0) // other task untouched
    expect(await repo.openHumanAssigned('t_2')).toBe(1)
    await db.destroy()
  })

  it('openQuestionsForTask carries first-message text and assignee handle', async () => {
    const { db, repo } = await setup()
    await repo.create(question())
    await repo.appendMessage(msg('ms_q', 'th_q', 'which db?'))
    await repo.appendMessage(msg('ms_q2', 'th_q', 'ping'))
    const rows = await repo.openQuestionsForTask('t_1')
    expect(rows).toEqual([
      { id: 'th_q', state: 'open', assignee_handle: 'hermes-1', question: 'which db?' },
    ])
    await db.destroy()
  })
})
```

`src/infra/sqlite/inbox-repo.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { SqliteInboxRepo } from '#root/infra/sqlite/inbox-repo'
import { freshDb, seedActor, seedTask } from '#root/testing/fixtures'
import type { InboxKind } from '#root/application/ports'

const setup = async () => {
  const db = await freshDb()
  await seedActor(db, 'a_x', 'human', 'nils')
  await seedTask(db, 't_1')
  return { db, repo: new SqliteInboxRepo(db) }
}

const add = (id: string, kind: InboxKind) => ({
  id,
  actor_id: 'a_x',
  kind,
  task_id: 't_1',
  thread_id: null as string | null,
  created_at: `2026-01-0${id.slice(-1)}T00:00:00.000Z`,
})

describe('SqliteInboxRepo', () => {
  it('adds, lists newest-first, filters unread, caps limit', async () => {
    const { db, repo } = await setup()
    await repo.add(add('ib_1', 'assigned'))
    await repo.add(add('ib_2', 'mentioned'))
    expect(
      (await repo.listForActor('a_x', { unreadOnly: false, limit: 10 })).map((i) => i.id)
    ).toEqual(['ib_2', 'ib_1'])
    await repo.markRead('ib_1', 'a_x')
    expect(
      (await repo.listForActor('a_x', { unreadOnly: true, limit: 10 })).map((i) => i.id)
    ).toEqual(['ib_2'])
    expect(
      (await repo.listForActor('a_x', { unreadOnly: false, limit: 1 })).map((i) => i.id)
    ).toEqual(['ib_2'])
    await db.destroy()
  })

  it('markRead flips read once; other actors and unknown ids get false', async () => {
    const { db, repo } = await setup()
    await repo.add(add('ib_1', 'assigned'))
    expect(await repo.markRead('ib_1', 'a_other')).toBe(false)
    expect(await repo.markRead('ib_x', 'a_x')).toBe(false)
    expect(await repo.markRead('ib_1', 'a_x')).toBe(true)
    const [item] = await repo.listForActor('a_x', { unreadOnly: false, limit: 5 })
    expect(item!.read).toBe(true)
    await db.destroy()
  })
})
```

`src/infra/sqlite/attachment-repo.test.ts` and `src/infra/sqlite/link-repo.test.ts` follow the same fixture idiom (seed actor + task, insert, read back, ordering `created_at,id`, dedupe lookers `findByTaskShaFilename` / `findByTaskKindUrl` incl. the null arms, `remove` then `find` → null). Cover every method on both repos.

- [ ] **Step 4.3: RED** — `pnpm test src/infra/sqlite` → missing modules.

- [ ] **Step 4.4: Implement `src/infra/sqlite/thread-repo.ts`:**

```ts
import { sql, type Kysely } from 'kysely'
import type {
  MessageRecord,
  OpenQuestionRow,
  ThreadDraft,
  ThreadRecord,
  ThreadRepo,
  ThreadWithMessages,
} from '#root/application/ports'
import type { QuestionState } from '#root/domain/discussion'
import type { DB, MessagesTable, ThreadsTable } from '#root/infra/sqlite/schema'

const toThread = (r: ThreadsTable): ThreadRecord => ({
  id: r.id,
  task_id: r.task_id,
  kind: r.kind,
  state: r.state,
  assignee_id: r.assignee_id,
  answer_message_id: r.answer_message_id,
  created_by: r.created_by,
  created_at: r.created_at,
  updated_at: r.updated_at,
})

const toMessage = (r: MessagesTable): MessageRecord => ({
  id: r.id,
  thread_id: r.thread_id,
  seq: r.seq,
  author_id: r.author_id,
  body: r.body,
  created_at: r.created_at,
})

export class SqliteThreadRepo implements ThreadRepo {
  constructor(private readonly db: Kysely<DB>) {}

  async create(draft: ThreadDraft): Promise<ThreadRecord> {
    const row = await this.db
      .insertInto('threads')
      .values(draft)
      .returningAll()
      .executeTakeFirstOrThrow()
    return toThread(row)
  }

  async find(id: string): Promise<ThreadRecord | null> {
    const r = await this.db
      .selectFrom('threads')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    return r ? toThread(r) : null
  }

  async listForTask(taskId: string): Promise<ThreadWithMessages[]> {
    const threads = await this.db
      .selectFrom('threads')
      .selectAll()
      .where('task_id', '=', taskId)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute()
    if (threads.length === 0) return []
    const messages = await this.db
      .selectFrom('messages')
      .selectAll()
      .where(
        'thread_id',
        'in',
        threads.map((t) => t.id)
      )
      .orderBy('seq', 'asc')
      .execute()
    const grouped = new Map<string, MessageRecord[]>()
    for (const m of messages) {
      const list = grouped.get(m.thread_id) ?? []
      list.push(toMessage(m))
      grouped.set(m.thread_id, list)
    }
    return threads.map((t) => ({ thread: toThread(t), messages: grouped.get(t.id) ?? [] }))
  }

  async appendMessage(input: {
    id: string
    threadId: string
    authorId: string
    body: string
    created_at: string
  }): Promise<MessageRecord> {
    // D-y: seq computed here (max+1 under the caller's transaction) — clock-free ordering
    const r = await sql<{ next: number }>`
      select coalesce(max(seq), 0) + 1 as next from messages where thread_id = ${input.threadId}
    `.execute(this.db)
    const seq = Number(r.rows[0]?.next ?? 1)
    const row = await this.db
      .insertInto('messages')
      .values({
        id: input.id,
        thread_id: input.threadId,
        seq,
        author_id: input.authorId,
        body: input.body,
        created_at: input.created_at,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return toMessage(row)
  }

  async setQuestionFields(
    threadId: string,
    patch: { state?: QuestionState; assignee_id?: string; answer_message_id?: string },
    updated_at: string
  ): Promise<void> {
    const values: Partial<ThreadsTable> = { updated_at }
    if (patch.state !== undefined) values.state = patch.state
    if (patch.assignee_id !== undefined) values.assignee_id = patch.assignee_id
    if (patch.answer_message_id !== undefined) values.answer_message_id = patch.answer_message_id
    await this.db.updateTable('threads').set(values).where('id', '=', threadId).execute()
  }

  async openHumanAssigned(taskId: string): Promise<number> {
    // Invariant 6 (spec §6.4.6, D-o): open question whose assignee is a human actor.
    const r = await sql<{ n: number }>`
      select count(*) as n from threads t
        join actors a on a.id = t.assignee_id
       where t.task_id = ${taskId} and t.kind = 'question'
         and t.state = 'open' and a.kind = 'human'
    `.execute(this.db)
    return Number(r.rows[0]?.n ?? 0)
  }

  async openQuestionsForTask(taskId: string): Promise<OpenQuestionRow[]> {
    const r = await sql<Omit<OpenQuestionRow, 'state'> & { state: string }>`
      select t.id, t.state, a.handle as assignee_handle,
        coalesce((select m.body from messages m
                   where m.thread_id = t.id order by m.seq limit 1), '') as question
        from threads t
        join actors a on a.id = t.assignee_id
       where t.task_id = ${taskId} and t.kind = 'question' and t.state = 'open'
       order by t.created_at, t.id
    `.execute(this.db)
    return r.rows.map((row) => ({ ...row, state: row.state as QuestionState }))
  }
}
```

- [ ] **Step 4.5: Implement `src/infra/sqlite/inbox-repo.ts`:**

```ts
import type { Kysely } from 'kysely'
import type { InboxItemDraft, InboxItemRecord, InboxRepo } from '#root/application/ports'
import type { DB, InboxItemsTable } from '#root/infra/sqlite/schema'

const toItem = (r: InboxItemsTable): InboxItemRecord => ({
  id: r.id,
  actor_id: r.actor_id,
  kind: r.kind,
  task_id: r.task_id,
  thread_id: r.thread_id,
  read: r.read === 1,
  created_at: r.created_at,
})

export class SqliteInboxRepo implements InboxRepo {
  constructor(private readonly db: Kysely<DB>) {}

  async add(draft: InboxItemDraft): Promise<void> {
    await this.db
      .insertInto('inbox_items')
      .values({ ...draft, read: 0 })
      .execute()
  }

  async listForActor(
    actorId: string,
    filter: { unreadOnly: boolean; limit: number }
  ): Promise<InboxItemRecord[]> {
    const base = this.db
      .selectFrom('inbox_items')
      .selectAll()
      .where('actor_id', '=', actorId)
      .orderBy('id', 'desc')
    const rows = await (filter.unreadOnly ? base.where('read', '=', 0) : base)
      .limit(filter.limit)
      .execute()
    return rows.map(toItem)
  }

  async markRead(itemId: string, actorId: string): Promise<boolean> {
    // owner-only by construction: the actor filter makes foreign ids simply not match
    const r = await this.db
      .updateTable('inbox_items')
      .set({ read: 1 })
      .where('id', '=', itemId)
      .where('actor_id', '=', actorId)
      .returning('id')
      .executeTakeFirst()
    return Boolean(r)
  }
}
```

- [ ] **Step 4.6: Implement `src/infra/sqlite/attachment-repo.ts` and `src/infra/sqlite/link-repo.ts`.** Same shape as the shipped `label-repo` (constructor `(private readonly db: Kysely<DB>)`, `toX` row mapper, `returningAll().executeTakeFirstOrThrow()` on add, `.executeTakeFirst()` → `null` arms). AttachmentRepo: `add(draft: AttachmentRecord)` inserts the full record; `find`, `listForTask` (order `created_at, id`), `findByTaskShaFilename(taskId, sha256, filename)`. LinkRepo: `add(draft: LinkDraft)`, `find`, `findByTaskKindUrl(taskId, kind, url)`, `remove(id)` (deleteWhere id), `listForTask` (order `created_at, id`).

- [ ] **Step 4.7: Wiring.** `src/infra/sqlite/uow.ts` — imports gain the four new repos; `repos(tx)` gains:

```ts
      threads: new SqliteThreadRepo(tx),
      inbox: new SqliteInboxRepo(tx),
      attachments: new SqliteAttachmentRepo(tx),
      links: new SqliteLinkRepo(tx),
```

`src/main/deps.ts` — same imports; `AppDeps` gains (root-connection section):

```ts
threadsRoot: SqliteThreadRepo
inboxRoot: SqliteInboxRepo
attachmentsRoot: SqliteAttachmentRepo
linksRoot: SqliteLinkRepo
```

and `makeDepsFromDb` the matching instances (`new SqliteThreadRepo(db)` etc.).

`src/testing/fixtures.ts` — append:

```ts
export const seedThread = async (
  db: Kysely<DB>,
  id: string,
  taskId: string,
  kind: 'note' | 'question' = 'note',
  patch: Partial<Pick<ThreadsTable, 'state' | 'assignee_id' | 'created_by'>> = {}
): Promise<string> => {
  await db
    .insertInto('threads')
    .values({
      id,
      task_id: taskId,
      kind,
      state: kind === 'question' ? (patch.state ?? 'open') : null,
      assignee_id: kind === 'question' ? (patch.assignee_id ?? 'a_agent') : null,
      answer_message_id: null,
      created_by: patch.created_by ?? 'a_creator',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    })
    .execute()
  return id
}

export const seedMessage = async (
  db: Kysely<DB>,
  id: string,
  threadId: string,
  seq: number,
  body: string
): Promise<string> => {
  await db
    .insertInto('messages')
    .values({
      id,
      thread_id: threadId,
      seq,
      author_id: 'a_creator',
      body,
      created_at: '2026-01-01T00:00:00.000Z',
    })
    .execute()
  return id
}
```

(`ThreadsTable` type import added to fixtures.)

- [ ] **Step 4.8: Verify + commit** — `pnpm test && pnpm lint && pnpm typecheck` (uow.test.ts stays green — `repos()` just grew):

```bash
git add -A
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(app): thread, inbox, attachment, link ports and sqlite repos"
```

> **Amendment (Task 3 ports note, carried into Task 4):** `InboxItemDraft.kind` ships as `InboxKind = InboxItemKind` (re-export of the domain single source, Task 3 carry-in) rather than the block's inline union re-declaration; `SqliteLinkRepo` correspondingly imports `LinkKind` from `#root/domain/discussion` — `ports.ts` does not re-export the vocabulary consts' member types it merely imports.

> **Amendment (Task 4, quality-of-block repairs):** Four repairs to the Step 4.x blocks. (1) The planned `openHumanAssigned` test could not go GREEN: `question({ id: 'th_q9', task_id: 't_2' })` assigns `a_ag` — an AGENT — so the final `expect(...('t_2')).toBe(1)` contradicts D-o (agent-assigned open questions must NOT count). Shipped: the create gains `assignee_id: 'a_h2'` (human) so the t_2 positive exercises the human arm, and the missing agent-arm expect — `expect(await repo.openHumanAssigned('t_1')).toBe(0)` right after the create — was added, pinning the exclusion the test title promises ("agent … excluded"). (2) The planned thread/inbox `setup`s miss `a_creator`: `seedTask` inserts `created_by 'a_creator'` under FK ON, so the as-written setups die with `FOREIGN KEY constraint failed`; shipped both setups seed `a_creator` first (the shipped task/label/dependency idiom). (3) `interface ThreadRecord extends ThreadDraft {}` / `interface LinkRecord extends LinkDraft {}` are hard errors under `@typescript-eslint/no-empty-object-type` (v8.58.2 recommended, `allowSingleExtends` defaults false — verified with a probe file); shipped as type aliases (`export type ThreadRecord = ThreadDraft`). (4) A small extra thread test (`lists empty results: no threads at all, and threads without messages`) covers the `listForTask` empty arms (`length === 0` and the `?? []` grouping default) that the block's tests leave unexercised. Steps 4.4/4.5 repos shipped byte-identical otherwise; 4.6 repos written per its descriptive spec (label-repo idiom, `created_at, id` ordering, dedupe finders with null arms) with the tests the step prescribes. Block sync = shipped form.

> **Amendment (Task 4, quality review):** Five repairs to the shipped form of `e7be978`. (A) **plan-wrong ordering:** Step 4.5's `listForActor` prescribed `.orderBy('id', 'desc')` — but ids are `RandomIdGen` output (16 random chars, `src/infra/ids.ts`), non-monotonic, so that is an arbitrary subset under `limit` while claiming newest-first. Shipped `.orderBy('created_at', 'desc').orderBy('id', 'desc')` (recency, `id` as deterministic tie-break). The inbox test was reworked to pin it: rows `ib_2` (newer) vs `ib_9` (older) put the ids in lexical order that CONTRADICTS recency — mutation-verified: the pre-fix ordering answers `['ib_9','ib_2']` and the test goes red; restored green — plus a same-timestamp tie case where `id desc` breaks it (`ib_7` before `ib_3`). (B) The `appendMessage` D-y comment gains the concurrency clause: racing appends serialize on the unique `(thread_id, seq)` backstop — the loser fails rather than writing a duplicate. (C) `seedThread` default assignee was `'a_agent'` — an actor the fixture never seeds, so the first default question call dies on the FK; shipped default `'a_ag'` with an idempotent `onConflict(id).doNothing()` insert of a valid agent row (`handle 'seed_agent'`), a no-op when the test already seeded `a_ag`. (D) The test helper's `over.kind === 'note' ? null : 'a_ag'` conditional dropped — unreachable input (callers never build notes via `question`), and it produced drafts the DDL CHECKs would reject confusingly; plain `assignee_id: 'a_ag'` with `...over` last. (E) Bookkeeping folded from `e7be978`'s undeclared delta: the third inbox test (per-actor isolation — `a_y` sees none of `a_x`'s items) was added there beyond the plan's two-test block; declared now. Lands in the child fix commit of `e7be978` (a commit cannot quote its own hash — resolve via `git log`). Block sync = shipped form.

---

### Task 5: CreateThread + AddMessage + mention routing (use-cases)

**Files:**

- Create: `src/application/usecases/create-thread.ts`, `add-message.ts`, `route-mentions.ts` (+ colocated tests `create-thread.test.ts`, `add-message.test.ts`)
- Modify: `src/main/deps.ts` (useCases wiring)

- [ ] **Step 5.1: Implement the shared mention router** `src/application/usecases/route-mentions.ts` (pure orchestration over ports — covered through Tasks 5/6 tests):

```ts
import { extractMentions } from '#root/domain/mentions'
import type { IdGen, Repos } from '#root/application/ports'

export interface MentionContext {
  actorId: string
  taskId: string
  threadId: string
  at: string
}

/**
 * D-q: route @mention inbox entries for a posted body. Unknown handles are dropped
 * (no actor to notify); the author is never notified of their own mention.
 */
export async function routeMentions(
  repos: Repos,
  ids: IdGen,
  body: string,
  ctx: MentionContext
): Promise<void> {
  for (const handle of extractMentions(body)) {
    const target = await repos.actors.findByHandle(handle)
    if (!target || target.id === ctx.actorId) continue
    await repos.inbox.add({
      id: ids.newId('ib'),
      actor_id: target.id,
      kind: 'mentioned',
      task_id: ctx.taskId,
      thread_id: ctx.threadId,
      created_at: ctx.at,
    })
  }
}
```

- [ ] **Step 5.2: Write the failing test** `src/application/usecases/create-thread.test.ts` (harness idiom: shared `buildUow/fixedClock/human/seqIds` from `create-task.test`; agent context added locally):

```ts
import { describe, expect, it } from 'vitest'
import { CreateTask } from '#root/application/usecases/create-task'
import { SplitTask } from '#root/application/usecases/split-task'
import { CreateThread } from '#root/application/usecases/create-thread'
import { SqliteInboxRepo } from '#root/infra/sqlite/inbox-repo'
import { SqliteAuditRepo } from '#root/infra/sqlite/audit-repo'
import { buildUow, fixedClock, human, seqIds } from '#root/application/usecases/create-task.test'
import { seedActor } from '#root/testing/fixtures'
import type { ActorContext, IdGen, UnitOfWork } from '#root/application/ports'

const ana: ActorContext = {
  actor: { id: 'a_ana', kind: 'human', handle: 'ana', display_name: 'Ana' },
  tokenId: null,
}

const setup = async () => {
  const { db, uow } = await buildUow() // seeds a_human (nils)
  await seedActor(db, 'a_ana', 'human', 'ana')
  await seedActor(db, 'a_agent', 'agent', 'hermes-1')
  const ids = seqIds()
  const task = await new CreateTask(uow, fixedClock(), ids).run({
    ...human,
    title: 'leaf',
    status: 'todo',
  })
  const uc = new CreateThread(uow, fixedClock(), ids)
  return { db, uow, ids, uc, taskId: task.id }
}

const question = (taskId: string) => ({
  taskId,
  kind: 'question' as const,
  body: 'which database?',
  assignee_id: 'a_ana',
})

describe('CreateThread (spec §6.5)', () => {
  it('creates a note thread with first message seq=1 and audits it', async () => {
    const { db, uc, taskId } = await setup()
    const r = await uc.run({ ...human, taskId, kind: 'note', body: 'plan: do the thing' })
    expect(r.thread).toMatchObject({ id: 'th_seq1', task_id: taskId, kind: 'note', state: null })
    expect(r.message).toMatchObject({ id: 'ms_seq2', seq: 1, body: 'plan: do the thing' })
    const audit = await new SqliteAuditRepo(db).search({
      entity_type: 'thread',
      entity_id: r.thread.id,
      limit: 5,
    })
    expect(audit[0]).toMatchObject({ action: 'thread_created', reason: 'thread created' })
    await db.destroy()
  })

  it('routes @mentions to mentioned inboxes — except author and unknown handles', async () => {
    const { db, uc, taskId } = await setup()
    await uc.run({
      ...human,
      taskId,
      kind: 'note',
      body: '@ana @nils and @ghost look',
    })
    const inbox = new SqliteInboxRepo(db)
    const anaItems = await inbox.listForActor('a_ana', { unreadOnly: false, limit: 10 })
    const nilsItems = await inbox.listForActor('a_human', { unreadOnly: false, limit: 10 })
    expect(anaItems.map((i) => i.kind)).toEqual(['mentioned']) // mentioned once
    expect(nilsItems).toEqual([]) // author never self-notifies (D-q)
    await db.destroy()
  })

  it('question requires an existing assignee, opens, and notifies them', async () => {
    const { db, uc, taskId } = await setup()
    await expect(uc.run({ ...human, taskId, kind: 'question', body: 'q' })).rejects.toMatchObject({
      code: 'invalid_request',
    })
    await expect(
      uc.run({ ...human, taskId, ...{ ...question(taskId), assignee_id: 'a_ghost' } })
    ).rejects.toMatchObject({ code: 'not_found' })
    const r = await uc.run({ ...human, ...question(taskId) })
    expect(r.thread).toMatchObject({ kind: 'question', state: 'open', assignee_id: 'a_ana' })
    const anaInbox = await new SqliteInboxRepo(db).listForActor('a_ana', {
      unreadOnly: false,
      limit: 10,
    })
    expect(anaInbox.map((i) => i.kind)).toEqual(['question_assigned'])
    await db.destroy()
  })

  it('an agent may self-assign a question without an inbox spam entry', async () => {
    const { db, uc, taskId } = await setup()
    const agent: ActorContext = {
      actor: { id: 'a_agent', kind: 'agent', handle: 'hermes-1', display_name: 'H' },
      tokenId: null,
    }
    const r = await uc.run({
      ...agent,
      taskId,
      kind: 'question',
      body: 'self-noted risk',
      assignee_id: 'a_agent',
    })
    expect(r.thread.state).toBe('open')
    expect(
      await new SqliteInboxRepo(db).listForActor('a_agent', { unreadOnly: false, limit: 5 })
    ).toEqual([])
    await db.destroy()
  })

  it('threads_on_parent gate: children block threads; human meta-note flag passes, agent flag does not (D-p)', async () => {
    const { db, uow, ids, uc } = await setup()
    const parent = await new CreateTask(uow, fixedClock(), ids).run({
      ...human,
      title: 'p',
      status: 'todo',
    })
    await new SplitTask(uow, fixedClock(), ids).run({
      ...human,
      taskId: parent.id,
      children: [{ title: 'c1' }],
    })
    await expect(
      uc.run({ ...human, taskId: parent.id, kind: 'note', body: 'x' })
    ).rejects.toMatchObject({ code: 'threads_on_parent' })
    const agent: ActorContext = {
      actor: { id: 'a_agent', kind: 'agent', handle: 'hermes-1', display_name: 'H' },
      tokenId: null,
    }
    await expect(
      uc.run({ ...agent, taskId: parent.id, kind: 'note', body: 'x', metaNote: true })
    ).rejects.toMatchObject({ code: 'threads_on_parent' }) // agents can't use the UI flag
    const r = await uc.run({
      ...human,
      taskId: parent.id,
      kind: 'note',
      body: 'decision: re-split',
      metaNote: true,
    })
    const audit = await new SqliteAuditRepo(db).search({
      entity_type: 'thread',
      entity_id: r.thread.id,
      limit: 5,
    })
    expect(audit[0]?.reason).toBe('meta-note on parent (spec §6.2)') // grep-pinned forward
    await db.destroy()
  })

  it('unknown task → not_found; bogus kind → invalid_request', async () => {
    const { db, uc } = await setup()
    await expect(
      uc.run({ ...human, taskId: 't_ghost', kind: 'note', body: 'x' })
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      uc.run({ ...human, taskId: 't_seq1', kind: 'flame' as never, body: 'x' })
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await db.destroy()
  })
})
```

- [ ] **Step 5.3: RED**, then **implement** `src/application/usecases/create-thread.ts`:

```ts
import { THREAD_KINDS, type ThreadKind } from '#root/domain/discussion'
import { DomainError } from '#root/domain/errors'
import type {
  ActorContext,
  Clock,
  IdGen,
  MessageRecord,
  ThreadRecord,
  UnitOfWork,
} from '#root/application/ports'
import { routeMentions } from '#root/application/usecases/route-mentions'

export interface CreateThreadInput extends ActorContext {
  taskId: string
  kind: ThreadKind
  body: string
  /** required for kind='question' (D-m: question always has an assignee) */
  assignee_id?: string
  /** D-p: UI-only escape hatch on a parent task; honored for human actors only */
  metaNote?: boolean
}

export interface CreateThreadResult {
  thread: ThreadRecord
  message: MessageRecord
}

export class CreateThread {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGen
  ) {}

  async run(input: CreateThreadInput): Promise<CreateThreadResult> {
    if (!THREAD_KINDS.includes(input.kind)) {
      throw new DomainError('invalid_request', `unknown thread kind '${input.kind}'`)
    }
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      const task = await repos.tasks.findById(input.taskId)
      if (!task) throw new DomainError('not_found', `task ${input.taskId} not found`)

      // spec §6.2: after a split the conversation moves to the children (D-p)
      const onParent = await repos.tasks.hasChildren(input.taskId)
      if (onParent) {
        if (!(input.metaNote === true && input.actor.kind === 'human')) {
          throw new DomainError(
            'threads_on_parent',
            `task ${input.taskId} has children; conversation lives on the leaves (spec §6.2)`
          )
        }
      }

      let assigneeId: string | null = null
      if (input.kind === 'question') {
        if (!input.assignee_id) {
          throw new DomainError('invalid_request', 'a question requires an assignee (spec §6.5)')
        }
        const assignee = await repos.actors.findById(input.assignee_id)
        if (!assignee) {
          throw new DomainError('not_found', `assignee ${input.assignee_id} not found`)
        }
        assigneeId = assignee.id
      }

      const thread = await repos.threads.create({
        id: this.ids.newId('th'),
        task_id: input.taskId,
        kind: input.kind,
        state: input.kind === 'question' ? 'open' : null,
        assignee_id: assigneeId,
        answer_message_id: null,
        created_by: input.actor.id,
        created_at: now,
        updated_at: now,
      })
      const message = await repos.threads.appendMessage({
        id: this.ids.newId('ms'),
        threadId: thread.id,
        authorId: input.actor.id,
        body: input.body,
        created_at: now,
      })

      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'thread_created',
        entity_type: 'thread',
        entity_id: thread.id,
        after: { kind: thread.kind, task_id: thread.task_id },
        reason: onParent ? 'meta-note on parent (spec §6.2)' : 'thread created',
        created_at: now,
      })

      await routeMentions(repos, this.ids, input.body, {
        actorId: input.actor.id,
        taskId: input.taskId,
        threadId: thread.id,
        at: now,
      })
      // D-r: question assignment notifies the assignee, never themselves
      if (assigneeId && assigneeId !== input.actor.id) {
        await repos.inbox.add({
          id: this.ids.newId('ib'),
          actor_id: assigneeId,
          kind: 'question_assigned',
          task_id: input.taskId,
          thread_id: thread.id,
          created_at: now,
        })
      }
      return { thread, message }
    })
  }
}
```

Wiring in `src/main/deps.ts`: import `CreateThread`, add `createThread: CreateThread` to the `useCases` interface and `createThread: new CreateThread(uow, clock, ids),` to the factory.

- [ ] **Step 5.4: Write the failing test** `src/application/usecases/add-message.test.ts` (same setup pattern): AddMessage to a note appends seq=2/3 and audits `message_created`; mentions route (author excluded); reply to a **question** thread does NOT change its state (answering is Task 6's explicit verb); unknown thread → not_found. Five `it()` blocks, e.g.:

```ts
it('appends ordered messages and audits each', async () => {
  const { db, uc, taskId, msgUc } = await setup()
  const t = await uc.run({ ...human, taskId, kind: 'note', body: 'first' })
  const m2 = await msgUc.run({ ...human, threadId: t.thread.id, body: '@ana second' })
  expect(m2.seq).toBe(2)
  const audit = await new SqliteAuditRepo(db).search({
    entity_type: 'thread',
    entity_id: t.thread.id,
    limit: 5,
  })
  expect(audit[0]).toMatchObject({ action: 'message_created' })
  const anaInbox = await new SqliteInboxRepo(db).listForActor('a_ana', {
    unreadOnly: false,
    limit: 5,
  })
  expect(anaInbox.map((i) => i.kind)).toEqual(['mentioned'])
  await db.destroy()
})
```

- [ ] **Step 5.5: Implement** `src/application/usecases/add-message.ts`:

```ts
import { DomainError } from '#root/domain/errors'
import type { ActorContext, Clock, IdGen, MessageRecord, UnitOfWork } from '#root/application/ports'
import { routeMentions } from '#root/application/usecases/route-mentions'

export interface AddMessageInput extends ActorContext {
  threadId: string
  body: string
}

export class AddMessage {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGen
  ) {}

  async run(input: AddMessageInput): Promise<MessageRecord> {
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      const thread = await repos.threads.find(input.threadId)
      if (!thread) throw new DomainError('not_found', `thread ${input.threadId} not found`)
      const message = await repos.threads.appendMessage({
        id: this.ids.newId('ms'),
        threadId: thread.id,
        authorId: input.actor.id,
        body: input.body,
        created_at: now,
      })
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'message_created',
        entity_type: 'thread',
        entity_id: thread.id,
        after: { message_id: message.id, seq: message.seq },
        reason: 'message created',
        created_at: now,
      })
      await routeMentions(repos, this.ids, input.body, {
        actorId: input.actor.id,
        taskId: thread.task_id,
        threadId: thread.id,
        at: now,
      })
      return message
    })
  }
}
```

Wire `addMessage: new AddMessage(uow, clock, ids)` into deps.

- [ ] **Step 5.6: Verify + commit:**

```bash
pnpm test && pnpm lint && pnpm typecheck
git add -A
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(app): thread creation, replies, mention routing to inbox"
```

> **Amendment (Task 5, id-counter sharing + spread repair):** Three repairs to the Step 5.x blocks. (1) The planned `setup()` shared one `seqIds()` between `CreateTask` and `CreateThread`, but the task consumes `t_seq1` first — the thread would mint `th_seq2`, contradicting the block's own `th_seq1`/`ms_seq2` expectations. Shipped: the task keeps `ids`, while `CreateThread` (and in `add-message.test` both thread-side use-cases) run on a **fresh, thread-side** `seqIds()` — in `add-message.test` the two use-cases must share that one counter, because separate instances mint `ms_seq2` twice (`uc`'s first message vs `msgUc`'s second → observed live as `UNIQUE constraint failed: messages.id`). (2) The missing-assignee case was written `uc.run({ ...human, taskId, ...{ ...question(taskId), assignee_id: 'a_ghost' } })` — a spread overwriting the explicit `taskId` is hard error TS2783; shipped the equivalent single spread `{ ...human, ...question(taskId), assignee_id: 'a_ghost' }` (same values, one source). (3) Step 5.4 prescribed "five `it()` blocks, e.g." with one sketch block — shipped all five: append seq=2 + `message_created` audit + mention routing (the sketch, verbatim), third message seq=3, author-never-self-notifies on replies, reply-to-open-question leaves `state: 'open'`/`answer_message_id: null` (answering stays Task 6's verb), unknown thread `not_found`. Note: the harness import of `create-task.test` re-registers its 6 cases inside each importer (12 across the two new importers) — pre-existing idiom from Plan A, duplicate runs are hermetic and harmless. `route-mentions.ts`, `create-thread.ts`, `add-message.ts` and the deps wiring shipped byte-identical to the blocks. Block sync = shipped form.

> **Amendment (Task 5, quality review):** Three repairs to the shipped form of `69a1bb3` — the Step 5.3 block itself shares bug (1). (1) **D-p note-arm missing:** the block's gate condition `!(input.metaNote === true && input.actor.kind === 'human')` rescues ANY kind, so human + `kind: 'question'` + `metaNote: true` on a split parent returned 201 — binding D-p honors the flag "only for human actors posting a note". Shipped, positive-by-construction: `const metaNoteAllowed = input.metaNote === true && input.actor.kind === 'human' && input.kind === 'note'` with `if (onParent && !metaNoteAllowed) { … }`; the `metaNote?` doc line now reads "honored for human actors posting a note only"; the D-p test gains one probe — human + parent + `kind: 'question'` + `metaNote: true` rejects `threads_on_parent` (verified RED on the old gate: the run answered "promise resolved … instead of rejecting"; GREEN after). (2) The `thread_created` audit `after` carried only `{ kind, task_id }`; it now also records the opening message — `message_id: message.id, seq: message.seq` (the `add-message` `{ message_id, seq }` shape; `message.seq` is 1 by construction for a thread opener, read back rather than hardcoded) — and the create test pins `after: { kind: 'note', task_id, message_id: 'ms_seq2', seq: 1 }`, so a thread's message history is audit-reconstructable. (3) The block's dead `ana` context const (declared, never used) deleted from `create-thread.test.ts`. Bookkeeping folded from the spec review: (a) the prior amendment's re-registration wording is corrected in place to "6 cases inside each importer (12 across the two new importers)"; (b) the test file's type import ships slim — the block's `import type { ActorContext, IdGen, UnitOfWork }` reduces to `import type { ActorContext }` (`IdGen`/`UnitOfWork` are unused in the block: harness returns carry the values, and the setup's locals infer). Lands in the child fix commit of `69a1bb3` (a commit cannot quote its own hash — resolve via `git log`). Block sync = shipped form.

---

### Task 6: Question lifecycle — answer + state transitions + reassignment (use-cases)

**Files:**

- Create: `src/application/usecases/answer-question.ts`, `update-question.ts` (+ colocated tests)
- Modify: `src/main/deps.ts` (useCases wiring)

- [ ] **Step 6.1: Write the failing tests.** `answer-question.test.ts`:

```ts
// setup as in create-thread.test (human nils, human ana, agent hermes-1, task t_seq1)
// it 1: human answer appends message, links answer, open → answered, audit question_answered
// it 2: answering a NOTE thread → invalid_request; unknown thread → not_found
// it 3: answering an already-answered question → question_transition (D-n)
// it 4: answer body mentions route mentioned inbox (author excluded)
```

Full first test (pattern for the rest):

```ts
it('human answer appends a message, links it and moves open → answered', async () => {
  const { db, threadUc, answerUc, taskId } = await setup()
  const q = await threadUc.run({ ...human, ...question(taskId) })
  const r = await answerUc.run({ ...ana, threadId: q.thread.id, body: 'sqlite, WAL' })
  expect(r.message).toMatchObject({ seq: 2, author_id: 'a_ana' })
  expect(r.thread).toMatchObject({ state: 'answered', answer_message_id: r.message.id })
  const audit = await new SqliteAuditRepo(db).search({
    entity_type: 'thread',
    entity_id: q.thread.id,
    limit: 5,
  })
  expect(audit[0]).toMatchObject({ action: 'question_answered', reason: 'question answered' })
  await db.destroy()
})
```

`update-question.test.ts`:

```ts
// it 1: answered → resolved ok; audit question_state_changed; terminal → question_transition
// it 2: open → resolved rejected (D-n: resolve implies answered); open → wont_fix allowed
// it 3: reassign to a different actor → assignee changes, question_assigned inbox, audit question_reassigned
// it 4: reassign to self → no inbox entry (D-r); unknown assignee → not_found; note thread → invalid_request
// it 5: bogus state string → invalid_request (route schema is the edge guard; use-case stays uniform)
```

- [ ] **Step 6.2: RED**, then **implement** `src/application/usecases/answer-question.ts`:

```ts
import { DomainError } from '#root/domain/errors'
import type {
  ActorContext,
  Clock,
  IdGen,
  MessageRecord,
  ThreadRecord,
  UnitOfWork,
} from '#root/application/ports'
import { routeMentions } from '#root/application/usecases/route-mentions'

export interface AnswerQuestionInput extends ActorContext {
  threadId: string
  body: string
}

export interface AnswerResult {
  message: MessageRecord
  thread: ThreadRecord
}

/** D-n: answering is its own verb — message + link + open→answered, one transaction. */
export class AnswerQuestion {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGen
  ) {}

  async run(input: AnswerQuestionInput): Promise<AnswerResult> {
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      const thread = await repos.threads.find(input.threadId)
      if (!thread) throw new DomainError('not_found', `thread ${input.threadId} not found`)
      if (thread.kind !== 'question') {
        throw new DomainError('invalid_request', 'only question threads can be answered')
      }
      if (thread.state !== 'open') {
        throw new DomainError('question_transition', `question is '${thread.state}', not 'open'`, {
          state: thread.state,
        })
      }
      const message = await repos.threads.appendMessage({
        id: this.ids.newId('ms'),
        threadId: thread.id,
        authorId: input.actor.id,
        body: input.body,
        created_at: now,
      })
      await repos.threads.setQuestionFields(
        thread.id,
        { state: 'answered', answer_message_id: message.id },
        now
      )
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'question_answered',
        entity_type: 'thread',
        entity_id: thread.id,
        before: { state: 'open' },
        after: { state: 'answered', answer_message_id: message.id },
        reason: 'question answered',
        created_at: now,
      })
      await routeMentions(repos, this.ids, input.body, {
        actorId: input.actor.id,
        taskId: thread.task_id,
        threadId: thread.id,
        at: now,
      })
      return { message, thread: (await repos.threads.find(thread.id)) as ThreadRecord }
    })
  }
}
```

**implement** `src/application/usecases/update-question.ts`:

```ts
import { QUESTION_STATES, canTransitionQuestion, type QuestionState } from '#root/domain/discussion'
import { DomainError } from '#root/domain/errors'
import type { ActorContext, Clock, IdGen, ThreadRecord, UnitOfWork } from '#root/application/ports'

export interface UpdateQuestionInput extends ActorContext {
  threadId: string
  state?: QuestionState
  assignee_id?: string
}

/** D-n/D-r/D-x: resolve/close and re-assign; every actor may act (nothing hidden). */
export class UpdateQuestion {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGen
  ) {}

  async run(input: UpdateQuestionInput): Promise<ThreadRecord> {
    if (input.state !== undefined && !QUESTION_STATES.includes(input.state)) {
      throw new DomainError('invalid_request', `unknown question state '${input.state}'`)
    }
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      const thread = await repos.threads.find(input.threadId)
      if (!thread) throw new DomainError('not_found', `thread ${input.threadId} not found`)
      if (thread.kind !== 'question') {
        throw new DomainError('invalid_request', 'only question threads can be updated')
      }
      let changed = false

      if (input.assignee_id !== undefined && input.assignee_id !== thread.assignee_id) {
        const assignee = await repos.actors.findById(input.assignee_id)
        if (!assignee) throw new DomainError('not_found', `assignee ${input.assignee_id} not found`)
        await repos.threads.setQuestionFields(thread.id, { assignee_id: assignee.id }, now)
        await repos.audit.append({
          actor_id: input.actor.id,
          token_id: input.tokenId,
          action: 'question_reassigned',
          entity_type: 'thread',
          entity_id: thread.id,
          before: { assignee_id: thread.assignee_id },
          after: { assignee_id: assignee.id },
          reason: 'question reassigned',
          created_at: now,
        })
        if (assignee.id !== input.actor.id) {
          await repos.inbox.add({
            id: this.ids.newId('ib'),
            actor_id: assignee.id,
            kind: 'question_assigned',
            task_id: thread.task_id,
            thread_id: thread.id,
            created_at: now,
          })
        }
        changed = true
      }

      if (input.state !== undefined && input.state !== thread.state) {
        if (!thread.state || !canTransitionQuestion(thread.state, input.state)) {
          throw new DomainError(
            'question_transition',
            `illegal transition ${thread.state} → ${input.state} (decision D-n)`,
            { from: thread.state, to: input.state }
          )
        }
        await repos.threads.setQuestionFields(thread.id, { state: input.state }, now)
        await repos.audit.append({
          actor_id: input.actor.id,
          token_id: input.tokenId,
          action: 'question_state_changed',
          entity_type: 'thread',
          entity_id: thread.id,
          before: { state: thread.state },
          after: { state: input.state },
          reason: 'question state changed',
          created_at: now,
        })
        changed = true
      }

      return (changed ? await repos.threads.find(thread.id) : thread) as ThreadRecord
    })
  }
}
```

- [ ] **Step 6.3: Wiring + verify + commit** — `answerQuestion: new AnswerQuestion(uow, clock, ids)`, `updateQuestion: new UpdateQuestion(uow, clock, ids)` in deps:

```bash
pnpm test && pnpm lint && pnpm typecheck
git add -A
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(app): question answer, transitions and reassignment"
```

> **Amendment (Task 6, table delegation + dead-arm-free guards):** Two repairs to the Step 6.2 blocks, plus test realization. (1) The `AnswerQuestion` block gated with the hand-coded `if (thread.state !== 'open')` — ad-hoc transition logic in the use-case layer; shipped as delegation to the D-n table: `if (!canTransitionQuestion(thread.state as QuestionState, 'answered'))` (same verdict for every state, single authority). Companion: the `question_answered` audit `before` now reads `{ state: thread.state }` (read-back, honest) instead of the block's hardcoded `{ state: 'open' }`. (2) Both blocks leaned on `!thread.state || !canTransitionQuestion(…)` — the `!thread.state` true-arm is DDL-unreachable (`check ((kind = 'question') = (state is not null))` + the kind guard), a permanently-partial branch; shipped `thread.state as QuestionState` with a comment stating the cast's totality, leaving the table as the only decision point and both new files at 100% branch coverage. (3) Step 6.1 gave bullet specs (+ one verbatim test): `answer-question.test.ts` ships the four bullets — the verbatim flow test, note/unknown guards, bullet 3 extended to pin delegation on BOTH sides (answered→answered reject AND terminal resolved→answer reject), bullet 4 pinning both inboxes (author self-mention skipped, `nils` notified); `update-question.test.ts` ships the five bullets — bullet 1 as the full delegation walk (open→answered audit fields, answered→open reject, answered→resolved, and ALL THREE terminal rejections `open`/`answered`/`wont_fix`), open→resolved reject + open→wont_fix allow, reassign with audit fields and the new holder's `question_assigned`, self-reassign silent (D-r) with the four guard arms (unknown thread/assignee, note thread, bogus state via `as never`), and a no-op pin (same assignee + same state leaves audit exactly `['thread_created']` — the `changed === false` return path). Both setups share one thread-side `seqIds()` across the use-cases, per the Task 5 amendment. `update-question.ts` shipped byte-identical to its block otherwise; deps wiring per Step 6.3. Block sync = shipped form.

> **Amendment (Task 6, quality review):** Four minors unified for Task 7's machine contract — three change block-verbatim lines in `answer-question.ts` (the block itself wrote the old shapes): (1) the `question_transition` details payload is unified with `update-question`'s vocabulary — `{ state: thread.state }` → `{ from: thread.state, to: 'answered' }`; pinned by extending the double-answer delegation probe's expect with `details: { from: 'answered', to: 'answered' }`. (2) The `question_answered` audit `after` gains `seq: message.seq` (the Task 5 `{ message_id, seq }` precedent); pinned in the flow test with `after: { state: 'answered', answer_message_id: r.message.id, seq: 2 }`. (3) Both re-find `as ThreadRecord` casts (`answer-question` return, `update-question` return) carry the `manage-actors.ts` phrasing: "Plan-verbatim cast: null arm unreachable — the row was just written on this transaction." (4) Above `let changed` in `update-question.ts`, a comment records the semantics: the reassign/state arms act independently, the transaction makes the compound all-or-nothing, and state legality is judged against the PRE-CALL state (the D-n table is keyed on state only; reassignment never moves it). Lands in the child fix commit of `32d3daa` (a commit cannot quote its own hash — resolve via `git log`). Block sync = shipped form.

---

### Task 7: REST thread surface + contract (routes, DTOs, yaml)

**Files:**

- Create: `src/adapters/rest/routes/threads.ts` (+ `threads.test.ts`)
- Modify: `src/adapters/rest/app.ts`, `src/adapters/rest/dto.ts`, `openapi/openapi.yaml`, `openapi/openapi.yaml` context description

- [ ] **Step 7.1: Write the failing test** `src/adapters/rest/routes/threads.test.ts` — idiom from `tasks.test.ts`/`admin.test.ts` (makeTestApp + bearer helper; create a task first, agent actor via admin endpoints). Cover:

```ts
// it 1: POST /tasks/:id/threads (note, @ana mention) → 201 {thread, message}; ana's GET /inbox later
// it 2: POST question with assignee_handle → 201, thread.state='open'; missing assignee_handle → 400 invalid_request
// it 3: GET /tasks/:id/threads → threads oldest-first with ordered messages
// it 4: POST /tasks/:id/threads/:tid/messages → 201 seq 2; unknown thread 404
// it 5: POST …/answer → 200 thread answered; double answer → 409 question_transition
// it 6: PATCH …/threads/:tid {state:'resolved'} after answer → 200; open→resolved → 409 question_transition
// it 7: PATCH …/threads/:tid {assignee_handle:'hermes-1'} → 200 + hermes-1 inbox question_assigned
// it 8: thread on a split parent → 409 threads_on_parent; ?meta_note=true as admin human → 201
// it 9: PATCH note thread → 400 invalid_request; body schema rejects unknown fields (400)
```

Representative blocks (rest follow the shipped `tasks.test.ts` idiom verbatim — `t.app.inject`, bearer headers):

```ts
it('POST /tasks/:id/threads creates a note with first message', async () => {
  const t = await makeTestApp()
  const task = (
    await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: bearer(t.adminToken),
      payload: { title: 'threadable', status: 'todo' },
    })
  ).json()
  const res = await t.app.inject({
    method: 'POST',
    url: `/tasks/${task.id}/threads`,
    headers: bearer(t.adminToken),
    payload: { kind: 'note', body: '@ana heads up' },
  })
  expect(res.statusCode).toBe(201)
  expect(res.json()).toMatchObject({
    thread: { kind: 'note', state: null, task_id: task.id },
    message: { seq: 1, body: '@ana heads up' },
  })
  expect(res.json().thread.id).toMatch(/^th_[a-z0-9]{16}$/) // RandomIdGen family (D-z)
  await t.close()
})

it('question creation requires an assignee and lands open', async () => {
  const t = await makeTestApp()
  const anaId = (
    await t.app.inject({
      method: 'POST',
      url: '/admin/actors',
      headers: bearer(t.adminToken),
      payload: { kind: 'human', handle: 'ana', display_name: 'Ana' },
    })
  ).json().id as string
  void anaId
  const task = (
    await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: bearer(t.adminToken),
      payload: { title: 'q host', status: 'todo' },
    })
  ).json()
  const missing = await t.app.inject({
    method: 'POST',
    url: `/tasks/${task.id}/threads`,
    headers: bearer(t.adminToken),
    payload: { kind: 'question', body: 'which?' },
  })
  expect(missing.statusCode).toBe(400)
  expect(missing.json().code).toBe('invalid_request')
  const ok = await t.app.inject({
    method: 'POST',
    url: `/tasks/${task.id}/threads`,
    headers: bearer(t.adminToken),
    payload: { kind: 'question', body: 'which?', assignee_handle: 'ana' },
  })
  expect(ok.statusCode).toBe(201)
  expect(ok.json().thread).toMatchObject({ kind: 'question', state: 'open' })
  await t.close()
})
```

Assignee is addressed by `assignee_handle` over REST (handles are the public actor vocabulary); the route resolves handle→id via `handleToId` (below) — unknown handle ⇒ 404 `not_found`.

- [ ] **Step 7.2: Implement `src/adapters/rest/dto.ts`** — append:

```ts
import type { ThreadWithMessages } from '#root/application/ports'

// Threads/messages pass through as composed (ports.ts shapes), same convention as
// SplitTaskResult/ContextBundle — the DTO file owns only the flat-task DTO.
export const toThreadDto = (tw: ThreadWithMessages) => tw
```

(No field renaming is warranted; the alias documents the boundary and gives the drift test one import surface. If reviewers prefer zero indirection they may delete it and pass the use-case results through — record as an amendment either way.)

- [ ] **Step 7.3: Implement `src/adapters/rest/routes/threads.ts`:**

```ts
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import type { QuestionState } from '#root/domain/discussion'
import type { ThreadKind } from '#root/domain/discussion'
import { actorCtx } from '#root/adapters/rest/auth'
import { DomainError } from '#root/domain/errors'

const kindEnum = { type: 'string', enum: ['note', 'question'] } as const
const stateEnum = { type: 'string', enum: ['open', 'answered', 'resolved', 'wont_fix'] } as const

// REST speaks handles (public actor vocabulary); use-cases speak ids (ports.ts).
// The route resolves handle → id; unknown handle → 404 not_found from the use-case.
async function handleToId(deps: AppDeps, handle: string): Promise<string> {
  const rows = await deps.actorsRoot.list()
  const hit = rows.find((a) => a.handle === handle)
  if (!hit) throw new DomainError('not_found', `actor '@${handle}' not found`)
  return hit.id
}

export const registerThreadRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  app.get('/tasks/:id/threads', async (request) => {
    const { id } = request.params as { id: string }
    return deps.threadsRoot.listForTask(id)
  })

  app.post(
    '/tasks/:id/threads',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { meta_note: { type: 'boolean' } },
        },
        body: {
          type: 'object',
          required: ['kind', 'body'],
          additionalProperties: false,
          properties: {
            kind: kindEnum,
            body: { type: 'string', minLength: 1, maxLength: 20000 },
            assignee_handle: { type: 'string', minLength: 1, maxLength: 60 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const q = request.query as { meta_note?: boolean }
      const body = request.body as { kind: ThreadKind; body: string; assignee_handle?: string }
      const assigneeId = body.assignee_handle
        ? await handleToId(deps, body.assignee_handle)
        : undefined
      const result = await deps.useCases.createThread.run({
        taskId: id,
        kind: body.kind,
        body: body.body,
        assignee_id: assigneeId,
        metaNote: q.meta_note,
        ...actorCtx(request), // actorCtx LAST (binding)
      })
      return reply.code(201).send(result)
    }
  )

  app.post(
    '/tasks/:id/threads/:tid/messages',
    {
      schema: {
        body: {
          type: 'object',
          required: ['body'],
          additionalProperties: false,
          properties: { body: { type: 'string', minLength: 1, maxLength: 20000 } },
        },
      },
    },
    async (request, reply) => {
      const { tid } = request.params as { id: string; tid: string }
      const { body } = request.body as { body: string }
      const message = await deps.useCases.addMessage.run({
        threadId: tid,
        body,
        ...actorCtx(request),
      })
      return reply.code(201).send(message)
    }
  )

  app.post(
    '/tasks/:id/threads/:tid/answer',
    {
      schema: {
        body: {
          type: 'object',
          required: ['body'],
          additionalProperties: false,
          properties: { body: { type: 'string', minLength: 1, maxLength: 20000 } },
        },
      },
    },
    async (request) => {
      const { tid } = request.params as { id: string; tid: string }
      const { body } = request.body as { body: string }
      return deps.useCases.answerQuestion.run({ threadId: tid, body, ...actorCtx(request) })
    }
  )

  app.patch(
    '/tasks/:id/threads/:tid',
    {
      schema: {
        body: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: {
            state: stateEnum,
            assignee_handle: { type: 'string', minLength: 1, maxLength: 60 },
          },
        },
      },
    },
    async (request) => {
      const { tid } = request.params as { id: string; tid: string }
      const body = request.body as { state?: QuestionState; assignee_handle?: string }
      const assigneeId = body.assignee_handle
        ? await handleToId(deps, body.assignee_handle)
        : undefined
      return deps.useCases.updateQuestion.run({
        threadId: tid,
        state: body.state,
        assignee_id: assigneeId,
        ...actorCtx(request), // actorCtx LAST (binding)
      })
    }
  )
}
```

Register in `app.ts`: import `registerThreadRoutes`; call after `registerTaskRoutes(server, deps)` (threads are task-surface):

```ts
registerThreadRoutes(server, deps)
```

- [ ] **Step 7.4: Contract.** Append to `openapi/openapi.yaml` under `paths:` (match existing style; every new route documented or the drift test fails):

```yaml
/tasks/{id}/threads:
  parameters: [{ $ref: '#/components/parameters/TaskId' }]
  get:
    tags: [threads]
    operationId: listThreads
    description: threads oldest-first, each with ordered messages (spec §6.5)
    responses:
      '200':
        description: thread list
        content:
          application/json:
            schema: { type: array, items: { $ref: '#/components/schemas/ThreadWithMessages' } }
      default: { $ref: '#/components/responses/Problem' }
  post:
    tags: [threads]
    operationId: createThread
    description: >-
      kind=question requires assignee_handle and opens a review-gating question
      (spec §6.4.6); 409 threads_on_parent on a task with children — humans may
      pass ?meta_note=true (UI-only flag, audited, spec §6.2)
    parameters:
      - { name: meta_note, in: query, schema: { type: boolean } }
    requestBody:
      required: true
      content:
        application/json:
          schema:
            type: object
            required: [kind, body]
            additionalProperties: false
            properties:
              kind: { type: string, enum: [note, question] }
              body: { type: string, minLength: 1, maxLength: 20000 }
              assignee_handle: { type: string, minLength: 1, maxLength: 60 }
    responses:
      '201':
        description: thread with its first message
        content:
          application/json:
            schema: { $ref: '#/components/schemas/ThreadWithMessages' }
      default: { $ref: '#/components/responses/Problem' }
/tasks/{id}/threads/{tid}/messages:
  parameters:
    - { $ref: '#/components/parameters/TaskId' }
    - { name: tid, in: path, required: true, schema: { type: string } }
  post:
    tags: [threads]
    operationId: addThreadMessage
    description: reply to a thread; @handles in body route inbox entries (spec §6.5)
    requestBody:
      required: true
      content:
        application/json:
          schema:
            type: object
            required: [body]
            additionalProperties: false
            properties: { body: { type: string, minLength: 1, maxLength: 20000 } }
    responses:
      '201':
        description: appended message
        content:
          application/json:
            schema: { $ref: '#/components/schemas/Message' }
      default: { $ref: '#/components/responses/Problem' }
/tasks/{id}/threads/{tid}/answer:
  parameters:
    - { $ref: '#/components/parameters/TaskId' }
    - { name: tid, in: path, required: true, schema: { type: string } }
  post:
    tags: [threads]
    operationId: answerQuestionThread
    description: appends the answer message, links it, open → answered (409 question_transition otherwise)
    requestBody:
      required: true
      content:
        application/json:
          schema:
            type: object
            required: [body]
            additionalProperties: false
            properties: { body: { type: string, minLength: 1, maxLength: 20000 } }
    responses:
      '200':
        description: answer + updated thread
        content:
          application/json:
            schema:
              type: object
              properties:
                message: { $ref: '#/components/schemas/Message' }
                thread: { $ref: '#/components/schemas/Thread' }
      default: { $ref: '#/components/responses/Problem' }
/tasks/{id}/threads/{tid}:
  parameters:
    - { $ref: '#/components/parameters/TaskId' }
    - { name: tid, in: path, required: true, schema: { type: string } }
  patch:
    tags: [threads]
    operationId: updateQuestionThread
    description: state ∈ {resolved, wont_fix} per D-n transitions; assignee_handle re-assigns (inbox)
    requestBody:
      required: true
      content:
        application/json:
          schema:
            type: object
            minProperties: 1
            additionalProperties: false
            properties:
              state: { type: string, enum: [open, answered, resolved, wont_fix] }
              assignee_handle: { type: string, minLength: 1, maxLength: 60 }
    responses:
      '200':
        description: updated thread
        content:
          application/json:
            schema: { $ref: '#/components/schemas/Thread' }
      default: { $ref: '#/components/responses/Problem' }
```

Add `threads` to the top-level `tags:` list. Add to `components.schemas`:

```yaml
Thread:
  type: object
  description: thread row (ports.ts ThreadRecord); question fields NULL for notes (D-m)
  properties:
    id: { type: string }
    task_id: { type: string }
    kind: { type: string, enum: [note, question] }
    state: { type: ['string', 'null'], enum: ['open', 'answered', 'resolved', 'wont_fix', null] }
    assignee_id: { type: ['string', 'null'] }
    answer_message_id: { type: ['string', 'null'] }
    created_by: { type: string }
    created_at: { type: string }
    updated_at: { type: string }
Message:
  type: object
  properties:
    id: { type: string }
    thread_id: { type: string }
    seq: { type: integer }
    author_id: { type: string }
    body: { type: string }
    created_at: { type: string }
ThreadWithMessages:
  type: object
  description: thread + its messages ordered by seq (spec §6.5)
  properties:
    thread: { $ref: '#/components/schemas/Thread' }
    messages: { type: array, items: { $ref: '#/components/schemas/Message' } }
```

- [ ] **Step 7.5: Verify + commit** — `pnpm test && pnpm lint && pnpm typecheck`; the path×method drift test proves yaml ⇄ served routes (note: `handleToId` uses `actorsRoot.list()` for now — O(actors), fine at this scale; a `findByHandle` root-repo call is the reviewer's obvious micro-fix if flagged, ship as amendment):

```bash
git add -A
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(api): thread, question and answer endpoints + contract"
```

> **Amendment (Task 7, response-schema fidelity + stack realities):** Four deviations from the blocks, all probe-or-precedent-backed. (1) The Step 7.4 yaml referenced `ThreadWithMessages` (`{thread, messages[]}`) for the create-201, but `CreateThread` returns `{thread, message}` (singular first message) — shipped the response schema as an inline `{thread, message}` object (same style as the answer-200 block) so the contract describes what is actually sent. (2) Step 7.2's `toThreadDto` identity alias was **not** added — exercising the block's own granted escape ("if reviewers prefer zero indirection they may delete it… record as an amendment"): an export no route called would be dead code, and the routes pass the ports shapes through directly. (3) Bullet 9's "body schema rejects unknown fields (400)" does not hold on this stack: fastify 5.12.3's bundled schema compiler enforces `required`/`enum`/`minLength` (pinned by shipped `tasks.test.ts`) but strips extra keys silently — probe-verified against the shipped `POST /tasks` (extra key → 201). The test now pins that parity (extra key on create-thread → 201), keeping every surface's behavior identical; stricter rejection would be an app-wide compiler change beyond this task. (4) Test idiom adaptations: the local `bearer(t)` helper takes `TestApp` (the shipped `tasks.test.ts` helper shape; the block's sketch passed `t.adminToken`), the list-order test sleeps 2 ms between creates because `SystemClock` is millisecond-resolution and a same-ms tie would order by random id, and inbox assertions read `t.deps.inboxRoot` directly since `GET /inbox` is Task 9's surface; the block's unknown-handle 404 probe was folded into the question test. `handleToId` keeps the block's `actorsRoot.list()` scan per its own note. `routes/threads.ts`, the `app.ts` registration, and the yaml path/schema bodies otherwise shipped byte-identical (modulo yaml quote normalization by prettier). Block sync = shipped form.

> **Amendment (Task 7, quality review):** Three post-approval repairs to `routes/threads.ts` (+test pins), and one platform item explicitly NOT taken. (1) The prior amendment's "keeps `list()` per its note" is superseded: `handleToId` now uses the indexed `deps.actorsRoot.findByHandle(handle)` — same match semantics, no scan — and the block's comment was truth-fixed: the unknown-handle 404 originates in the ROUTE layer (`handleToId`), not "from the use-case" as the block claimed. (2) `GET /tasks/:id/threads` gained a shipped-beyond-block existence check mirroring the sibling `GET /tasks/:id` idiom — `if (!task) throw new DomainError('not_found', `` `task ${id} not found` ``)` after `deps.tasksRoot.findById(id)` — so a typo'd task id 404s instead of masquerading as an empty discussion (pinned by a ghost-id probe in the list test, RED pre-fix as `expected 200 to be 404`; the path's `default: Problem` yaml already covers it, no contract change). (3) The REST double-answer pin asserts the T6-unified transition shape at the boundary agents meet — on the wire that means TOP-LEVEL `from: 'answered', to: 'answered'` beside `code`, because `problem.ts` spreads `DomainError.details` flat (stale_lease precedent); the review's literal nested `details:` key does not exist in the problem+json envelope, and the test pins the actual wire. SKIPPED BY DECISION (recorded, not implemented): making extra body keys 400 (removing fastify's silent `removeAdditional` stripping) is a contract-wide change flipping every surface including shipped parity tests — deferred as a human decision beyond this plan. Lands in the child fix commit of `66d49c6` (a commit cannot quote its own hash — resolve via `git log`). Block sync = shipped form.

---

### Task 8: Invariant 6 — the review gate wired

**Files:**

- Modify: `src/application/usecases/update-status.ts` (+ `update-status.test.ts`)
- Test: REST-level 409 in `src/adapters/rest/routes/threads.test.ts` (append)

- [ ] **Step 8.1: Write the failing test.** Append to `src/application/usecases/update-status.test.ts` (reuse its `setup`/harness — agent actor context exists there as `agent` per the shipped file):

```ts
it('invariant 6 (D-o): open human-assigned question gates agent in_review with 409 open_questions', async () => {
  const { db, uow, ids } = await setup()
  const task = await new CreateTask(uow, fixedClock(), ids).run({
    ...human,
    title: 'gated',
    status: 'todo',
  })
  const claim = await new ClaimTask(uow, fixedClock()).run({ ...agent, taskId: task.id })
  await new CreateThread(uow, fixedClock(), ids).run({
    ...agent,
    taskId: task.id,
    kind: 'question',
    body: 'which API?',
    assignee_id: 'a_human',
  })
  await expect(
    new UpdateStatus(uow, fixedClock()).run({
      ...agent,
      taskId: task.id,
      to: 'in_review',
      reason: 'pr ready',
      lease_token: claim.lease_token,
    })
  ).rejects.toMatchObject({ code: 'open_questions', details: { open: 1 } })
  await db.destroy()
})

it('invariant 6: a human answer lifts the gate on the same live lease (§14.5)', async () => {
  const { db, uow, ids } = await setup()
  const task = await new CreateTask(uow, fixedClock(), ids).run({
    ...human,
    title: 'gated',
    status: 'todo',
  })
  const claim = await new ClaimTask(uow, fixedClock()).run({ ...agent, taskId: task.id })
  const q = await new CreateThread(uow, fixedClock(), ids).run({
    ...agent,
    taskId: task.id,
    kind: 'question',
    body: 'which API?',
    assignee_id: 'a_human',
  })
  await new AnswerQuestion(uow, fixedClock(), ids).run({
    ...human,
    threadId: q.thread.id,
    body: 'REST',
  })
  await expect(
    new UpdateStatus(uow, fixedClock()).run({
      ...agent,
      taskId: task.id,
      to: 'in_review',
      reason: 'pr ready',
      lease_token: claim.lease_token,
    })
  ).resolves.toBeTruthy()
  await db.destroy()
})

it('invariant 6: a question assigned to an AGENT does not gate (spec §6.4.6 literal)', async () => {
  const { db, uow, ids } = await setup()
  const task = await new CreateTask(uow, fixedClock(), ids).run({
    ...human,
    title: 'gated',
    status: 'todo',
  })
  const claim = await new ClaimTask(uow, fixedClock()).run({ ...agent, taskId: task.id })
  await new CreateThread(uow, fixedClock(), ids).run({
    ...agent,
    taskId: task.id,
    kind: 'question',
    body: 'self-check?',
    assignee_id: 'a_agent',
  })
  await expect(
    new UpdateStatus(uow, fixedClock()).run({
      ...agent,
      taskId: task.id,
      to: 'in_review',
      reason: 'really',
      lease_token: claim.lease_token,
    })
  ).resolves.toBeTruthy()
  await db.destroy()
})

it('invariant 6: a HUMAN actor is never gated by open questions (D-o)', async () => {
  const { db, uow, ids } = await setup()
  await seedToken(db, 'tok_human', 'a_human') // human claim needs a token (claim-task rule)
  const humanClaimant: ActorContext = { actor: human.actor, tokenId: 'tok_human' }
  const task = await new CreateTask(uow, fixedClock(), ids).run({
    ...human,
    title: 'gated',
    status: 'todo',
  })
  const claim = await new ClaimTask(uow, fixedClock()).run({ ...humanClaimant, taskId: task.id })
  await new CreateThread(uow, fixedClock(), ids).run({
    ...agent,
    taskId: task.id,
    kind: 'question',
    body: 'needs human',
    assignee_id: 'a_human',
  })
  await expect(
    new UpdateStatus(uow, fixedClock()).run({
      ...humanClaimant,
      taskId: task.id,
      to: 'in_review',
      reason: 'human path',
      lease_token: claim.lease_token,
    })
  ).resolves.toBeTruthy()
  await db.destroy()
})

it('question gate holds even with review_gate off (invariant 5 policy does not lift invariant 6)', async () => {
  const { db, uow, ids } = await setup()
  await uow.withTransaction(async (r) => r.actors.setPolicy('review_gate', 'off'))
  const task = await new CreateTask(uow, fixedClock(), ids).run({
    ...human,
    title: 'x',
    status: 'todo',
  })
  const claim = await new ClaimTask(uow, fixedClock()).run({ ...agent, taskId: task.id })
  await new CreateThread(uow, fixedClock(), ids).run({
    ...agent,
    taskId: task.id,
    kind: 'question',
    body: 'q',
    assignee_id: 'a_human',
  })
  await expect(
    new UpdateStatus(uow, fixedClock()).run({
      ...agent,
      taskId: task.id,
      to: 'in_review',
      reason: 'r',
      lease_token: claim.lease_token,
    })
  ).rejects.toMatchObject({ code: 'open_questions' })
  await db.destroy()
})
```

(The blocks assume a local `setup()` returning `{ db, uow, ids }` with agent/ana actors + tokens seeded and `agent`/`human` contexts available — `update-status.test.ts` already carries agent/actor seeding from Plan A; reuse its existing harness names and extend it minimally to also return `ids = seqIds()`. Add imports: `CreateThread`, `AnswerQuestion`, `seedActor`/`seedToken` as needed. Keep the shipped tests untouched unless a byte-sync amendment is required.)

- [ ] **Step 8.2: RED** — the gate isn't wired; in_review with a question succeeds today (the reserved code never fires). `pnpm test src/application/usecases/update-status.test.ts` → the new tests fail.

- [ ] **Step 8.3: Implement.** In `src/application/usecases/update-status.ts`, **replace the misplaced seam comment** (line: `// Invariant 6 seam: Plan B adds … here.` inside the `done` block) and insert the gate just **above** the `done` block (D-o documents this relocation — §6.4.6 gates `in_review`, not `done`):

```ts
// Invariant 6 (spec §6.4.6, D-o): an agent may not hand work to review while a
// question on this task still awaits a HUMAN. Plan A's seam comment sat inside
// the done branch; the spec text is binding, the branch placement was not.
if (input.to === 'in_review' && input.actor.kind === 'agent') {
  const openHuman = await repos.threads.openHumanAssigned(input.taskId)
  if (openHuman > 0) {
    throw new DomainError(
      'open_questions',
      `${openHuman} open question(s) await a human answer (spec §6.4.6)`,
      { open: openHuman }
    )
  }
}
```

Nothing else changes: the claim auto-release-to-`in_review` (reason `claim released on review`, grep-pinned) and the done-block gates stay exactly as shipped. Update the shipped test at `update-status.test.ts` that asserted the unwired seam (it currently asserts `in_review` succeeds with zero questions — still true; extend its name to `…Plan B wired (see invariant-6 tests)`). If its block text changed, record the byte-sync amendment in THIS plan file.

- [ ] **Step 8.4: REST-level pin** — append to `threads.test.ts`: agent token claims task, opens question assigned to admin human (`assignee_handle: 'nils'`), `PATCH /tasks/:id/status {status:'in_review', reason:'pr', lease_token}` → 409 `open_questions`. Then admin answers, and the same PATCH → 200 and the audit carries `claim released on review` (proves the pinned string untouched on the new path).

- [ ] **Step 8.5: Verify + commit:**

```bash
pnpm test && pnpm lint && pnpm typecheck
git add -A
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(app): invariant 6 review gate on open human questions"
```

> **Amendment (Task 8, harness adaptation + audit-absence pin):** The gate block itself shipped byte-identical to Step 8.3 — including replacing Plan A's misplaced seam comment and the relocation above the `done` branch (D-o). Deviations, all harness-side: (1) the block's assumed `setup()` returning `{ db, uow, ids }` does not exist — `update-status.test.ts` ships `withAgent()` (returns `{ db, uow }` with agent + `tok_agent` seeded); each new test opens one shared `seqIds()` after `withAgent()` and passes it to `CreateTask`/`CreateThread`/`AnswerQuestion` per the M-1 one-counter rule; the human-claim test uses `seedToken(db, 'tok_human', 'a_human')` and a `humanClaimant` context exactly as the block wrote them. (2) The gate test gained an audit-absence pin the block lacks — after the 409 the task's trail contains no `status_changed` row (the throw precedes every write; D-o record-integrity made explicit). (3) The pre-existing zero-question test was renamed to `… Plan B wired (see invariant-6 tests)` per Step 8.3, body untouched. (4) The Step 8.4 REST pin asserts `open` TOP-LEVEL beside `code` in the 409 body (problem.ts spreads DomainError details flat — the T7 wire shape), reads the release-audit trail via `t.deps.auditRoot.search` (no /audit surface needed), and answers as the admin token (human nils, the assignee). Reviewer-prescribed follow-up: the REST test now carries an explicit note above the post-answer `PATCH …/status` retry that the 409 wrote nothing (the gate precedes every write), so the same live `lease_token` still validates there. Block sync = shipped form.

---

### Task 9: Inbox surface + `assigned` producer

**Files:**

- Create: `src/adapters/rest/routes/inbox.ts` (+ test), `src/application/usecases/mark-inbox-read.ts` (+ test)
- Modify: `src/application/usecases/update-task.ts` (+ its test), `src/main/deps.ts`, `src/adapters/rest/app.ts`, `openapi/openapi.yaml`

- [ ] **Step 9.1: Failing tests.** `mark-inbox-read.test.ts`: create-thread mention (Task 5 harness) → MarkInboxRead by owner → listForActor read=true; mark by non-owner or unknown id → `not_found` (D-r: no 403 information leak). `update-task.test.ts` append:

```ts
it('assignee change notifies the new assignee (D-r: assigned inbox, never self, never on no-op patch)', async () => {
  const { db, uow } = await buildUow()
  const ids = seqIds()
  await seedActor(db, 'a_ana', 'human', 'ana')
  const ana: ActorContext = {
    actor: { id: 'a_ana', kind: 'human', handle: 'ana', display_name: 'Ana' },
    tokenId: null,
  }
  const task = await new CreateTask(uow, fixedClock(), ids).run({ ...human, title: 'x' })
  const uc = new UpdateTask(uow, fixedClock(), ids) // constructor gains IdGen (9.2)
  await uc.run({ ...human, taskId: task.id, patch: { assignee_id: 'a_ana' } })
  const inbox = new SqliteInboxRepo(db)
  expect(
    (await inbox.listForActor('a_ana', { unreadOnly: false, limit: 5 })).map((i) => i.kind)
  ).toEqual(['assigned'])
  await uc.run({ ...human, taskId: task.id, patch: { assignee_id: 'a_human' } }) // self: no notify
  expect(await inbox.listForActor('a_ana', { unreadOnly: false, limit: 5 })).toHaveLength(1)
  await uc.run({ ...human, taskId: task.id, patch: { title: 'y' } }) // no assignee key: no notify
  expect(await inbox.listForActor('a_ana', { unreadOnly: false, limit: 5 })).toHaveLength(1)
  await uc.run({ ...human, taskId: task.id, patch: { assignee_id: null } }) // unassign: no notify (null guard)
  expect(await inbox.listForActor('a_ana', { unreadOnly: false, limit: 5 })).toHaveLength(1)
  await db.destroy()
})
```

(Adapt to `update-task.test.ts`'s existing harness names; `UpdateTask` gains a third constructor arg — update ALL existing constructor sites in that test file too, per Plan A M-1 pin one shared `seqIds()` per test.)

- [ ] **Step 9.2: RED**, then implement.

`update-task.ts`: constructor gains `ids: IdGen` (third arg — update deps.ts + ALL constructor sites in update-task.test.ts); after the audited patch, append before `return`:

```ts
// D-r: assignment changes notify the new assignee — never self, never null, never unchanged
if (
  input.patch.assignee_id !== undefined &&
  input.patch.assignee_id !== null &&
  input.patch.assignee_id !== before.assignee_id &&
  input.patch.assignee_id !== input.actor.id
) {
  await repos.inbox.add({
    id: this.ids.newId('ib'),
    actor_id: input.patch.assignee_id,
    kind: 'assigned',
    task_id: input.taskId,
    thread_id: null,
    created_at: now,
  })
}
```

Place it inside the existing `if (meaningful)`-style audit branch so it rides the audited change, using `before.assignee_id` already read by the shipped code; if the shipped code returns `before` for a non-meaningful patch, the no-op path never reaches here — assert that in the test (it does: second run has the same assignee → no row).

`mark-inbox-read.ts`:

```ts
import { DomainError } from '#root/domain/errors'
import type { ActorContext, UnitOfWork } from '#root/application/ports'

export interface MarkInboxReadInput extends ActorContext {
  itemId: string
}

/** D-r: read-state is personal; absent/not-owned both fail with not_found (no leak). */
export class MarkInboxRead {
  constructor(private readonly uow: UnitOfWork) {}

  async run(input: MarkInboxReadInput): Promise<void> {
    await this.uow.withTransaction(async (repos) => {
      const ok = await repos.inbox.markRead(input.itemId, input.actor.id)
      if (!ok) throw new DomainError('not_found', `inbox item ${input.itemId} not found`)
    })
  }
}
```

- [ ] **Step 9.3: Routes** `src/adapters/rest/routes/inbox.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import { actorCtx } from '#root/adapters/rest/auth'

export const registerInboxRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  app.get(
    '/inbox',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            unread_only: { type: 'boolean' },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
          },
        },
      },
    },
    async (request) => {
      const q = request.query as { unread_only?: boolean; limit?: number }
      const ctx = actorCtx(request) // 401 without an actor; per-actor view (D-r)
      return deps.inboxRoot.listForActor(ctx.actor.id, {
        unreadOnly: q.unread_only ?? false,
        limit: q.limit ?? 50,
      })
    }
  )

  app.post('/inbox/:id/read', async (request, reply) => {
    const { id } = request.params as { id: string }
    await deps.useCases.markInboxRead.run({ itemId: id, ...actorCtx(request) })
    return reply.code(204).send()
  })
}
```

Wire `registerInboxRoutes(server, deps)` after `registerThreadRoutes` in `app.ts`; deps.ts gains `markInboxRead: new MarkInboxRead(uow)`.

- [ ] **Step 9.4: Contract** — add `/inbox` (get) and `/inbox/{id}/read` (post, 204) paths with an `InboxItem` schema (`id, actor_id, kind enum [assigned, mentioned, question_assigned], task_id, thread_id nullable, read boolean, created_at`), tag `inbox`.

- [ ] **Step 9.5: Verify + commit:**

```bash
pnpm test && pnpm lint && pnpm typecheck
git add -A
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(api): per-actor inbox with read state + assignment notify"
```

> **Amendment (Task 9, test realization details):** Producer, `mark-inbox-read.ts`, routes, wiring and the yaml shipped byte-identical to the blocks (producer rides inside the shipped `if (meaningful)` audit branch, keyed on `before.assignee_id` exactly as Step 9.2 prescribes). Test-side realizations: (1) the producer test drops the block's never-used `ana` ActorContext, wraps reads in an `anaKinds()` helper, and gains an extra probe the block lacks — re-patching `assignee_id: 'a_ana'` while ana is already assignee (actor ≠ ana) pins the `!== before.assignee_id` arm SEPARATELY from the self arm; the self arm is pinned explicitly by asserting `a_human`'s own inbox stays `[]` after self-assignment; the block's other arms (new-assignee `['assigned']`, title-only, `null` unassign) shipped verbatim. (2) All eight existing `new UpdateTask(uow, fixedClock())` sites gained a fresh `seqIds()` third arg — safe because each existing test constructs at most one `UpdateTask` and none assert on inbox effects; the pre-existing assign-then-null test does notify, harmlessly consuming a seq id, while the producer test shares one `ids` across `CreateTask`/`UpdateTask` per M-1. (3) `mark-inbox-read.test.ts` (block was prose-only) ships three tests via the Task 5 mention harness: owner flips `read`, non-owner and unknown id both `not_found` (never 403), re-mark idempotent. (4) `routes/inbox.test.ts` (block: "(+ test)" only) ships four: per-actor view (ana's GET sees none of nils' items), read flow incl. `unread_only`, `limit` cap and `limit=0 → 400 invalid_request`, owner-only 404 on foreign/ghost ids, and an anonymous 401 guard — noted honestly: the 401 probe passes even pre-registration (app-level auth precedes routing), so the file's TDD weight rests on the other three. (5) The yaml `InboxItem.read` is `boolean` (the repo maps the SQLite int at the boundary) and its kind enum mirrors the domain `INBOX_ITEM_KINDS` single source. Block sync = shipped form.

---

### Task 10: Context bundle populated (spec §7.2 seams filled)

**Files:**

- Modify: `src/application/usecases/get-context.ts` (+ `queries.test.ts`), `src/main/deps.ts`, `openapi/openapi.yaml`

- [ ] **Step 10.1: Failing test.** Extend `src/application/usecases/queries.test.ts` — the existing "seams empty" test keeps its assertion (empty for a task with none — still correct), and a new test pins the populated shape. Construct via repos in the same file's setup (`freshDb`/`seedActor`/`seedTask` + `SqliteThreadRepo`/`SqliteAttachmentRepo`/`SqliteLinkRepo`):

```ts
it('fills the Plan B seams: open questions, links, attachments (spec §7.2)', async () => {
  const { db } = await setup()
  await seedTask(db, 't_b')
  await seedThread(db, 'th_q', 't_b', 'question', { assignee_id: 'a_agent' })
  await seedMessage(db, 'ms_q', 'th_q', 1, 'which db?')
  await new SqliteLinkRepo(db).add({
    id: 'lk_1',
    task_id: 't_b',
    kind: 'pr',
    url: 'https://example/pr/1',
    created_by: 'a_agent',
    created_at: '2026-01-01T00:00:00.000Z',
  })
  await new SqliteAttachmentRepo(db).add({
    id: 'at_1',
    task_id: 't_b',
    filename: 'spec.md',
    content_type: 'text/markdown',
    sha256: 'aa'.repeat(32),
    bytes: 12,
    created_by: 'a_agent',
    created_at: '2026-01-01T00:00:00.000Z',
  })
  const bundle = await new GetContext(
    new SqliteTaskRepo(db),
    new SqliteDependencyRepo(db),
    new SqliteLabelRepo(db),
    new SqliteThreadRepo(db),
    new SqliteLinkRepo(db),
    new SqliteAttachmentRepo(db)
  ).run({ taskId: 't_b' })
  expect(bundle.open_questions).toEqual([
    { id: 'th_q', state: 'open', assignee_handle: 'hermes-1', question: 'which db?' },
  ])
  expect(bundle.links).toHaveLength(1)
  expect(bundle.links[0]).toMatchObject({ kind: 'pr', url: 'https://example/pr/1' })
  expect(bundle.attachments[0]).toMatchObject({ filename: 'spec.md', bytes: 12 })
  await db.destroy()
})
```

(`seedThread`/`seedMessage` are the Task 4 fixtures helpers; the agent seeded as `hermes-1` provides `assignee_handle`.)

- [ ] **Step 10.2: RED**, then modify `get-context.ts`: replace the three `unknown[]` seam fields with typed ones (`open_questions: OpenQuestionRow[]`, `links: LinkRecord[]`, `attachments: AttachmentRecord[]`); the constructor takes three more repos (same-bare-repos idiom as `getNext`):

```ts
export class GetContext {
  constructor(
    private readonly tasks: TaskRepo,
    private readonly deps: DependencyRepo,
    private readonly labels: LabelRepo,
    private readonly threads: ThreadRepo,
    private readonly linksRepo: LinkRepo,
    private readonly attachmentsRepo: AttachmentRepo
  ) {}

  async run(input: { taskId: string }): Promise<TaskContextBundle> {
    // …existing not_found + assembly unchanged…
    return {
      // …existing fields unchanged…
      open_questions: await this.threads.openQuestionsForTask(input.taskId),
      links: await this.linksRepo.listForTask(input.taskId),
      attachments: await this.attachmentsRepo.listForTask(input.taskId),
    }
  }
}
```

Delete the `/** seams — populated in Plan B … */` comment (the seams are the shipped shape now). deps.ts: pass the three new root repos to `getContext`. If the shipped block text differed, append the byte-sync amendment to THIS file.

- [ ] **Step 10.3: Contract** — refine `ContextBundle` in `openapi/openapi.yaml`: drop the "question/link/attachment arrays empty in Plan A" phrasing from the `/tasks/{id}/context` description, and give the three fields typed items:

```yaml
open_questions:
  type: array
  description: open questions on the task (D-n/D-m); first-message text preview
  items:
    type: object
    properties:
      id: { type: string }
      state: { type: string, enum: [open, answered, resolved, wont_fix] }
      assignee_handle: { type: string }
      question: { type: string }
links:
  type: array
  items: { $ref: '#/components/schemas/Link' }
attachments:
  type: array
  items: { $ref: '#/components/schemas/Attachment' }
```

(Define `Link`/`Attachment` schemas now — Tasks 12/13 reuse them: `Link` = `{id, task_id, kind enum [pr,commit,doc,other], url, created_by, created_at}`; `Attachment` = `{id, task_id, filename, content_type, sha256, bytes, created_by, created_at}`.)

- [ ] **Step 10.4: Verify + commit:**

```bash
pnpm test && pnpm lint && pnpm typecheck
git add -A
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(app): context bundle carries questions, links, files"
```

> **Amendment (Task 10, fixture FK seeding + call-site fan-out):** `get-context.ts`, the deps wiring and the yaml shipped per the blocks (seam comment deleted, `openQuestionsForTask` reused from the T4 repo — the block prescribed repo reuse, no hand-rolled query; `links`/`attachments` are REPO-backed `listForTask`, not `[]`-placeholders: the use-cases for managing them come in T12/T13 but reading them is Task 10's job). Test-side deltas: (1) the block's new test calls `seedTask`/`seedThread`/`seedMessage` whose fixtures default `created_by`/`author_id` to `a_creator` — an actor `queries.test.ts`'s setup never seeded — so the shipped test seeds `a_creator` first (FK, same fix as the Task 4 setups). (2) The constructor fan-out reaches THREE sites, not just the new test: the pre-existing seams-empty test and the `not_found` test both gained the three extra repo args (vitest ignores arity but `tsc` does not — the third site surfaced only at the typecheck gate); ALL existing assertions stand unchanged, seams-empty stays green exactly as Step 10.1 demands. (3) `Link`/`Attachment` schemas defined now (Task 12/13 reuse), `ContextBundle` fields typed per the block, `/tasks/{id}/context` description's "empty in Plan A" clause dropped. Bookkeeping carried in this commit per reviewer: the Task 9 amendment's "none notify" clause corrected (the assign-then-null test DOES notify, harmlessly consuming a seq id) and the Task 7 amendment's italic-mangled backtick spacing repaired throughout that line. Quality-review follow-up in the next commit: the constructor params `linksRepo`/`attachmentsRepo` were renamed to the file's noun style (`links`/`attachments`, positional callers unaffected) with the ports import members sorted, and the seams-empty test's stale "populated by Plan B/C" comment now states the truth ("empty here — this task has no threads/links/files"). Block sync = shipped form.

---

### Task 11: Env config + FileStore port + disk implementation

**Files:**

- Modify: `src/main/config.ts` (+ test), `src/main/deps.ts`, `src/testing/test-app.ts`
- Create: `src/infra/files/disk-file-store.ts` (+ test), FileStore port lines in `src/application/ports.ts`

- [ ] **Step 11.1: Failing test** `src/infra/files/disk-file-store.test.ts` (temp dir via `mkdtemp(join(tmpdir(), 'ns-files-'))` — never fixed paths, never repo-relative):

```ts
import { describe, expect, it } from 'vitest'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiskFileStore } from '#root/infra/files/disk-file-store'

const setup = async () => new DiskFileStore(await mkdtemp(join(tmpdir(), 'ns-store-')))

describe('DiskFileStore (D-s)', () => {
  it('content-addressed put is idempotent and round-trips', async () => {
    const store = await setup()
    const data = new TextEncoder().encode('spec body')
    const a = await store.put(data)
    const b = await store.put(data)
    expect(b).toEqual(a)
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/)
    const back = await store.get(a.sha256)
    expect(new TextDecoder().decode(back!)).toBe('spec body')
    // two-hex shard dir only, single blob despite two puts
    const shards = await readdir(store.dir)
    expect(shards).toEqual([a.sha256.slice(0, 2)])
  })

  it('get of an unknown address → null (ENOENT), never a throw', async () => {
    const store = await setup()
    expect(await store.get('ab'.repeat(32))).toBeNull()
  })

  it('rejects malformed content addresses (path traversal defense)', async () => {
    const store = await setup()
    await expect(store.get('../../etc/passwd')).rejects.toThrow(/content address/i)
    await expect(store.get('A'.repeat(64))).rejects.toThrow(/content address/i) // uppercase not our alphabet
  })
})
```

- [ ] **Step 11.2: RED**, then ports.ts append (after the attachments/links block):

```ts
// ---- file store (spec §6.6, §9; D-s) — infra adapter, NOT a tx repo

export interface FileRef {
  sha256: string
  bytes: number
}

export interface FileStore {
  /** Content-addressed, idempotent; hashing lives in infra (node:crypto stays out of app). */
  put(content: Uint8Array): Promise<FileRef>
  /** null for unknown addresses; rejects only malformed inputs. */
  get(sha256: string): Promise<Uint8Array | null>
}
```

`src/infra/files/disk-file-store.ts`:

```ts
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { FileRef, FileStore } from '#root/application/ports'

/** D-s: `<root>/<sha[0:2]>/<sha>` with tmp+rename — no partial reads, content dedupe. */
export class DiskFileStore implements FileStore {
  constructor(readonly dir: string) {}

  async put(content: Uint8Array): Promise<FileRef> {
    const sha256 = createHash('sha256').update(content).digest('hex')
    const target = this.pathFor(sha256)
    const tmp = join(dirname(target), `.${sha256}.${randomUUID()}.tmp`)
    try {
      await readFile(target)
      return { sha256, bytes: content.byteLength } // already stored — idempotent (D-s)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(tmp, content)
    await rename(tmp, target)
    return { sha256, bytes: content.byteLength }
  }

  async get(sha256: string): Promise<Uint8Array | null> {
    try {
      return await readFile(this.pathFor(sha256))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  private pathFor(sha256: string): string {
    // traversal defense: our own address grammar is the ONLY grammar accepted
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`invalid content address '${sha256}' (expected lowercase sha256 hex)`)
    }
    return join(this.dir, sha256.slice(0, 2), sha256)
  }
}
```

- [ ] **Step 11.3: Config (D-w).** `src/main/config.ts` `EnvSchema` gains:

```ts
  NS_DATA_DIR: z.string().min(1).default('./data'),
  NS_MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).default(20_971_520),
  NS_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(0).default(120),
```

`Config` interface + return gain `dataDir: string`, `maxUploadBytes: number`, `rateLimitPerMin: number`. `config.test.ts` defaults test gains the three fields (byte-sync the block; `NS_MAX_UPLOAD_BYTES: 'abc'` → throws, `NS_RATE_LIMIT_PER_MIN: '0'` → 0 allowed, add rows). `deps.ts`: `files: FileStore` on AppDeps with `new DiskFileStore(join(config.dataDir, 'files'))` (import `join` from node:path — deps is composition root, IO allowed). `src/testing/test-app.ts`: seed env becomes `loadConfig({ NS_DB_PATH: ':memory:', NS_RATE_LIMIT_PER_MIN: '0', NS_DATA_DIR: join(mkdtempSync(join(tmpdir(), 'ns-test-')), 'data') })` — limit off by default per D-v and temp data dir per file — test-app already excluded from coverage. `makeTestApp` gains an optional second parameter merged over those defaults: `makeTestApp(overrides: NodeJS.ProcessEnv = {})` → `loadConfig({ ...defaults, ...overrides })` so Task 14 can build a rate-limited app.

- [ ] **Step 11.4: Verify + commit:**

```bash
pnpm test && pnpm lint && pnpm typecheck
git add -A
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(infra): content-addressed disk file store and env config"
```

> **Amendment (Task 11, defensive arms pinned + config row additions):** `ports.ts` (`FileRef`/`FileStore`, zero node imports), `disk-file-store.ts`, the config schema/`Config`/return, the deps `files` wiring and the `makeTestApp(overrides)` temp-dir env all shipped byte-identical to the blocks. Test-side: (1) the block's three store tests shipped verbatim plus a tmp-hygiene assertion inside test 1 (the shard dir holds EXACTLY the one blob — rename atomicity leaves no `.tmp` residue) and a distinct-bytes test (two addresses, both round-trip). (2) One extra test pins the two re-throw arms the block leaves unreachable: a corrupted store (blob slot occupied by a directory) makes BOTH `get` and `put` surface the EISDIR — never a `null` lie or silent overwrite (deterministic via a directory planted at the probe's own sha path); the new file is consequently branch-complete (100% statements, zero partials). (3) `config.test.ts` pins the three defaults EXACTLY (`'./data'`, 20_971_520, 120) — silent default flips are contract breaks for T12/T14 — plus rows `NS_MAX_UPLOAD_BYTES: 'abc'` → throws, `NS_RATE_LIMIT_PER_MIN: '0'` → 0 legal (D-v off switch), `-1` → throws. Traversal note: `pathFor` accepts ONLY the lowercase-64-hex grammar, so no accepted string ever carries path syntax — the defense is the grammar itself, exercised by `'../../etc/passwd'` and uppercase-64 rejections. Block sync = shipped form.

---

### Task 12: Attachments — upload + serve (sanitized) + routes

**Files:**

- Create: `src/application/usecases/upload-attachment.ts` (+ test), `src/adapters/rest/routes/attachments.ts` (+ test)
- Modify: `src/adapters/rest/app.ts`, `src/main/deps.ts`, `openapi/openapi.yaml`

- [ ] **Step 12.1: Failing use-case test** `upload-attachment.test.ts` (Task 5 harness + in-memory FileStore fake or a real `DiskFileStore` over a tmpdir — real store is preferred, no fake needed):

```ts
it('stores bytes content-addressed, dedupes re-upload of same (task, sha, filename) without second audit', async () => {
  const { db, uc, taskId } = await setup() // uc = new UploadAttachment(uow, clock, ids, files)
  const bytes = new TextEncoder().encode('# spec\n')
  const first = await uc.run({
    ...human,
    taskId,
    filename: 'spec.md',
    contentType: 'text/markdown',
    content: bytes,
  })
  expect(first).toMatchObject({ filename: 'spec.md', bytes: 7 })
  expect(first.sha256).toMatch(/^[0-9a-f]{64}$/)
  const again = await uc.run({
    ...human,
    taskId,
    filename: 'spec.md',
    contentType: 'text/markdown',
    content: bytes,
  })
  expect(again.id).toBe(first.id)
  const audit = await new SqliteAuditRepo(db).search({
    entity_type: 'attachment',
    entity_id: first.id,
    limit: 5,
  })
  expect(audit).toHaveLength(1) // D-s: dedupe does not re-audit
  expect(audit[0]).toMatchObject({ action: 'attachment_uploaded', reason: 'attachment uploaded' })
  await db.destroy()
})
// plus: task not_found; empty content → invalid_request; same bytes DIFFERENT filename → new row
```

- [ ] **Step 12.2: RED**, then `upload-attachment.ts`:

```ts
import { createHash } from 'node:crypto'
import { DomainError } from '#root/domain/errors'
import type {
  ActorContext,
  AttachmentRecord,
  Clock,
  FileStore,
  IdGen,
  UnitOfWork,
} from '#root/application/ports'

export interface UploadAttachmentInput extends ActorContext {
  taskId: string
  filename: string
  contentType: string
  content: Uint8Array
}

/**
 * D-s: the blob goes to the FileStore BEFORE the transaction (content-addressed, so a
 * concurrent same-content put is harmless and a tx rollback leaves only an orphan blob —
 * the audit + row are the truth). Hashed here (app layer) from the raw bytes the route
 * parsed; the port keeps crypto out of domain/ports.
 */
export class UploadAttachment {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGen,
    private readonly files: FileStore
  ) {}

  async run(input: UploadAttachmentInput): Promise<AttachmentRecord> {
    if (input.content.byteLength === 0) {
      throw new DomainError('invalid_request', 'empty upload rejected')
    }
    const sha256 = createHash('sha256').update(input.content).digest('hex')
    await this.files.put(input.content) // idempotent (D-s)
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      const task = await repos.tasks.findById(input.taskId)
      if (!task) throw new DomainError('not_found', `task ${input.taskId} not found`)
      const existing = await repos.attachments.findByTaskShaFilename(
        input.taskId,
        sha256,
        input.filename
      )
      if (existing) return existing // no second audit for byte-identical re-upload
      const row = await repos.attachments.add({
        id: this.ids.newId('at'),
        task_id: input.taskId,
        filename: input.filename,
        content_type: input.contentType,
        sha256,
        bytes: input.content.byteLength,
        created_by: input.actor.id,
        created_at: now,
      })
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'attachment_uploaded',
        entity_type: 'attachment',
        entity_id: row.id,
        after: { task_id: input.taskId, sha256, bytes: row.bytes },
        reason: 'attachment uploaded',
        created_at: now,
      })
      return row
    })
  }
}
```

(If Review prefers the hash computed inside `FileStore.put` returning it — it already does return `{sha256,bytes}`; simplify to `const ref = await this.files.put(input.content)` and drop the local hash. Ship whichever lands; amend this block accordingly. The use-case test's fake-free DiskFileStore pins behavior either way.)

- [ ] **Step 12.3: Routes** `src/adapters/rest/routes/attachments.ts` — raw-body upload (D-t: no multipart dep):

```ts
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import { actorCtx } from '#root/adapters/rest/auth'
import { DomainError } from '#root/domain/errors'

// spec §10: never render HTML/SVG from attachment origin
const UNSAFE_INLINE = /^text\/html|^application\/xhtml|^image\/svg/i

export const registerAttachmentRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  app.post(
    '/tasks/:id/attachments',
    {
      config: { bodyLimit: deps.config.maxUploadBytes },
      schema: {
        querystring: {
          type: 'object',
          required: ['filename'],
          properties: {
            filename: { type: 'string', minLength: 1, maxLength: 240 },
            content_type: {
              type: 'string',
              minLength: 1,
              maxLength: 120,
              default: 'application/octet-stream',
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const q = request.query as { filename: string; content_type?: string }
      // the app-level buffer content-type parser (below) delivers octet-stream as a Buffer
      const content = request.body as Buffer
      const row = await deps.useCases.uploadAttachment.run({
        taskId: id,
        filename: q.filename,
        contentType: q.content_type ?? 'application/octet-stream',
        content,
        ...actorCtx(request), // actorCtx LAST (binding)
      })
      return reply.code(201).send(row)
    }
  )

  app.get('/tasks/:id/attachments', async (request) => {
    const { id } = request.params as { id: string }
    return deps.attachmentsRoot.listForTask(id)
  })

  app.get('/attachments/:id/content', async (request, reply) => {
    const { id } = request.params as { id: string }
    const row = await deps.attachmentsRoot.find(id)
    if (!row) throw new DomainError('not_found', `attachment ${id} not found`)
    const bytes = await deps.files.get(row.sha256)
    if (!bytes) throw new DomainError('not_found', 'stored blob is missing')
    const safe = UNSAFE_INLINE.test(row.content_type)
    // filename sanitized: strip quotes/control for the disposition header
    const filename = row.filename.replace(/["\\\r\n]/g, '_')
    return reply
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', `${safe ? 'attachment' : 'inline'}; filename="${filename}"`)
      .type(safe ? 'application/octet-stream' : row.content_type)
      .send(bytes)
  })
}
```

`app.ts`: register after inbox routes; **register the buffer content-type parser at app level** (before routes):

```ts
// D-t: raw-body uploads (application/octet-stream) — parseAs buffer, no multipart dep
server.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (req, body, done) =>
  done(null, body)
)
```

JSON routes are untouched — their content types keep their own parsers, and a request with an unsupported type gets the shipped 415 path (problem+json `unsupported_media_type`, Task 2). The 413 body-limit path also ships via Task 2's mapping — add a REST test: with `makeTestApp({ NS_MAX_UPLOAD_BYTES: '1024' })`, a 2048-byte octet-stream upload → 413 `payload_too_large`.

Route tests (REST level): upload spec.md octet-stream → 201 metadata + GET /tasks/:id/attachments shows it; GET content round-trips bytes + `x-content-type-options: nosniff`; uploading text/html content and GET → served as `application/octet-stream` with `attachment` disposition (spec §10, D-s); GET unknown id → 404; list for unknown task → `[]`.

- [ ] **Step 12.4: Contract** — add to `openapi/openapi.yaml` (the `Attachment` schema exists from Task 10):

```yaml
/tasks/{id}/attachments:
  parameters: [{ $ref: '#/components/parameters/TaskId' }]
  get:
    tags: [attachments]
    operationId: listAttachments
    responses:
      '200':
        description: metadata rows, oldest first
        content:
          application/json:
            schema: { type: array, items: { $ref: '#/components/schemas/Attachment' } }
      default: { $ref: '#/components/responses/Problem' }
  post:
    tags: [attachments]
    operationId: uploadAttachment
    description: >-
      raw application/octet-stream body; filename/content_type via querystring;
      size-capped (413 payload_too_large); content-addressed, re-upload dedupes (spec §6.6)
    parameters:
      - {
          name: filename,
          in: query,
          required: true,
          schema: { type: string, minLength: 1, maxLength: 240 },
        }
      - {
          name: content_type,
          in: query,
          schema: { type: string, maxLength: 120, default: application/octet-stream },
        }
    requestBody:
      required: true
      content:
        application/octet-stream:
          schema: { type: string, format: binary }
    responses:
      '201':
        description: stored attachment metadata
        content:
          application/json:
            schema: { $ref: '#/components/schemas/Attachment' }
      default: { $ref: '#/components/responses/Problem' }
/attachments/{id}/content:
  parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
  get:
    tags: [attachments]
    operationId: getAttachmentContent
    description: >-
      raw bytes; HTML/SVG-origin types are downgraded to application/octet-stream with
      attachment disposition and nosniff (spec §10)
    responses:
      '200':
        description: the stored bytes
        content:
          application/octet-stream:
            schema: { type: string, format: binary }
      default: { $ref: '#/components/responses/Problem' }
```

Tags list gains `attachments`. (Drift test checks paths×methods, not content types — the Problem default + 2xx are convention.)

- [ ] **Step 12.5: Verify + commit:**

```bash
pnpm test && pnpm lint && pnpm typecheck
git add -A
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(api): attachment upload and sanitized content serving"
```

> **Amendment (Task 12, three plan-block bugs + one honest reachability note):** (1) The Step 12.2 block computed sha256 with `node:crypto` INSIDE the use-case, contradicting D-s ("hashing lives in infra, keeping node:crypto out of the app layer") and the port's own doc — the block's granted simplification was taken: `const ref = await this.files.put(input.content)`; `ref.sha256`/`ref.bytes` feed the row/audit; no crypto import in `src/application/`. (2) The Step 12.3 block wrote `config: { bodyLimit: ... }` — the inert form the Task 2 probe proved returns 200; shipped the DIRECT route option `bodyLimit: deps.config.maxUploadBytes`, and the 413 pin (`NS_MAX_UPLOAD_BYTES: '1024'` + 2048-byte octet-stream → 413 `payload_too_large`) proves it rides T2's map. (3) The block's `q.content_type ?? 'application/octet-stream'` duplicated the schema's `default`, making one of the two a dead arm (measured: 83% branches); shipped the schema `default` as the single fallback (ajv `useDefaults` guarantees it; cast totalized with a comment). (4) Honest reachability: a 415 `unsupported_media_type` pin is UNREACHABLE at the route level — the shipped default json/text parsers parse those content types before any handler runs, and 415 is a parser-level ADAPTER code the `DomainError` union rejects by design. Rather than invent a fake or ship the block's type-lie (a JSON body would flow into `content` as an object), the route gained a `Buffer.isBuffer` guard answering `invalid_request` 400 "requires application/octet-stream bytes" — pinned by its own test; the contract is enforced one code earlier, honestly named. Sanitizer, headers (`nosniff` on every response, `attachment` downgrade for the `UNSAFE_INLINE` html/xhtml/svg families), filename quote/control stripping, dedupe-without-re-audit (exact-audit assertion), distinct-filename rows, orphan-blob 404 (`rm` the blob via the `DiskFileStore.dir` the test-app shares), and the app-level buffer parser (JSON untouched — proven by every existing route test) shipped per the blocks; yaml paths + `attachments` tag same-commit, drift green. Both new files branch-complete (zero partials). Block sync = shipped form.

> **Amendment (Task 12, quality review):** Five repairs to the shipped form of `f3b9e18`, first two live-probed. (1) The disposition strip `/["\\\r\n]/g` was too narrow — the reviewer PROVED `filename=a%0Bb.txt` (vertical tab) answers 500 `ERR_INVALID_CHAR` with a raw errno body (node's header validator accepts only `\t\x20-\x7e\x80-\xff`); shipped the single-class broadening `/[\x00-\x1f\x7f"\\]/g` at SERVE time — upload-time normalization was considered and REJECTED (a list response with escaped-but-valid JSON control chars is contract-honest; the header is the only injection surface that matters, reviewer-accepted tradeoff). The sanitize test now also probes `%0B` and `%00` end-to-end → clean 200, wrapping quotes only, nosniff. (2) `GET /tasks/:id/attachments` on a ghost task returned `200 []` — pinned as such by the first-shipped test; flipped to the T7 standard (typo'd id must not masquerade as empty): the threads-list idiom mirrored exactly (`deps.tasksRoot.findById` → `not_found`), pinned both ways (ghost 404 + real-task empty 200). (3) `app.ts` parser comment citation corrected `D-t` → `D-s` (raw-body uploads are D-s; D-t is links). (4) The empty-upload message now names the requirement: "attachment upload requires non-empty content" (no test pinned the old string). (5) `listAttachments` gained the missing operation description ("list attachment metadata for a task (404 if the task does not exist)"), drift unaffected. Lands in the child fix commit of `f3b9e18` (a commit cannot quote its own hash — resolve via `git log`). Block sync = shipped form.

---

### Task 13: Links — kind+url handoff refs

**Files:**

- Create: `src/application/usecases/manage-links.ts` (+ test), `src/adapters/rest/routes/links.ts` (+ test)
- Modify: `src/adapters/rest/app.ts`, `src/main/deps.ts`, `openapi/openapi.yaml`

- [ ] **Step 13.1: Failing use-case test** `manage-links.test.ts` (setup like Task 5): AddLink pr url → row + audit `link_added` reason `link added`; same triple again → same id, no second audit (D-t idempotency); different url → new row; bogus kind → invalid_request; `ftp://x` and `not a url` → invalid_request (URL parse, http/https only); RemoveLink → audit `link_removed`, remove twice → second 404; RemoveLink of another task's link → 404 (task-scoped).

- [ ] **Step 13.2: RED**, then `manage-links.ts`:

```ts
import { LINK_KINDS, type LinkKind } from '#root/domain/discussion'
import { DomainError } from '#root/domain/errors'
import type { ActorContext, Clock, IdGen, LinkRecord, UnitOfWork } from '#root/application/ports'

function assertHttpUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new DomainError('invalid_request', `'${url}' is not a valid URL`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new DomainError('invalid_request', `URL scheme must be http(s), got '${parsed.protocol}'`)
  }
}

export interface AddLinkInput extends ActorContext {
  taskId: string
  kind: LinkKind
  url: string
}

export class AddLink {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGen
  ) {}

  async run(input: AddLinkInput): Promise<LinkRecord> {
    if (!LINK_KINDS.includes(input.kind)) {
      throw new DomainError('invalid_request', `unknown link kind '${input.kind}'`)
    }
    assertHttpUrl(input.url)
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      const task = await repos.tasks.findById(input.taskId)
      if (!task) throw new DomainError('not_found', `task ${input.taskId} not found`)
      const existing = await repos.links.findByTaskKindUrl(input.taskId, input.kind, input.url)
      if (existing) return existing // D-t idempotent
      const row = await repos.links.add({
        id: this.ids.newId('lk'),
        task_id: input.taskId,
        kind: input.kind,
        url: input.url,
        created_by: input.actor.id,
        created_at: now,
      })
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'link_added',
        entity_type: 'link',
        entity_id: row.id,
        after: { task_id: input.taskId, kind: input.kind, url: input.url },
        reason: 'link added',
        created_at: now,
      })
      return row
    })
  }
}

export interface RemoveLinkInput extends ActorContext {
  taskId: string
  linkId: string
}

export class RemoveLink {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock
  ) {}

  async run(input: RemoveLinkInput): Promise<void> {
    const now = this.clock.now().toISOString()
    await this.uow.withTransaction(async (repos) => {
      const row = await repos.links.find(input.linkId)
      if (!row || row.task_id !== input.taskId) {
        throw new DomainError('not_found', `link ${input.linkId} not found on task ${input.taskId}`)
      }
      await repos.links.remove(input.linkId)
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'link_removed',
        entity_type: 'link',
        entity_id: row.id,
        before: { task_id: row.task_id, kind: row.kind, url: row.url },
        reason: 'link removed',
        created_at: now,
      })
    })
  }
}
```

- [ ] **Step 13.3: Routes** `src/adapters/rest/routes/links.ts` (label-route idiom: PUT/DELETE → 204-style; POST → 201 with row):

```ts
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import type { LinkKind } from '#root/domain/discussion'
import { actorCtx } from '#root/adapters/rest/auth'

const kindEnum = { type: 'string', enum: ['pr', 'commit', 'doc', 'other'] } as const

export const registerLinkRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  app.get('/tasks/:id/links', async (request) => {
    const { id } = request.params as { id: string }
    return deps.linksRoot.listForTask(id)
  })

  app.post(
    '/tasks/:id/links',
    {
      schema: {
        body: {
          type: 'object',
          required: ['kind', 'url'],
          additionalProperties: false,
          properties: { kind: kindEnum, url: { type: 'string', minLength: 8, maxLength: 2000 } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const { kind, url } = request.body as { kind: LinkKind; url: string }
      const row = await deps.useCases.addLink.run({ taskId: id, kind, url, ...actorCtx(request) })
      return reply.code(201).send(row)
    }
  )

  app.delete('/tasks/:id/links/:linkId', async (request, reply) => {
    const { id, linkId } = request.params as { id: string; linkId: string }
    await deps.useCases.removeLink.run({ taskId: id, linkId, ...actorCtx(request) })
    return reply.code(204).send()
  })
}
```

Wire registration + `addLink`/`removeLink` in deps.

- [ ] **Step 13.4: Contract** — `/tasks/{id}/links` get+post and `/tasks/{id}/links/{linkId}` delete (204/`Problem`), tag `links`; body schema mirrors the route (`kind` enum, `url` min 8 max 2000). `Link` schema exists from Task 10.

- [ ] **Step 13.5: Verify + commit:**

```bash
pnpm test && pnpm lint && pnpm typecheck
git add -A
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(api): per-task external links for PR handoff"
```

> **Amendment (Task 13, ghost-task standard applied):** The blocks shipped as written with one deliberate addition and one reflow. (1) `GET /tasks/:id/links` in Step 13.3 listed links WITHOUT a task existence check — under the established T7 standard (extended by the T12 fix: a typo'd id must not masquerade as an empty list), the route shipped with the threads/attachments idiom verbatim (`deps.tasksRoot.findById(id)` → `DomainError('not_found', task ${id} not found)`), pinned BOTH ways (ghost 404 + real-task empty 200). Honest note, same class as the Task 9 401 caveat: the ghost-404 assertion is vacuously green pre-registration (unregistered routes also answer 404 `not_found`) — the test earns its keep after wiring, which the real-task arm proves live. (2) The `RemoveLink` not_found `DomainError(...)` call was argument-wrapped by prettier (message text byte-identical). URL validation shipped exactly as the block's `assertHttpUrl` (WHATWG `new URL` + http/https-only) — reviewed for holes: the WHATWG parser tolerates some odd payloads, but nothing escapes the JSON list surface or the parameterized SQL layer (unlike T12's header injection point there is no interpreter downstream for a stored url), so no invented hardening. Dedupe story pinned with EXACT audit arrays (`['link_added']` after add+re-add; `['link_removed','link_added']` after removal). yaml: 3 operations all with descriptions (T12 standard), `$ref` to the existing `Link` schema, `links` tag, drift green. Both new files branch-complete (zero partials). Follow-up corrections riding the Task 14 commit: the POST schema now carries the review rationale comment ("8 = 'http://a', shortest parseable http(s) URL — nothing valid is rejected") — yaml description deliberately NOT re-wrapped for it (the route comment is the canonical home); and this blockquote's earlier claim that the `RemoveLink` not_found throw was "argument-wrapped by prettier" was a PHANTOM — the spec review proved the shipped throw is the block's single line, byte-identical and prettier-stable (100 chars); the code never changed, only this record. Block sync = shipped form.

---

### Task 14: Per-actor rate limiting (Plan A assignment, spec §10)

**Files:**

- Create: `src/adapters/rest/rate-limit.ts` (+ test)
- Modify: `src/adapters/rest/app.ts`

- [ ] **Step 14.1: Failing test** `rate-limit.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { makeTestApp } from '#root/testing/test-app'

describe('per-actor rate limit (spec §10, D-v)', () => {
  it('429 rate_limited after the window budget; disabled with 0 (the default in makeTestApp)', async () => {
    // default (limit 0 = off): 5 requests fine
    const t = await makeTestApp()
    for (let i = 0; i < 5; i++) {
      const res = await t.app.inject({ method: 'GET', url: '/audit', headers: nils(t) })
      expect(res.statusCode).toBe(200)
    }
    await t.close()

    const t2 = await makeTestApp({ NS_RATE_LIMIT_PER_MIN: '2' })
    expect(
      (await t2.app.inject({ method: 'GET', url: '/audit', headers: nils(t2) })).statusCode
    ).toBe(200)
    expect(
      (await t2.app.inject({ method: 'GET', url: '/audit', headers: nils(t2) })).statusCode
    ).toBe(200)
    const third = await t2.app.inject({ method: 'GET', url: '/audit', headers: nils(t2) })
    expect(third.statusCode).toBe(429)
    expect(third.json().code).toBe('rate_limited')
    // per-actor: another actor has its own budget — agent token stays 401-uncle, so
    // use the public path probe: public paths bypass (actorRef null) → never throttled
    const pub = await t2.app.inject({ method: 'GET', url: '/ping' })
    expect(pub.statusCode).toBe(200)
    await t2.close()
  })
})
```

(`nils(t)` = bearer helper; same one as other route tests — copy it.)

- [ ] **Step 14.2: RED**, then `src/adapters/rest/rate-limit.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import { DomainError } from '#root/domain/errors'

/**
 * D-v: fixed one-minute windows per authenticated actor id, in-memory. Honest for the
 * single-container model (spec §9); public paths bypass (no actor → no budget to burn).
 * Window = Math.floor(now/60_000); first hit of a window resets the counter.
 */
export const registerRateLimit = (app: FastifyInstance, deps: AppDeps): void => {
  const limit = deps.config.rateLimitPerMin
  if (limit <= 0) return // disabled (test default)
  const buckets = new Map<string, { window: number; count: number }>()
  // registered AFTER auth (needs actorRef resolved) and BEFORE idempotency? No —
  // order: auth → idempotency → rate-limit keeps replayed responses cheap (a replay
  // does not burn budget): register LAST among onRequest hooks in app.ts.
  app.addHook('onRequest', async (request) => {
    if (!request.actorRef) return
    const window = Math.floor(Date.now() / 60_000)
    const hit = buckets.get(request.actorRef.id)
    if (hit && hit.window === window) {
      hit.count += 1
    } else {
      buckets.set(request.actorRef.id, { window, count: 1 })
      return
    }
    if (buckets.size > 1000) {
      // bounded memory hygiene: drop entries from previous windows
      for (const [key, b] of buckets) if (b.window !== window) buckets.delete(key)
    }
    if ((buckets.get(request.actorRef.id)?.count ?? 0) > limit) {
      throw new DomainError(
        'rate_limited',
        `per-actor limit of ${limit} requests/minute exceeded (spec §10)`
      )
    }
  })
}
```

(Read the hook-order comment in `app.ts` before wiring: `registerAuth` then `registerIdempotency` are an ordered pair — auth resolves the actor, idempotency reserves per-actor keys (source comment). Rate-limit goes **after registerIdempotency** so replayed responses (early-return in idempotency's onRequest) skip the counter; public requests are unaffected either way. If the reviewer lands it between auth and idempotency instead, that is a defensible choice too — document the placement in the shipped comment; the test only asserts budget behavior.)

- [ ] **Step 14.3: Wire in `app.ts`** (import + call after `registerIdempotency(server, deps)`), then verify + commit:

```bash
pnpm test && pnpm lint && pnpm typecheck
git add -A
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "feat(rest): per-actor rate limit middleware (spec §10)"
```

> **Amendment (Task 14, lint detour + untestable hygiene arm recorded):** `rate-limit.ts`, its test and the `app.ts` wiring shipped per the blocks — placement LAST among the onRequest hooks (`auth → idempotency → rate-limit`, the block's default; the replay-skips-budget rationale sits as the shipped comment). Deviations: (1) `require-await` flagged the block's await-less `async` hook; a detour to a SYNC hook was attempted and ABANDONED after it empirically hung the request (fastify's hook iterator never resumes a sync-void `onRequest` handler — 5s timeout on the probe run); the block's `async` form stands with a scoped `eslint-disable-next-line @typescript-eslint/require-await` and the reason as its comment. (2) The `buckets.size > 1000` window-drift cleanup loop (and the defensive `?? 0`) are UNTESTED arms: reaching them over HTTP needs ~1001 seeded actors plus cross-window drift, and clock surgery was explicitly out of the testing contract — recorded per the plan's honesty clause; memory is bounded by the shipped cleanup as stated, and actor ids only exist if administered (bounded by creation, not by traffic). All functional arms ARE pinned: disabled (0) bypass, budget-then-429 `rate_limited` via the DomainError→problem pipeline (no enum work — T1 reservation held), public-path bypass via null `actorRef`. Window-reset mechanics: the block's test pins budget behavior only, and none was invented. No idempotency interplay test prescribed — with 429 AFTER reservation, a replay inside the window is answered by idempotency's early-return without burning budget (the placement's stated purpose; Block sync = shipped form.

> **Amendment (Task 14, quality review):** Five review-prescribed touches. (1) The `buckets.size > 1000` sweep was MOVED above the if/else — CONFESSION recorded inline: as shipped by the block it sat below, where the first-hit `return` made it unreachable, so a window rollover of many fresh actors could grow the map until some actor took a second hit; hoisted, any authenticated request can sweep (its arm REMAINS untestable over HTTP — >1000 buckets needs >1000 administered actors; the fix is reachability honesty, not a new pin). (2) Time-seam comment added at `Date.now` (real elapsed time governs throttling; a test clock must not slow the flood). (3) The 429 pin now asserts the full envelope: `application/problem+json` content-type and `status: 429` beside `code`. (4) Per-actor isolation — the §10 headline — pinned by a new test: admin's 2-request budget is spent on the agent bootstrap, admin then 429s while the fresh agent token's first `/audit` answers 200. (5) Doc wording corrected: the bypass is UNAUTHENTICATED/actor-less requests (their throttle is auth's 401), the mechanism a null `actorRef` — not the `PUBLIC_PATHS` set (under shipped auth the two populations coincide; the correction names the mechanism, forward-honest for Plan E sessions); the eslint-disable justification gained "(same deadlock class as requireHuman — auth.ts)". Block sync = shipped form.

---

### Task 15: Acceptance story — the discussion half of spec §14

**Files:**

- Create: `src/adapters/rest/scenarios-discussion.test.ts`

- [ ] **Step 15.1: Write the end-to-end story** (one `it`, mirrors `scenarios.test.ts` conventions — bearer helpers, createActor/issueToken helpers may be imported from that file's module scope or re-declared locally; keep them local to avoid cross-file test coupling). Story:

```ts
import { describe, expect, it } from 'vitest'
import { makeTestApp, type TestApp } from '#root/testing/test-app'

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

describe('acceptance — threads, questions, attachments (spec §14 steps 2, 5, 6)', () => {
  it('file → upload spec → agent asks question (gates review) → human answers → PR link → in_review → done', async () => {
    const t = await makeTestApp()
    const nils = bearer(t.adminToken)
    // actors: ana (human, second circle member) + hermes-1 agent with a token
    const anaId = (
      await t.app.inject({
        method: 'POST',
        url: '/admin/actors',
        headers: nils,
        payload: { kind: 'human', handle: 'ana', display_name: 'Ana' },
      })
    ).json().id as string
    void anaId
    const anaToken = (
      await t.app.inject({
        method: 'POST',
        url: `/admin/actors/${anaId}/tokens`,
        headers: nils,
        payload: { label: 'ana-session' },
      })
    ).json().raw_token as string
    const hermesId = (
      await t.app.inject({
        method: 'POST',
        url: '/admin/actors',
        headers: nils,
        payload: { kind: 'agent', handle: 'hermes-1', display_name: 'Hermes' },
      })
    ).json().id as string
    const sess = bearer(
      (
        await t.app.inject({
          method: 'POST',
          url: `/admin/actors/${hermesId}/tokens`,
          headers: nils,
          payload: { label: 'session-1' },
        })
      ).json().raw_token as string
    )

    // §14.2 — human files task + uploads spec.md attachment → todo
    const task = (
      await t.app.inject({
        method: 'POST',
        url: '/tasks',
        headers: nils,
        payload: { title: 'Rate limiter', acceptance_criteria: '429 under load', status: 'todo' },
      })
    ).json()
    const upload = await t.app.inject({
      method: 'POST',
      url: `/tasks/${task.id}/attachments?filename=spec.md&content_type=text/markdown`,
      headers: { ...nils, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('# Rate limiter\nprotect /api\n'),
    })
    expect(upload.statusCode).toBe(201)

    // agent claims, plans in a note (mention ana), context bundle shows the file
    const claim = (
      await t.app.inject({ method: 'POST', url: `/tasks/${task.id}/claim`, headers: sess })
    ).json()
    await t.app.inject({
      method: 'POST',
      url: `/tasks/${task.id}/threads`,
      headers: sess,
      payload: { kind: 'note', body: 'starting; plan in spec.md — @ana FYI' },
    })
    const context = (
      await t.app.inject({ method: 'GET', url: `/tasks/${task.id}/context`, headers: sess })
    ).json()
    expect(context.attachments.map((a: { filename: string }) => a.filename)).toContain('spec.md')

    // ana sees the mention in HER inbox
    const inbox = (
      await t.app.inject({ method: 'GET', url: '/inbox', headers: bearer(anaToken) })
    ).json()
    expect(inbox.map((i: { kind: string }) => i.kind)).toEqual(['mentioned'])

    // §14.5 — agent asks a question assigned to a human → gates review
    const q = (
      await t.app.inject({
        method: 'POST',
        url: `/tasks/${task.id}/threads`,
        headers: sess,
        payload: {
          kind: 'question',
          body: '429 body shape — JSON problem or plain?',
          assignee_handle: 'ana',
        },
      })
    ).json()
    const blocked = await t.app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}/status`,
      headers: sess,
      payload: { status: 'in_review', reason: 'pr ready', lease_token: claim.lease_token },
    })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().code).toBe('open_questions')

    // ana answers (her own inbox shows the question_assigned too), resolves
    const qInbox = (
      await t.app.inject({
        method: 'GET',
        url: '/inbox?unread_only=true',
        headers: bearer(anaToken),
      })
    ).json()
    expect(qInbox.map((i: { kind: string }) => i.kind)).toContain('question_assigned')
    const answered = await t.app.inject({
      method: 'POST',
      url: `/tasks/${task.id}/threads/${q.thread.id}/answer`,
      headers: bearer(anaToken),
      payload: { body: 'RFC 9457 problem+json' },
    })
    expect(answered.statusCode).toBe(200)
    await t.app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}/threads/${q.thread.id}`,
      headers: bearer(anaToken),
      payload: { state: 'resolved' },
    })

    // §14.6 — agent links the PR, moves to in_review (auto-releases claim), human closes
    const link = await t.app.inject({
      method: 'POST',
      url: `/tasks/${task.id}/links`,
      headers: sess,
      payload: { kind: 'pr', url: 'https://git.example/nightshift/pr/1' },
    })
    expect(link.statusCode).toBe(201)
    const review = await t.app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}/status`,
      headers: sess,
      payload: { status: 'in_review', reason: 'pr ready', lease_token: claim.lease_token },
    })
    expect(review.statusCode).toBe(200)
    const done = await t.app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}/status`,
      headers: nils,
      payload: { status: 'done', reason: 'verified' },
    })
    expect(done.statusCode).toBe(200)

    // audit reconstructs the story; question rows carry their state path
    const audit = (
      await t.app.inject({
        method: 'GET',
        url: `/audit?entity_id=${q.thread.id}&limit=50`,
        headers: nils,
      })
    )
      .json()
      .map((a: { action: string }) => a.action)
    expect(audit).toEqual(
      expect.arrayContaining(['thread_created', 'question_answered', 'question_state_changed'])
    )
    await t.close()
  })
})
```

Adjust names to the shipped route/use-case surface (e.g. the audit search filters `entity_type`+`entity_id`; the shipped audit route supports `entity_id` alone per its schema — verify in `routes/audit.ts` and amend if both params are required). The story IS the pin: invariant 6 fires and lifts over HTTP exactly once.

- [ ] **Step 15.2: Run — this task can't be RED in the TDD sense (all surfaces exist); it is the integration gate.** If it fails, fix the SURFACE (the defect shipped through review), not the story, unless the story itself misreads the plan — then amend with a note here. Full `pnpm test && pnpm lint && pnpm typecheck`, then:

```bash
git add -A
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "test(acceptance): spec §14 discussion-side end-to-end story"
```

---

### Task 16: Hygiene backlog + final gate

Backlog items from the handover ticket. **Files:** `src/adapters/rest/auth.ts` (+ test), `src/infra/sqlite/schema.ts`? no — docs comment only; `.github/workflows/ci.yaml`.

- [ ] **Step 16.1: PUBLIC_PATHS trailing slash (fail-closed cosmetic).** `auth.ts` line: `const path = request.url.split('?')[0]` → keep `PUBLIC_PATHS` contents EXACTLY `{/ping, /openapi.yaml}` (binding); normalize the lookup instead — `const path = (request.url.split('?')[0] ?? '/').replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1')` (collapse duplicate slashes, strip trailing slash except root). This makes `/ping/` hit the public set (currently 401). Test in `auth.test.ts`: unauthenticated `GET /ping/` → 200 (was 401); `GET /audit/` still requires auth (401 without, 200 with — normalization does NOT leak protected paths: normalization only \_matches more public path spellings\*, and `/audit` is absent from PUBLIC_PATHS in any spelling).

- [ ] **Step 16.2: token-hash sanctioned import (document, not relocate).** `auth.ts` and `manage-actors.ts` import `#root/infra/token-hash` — pure `node:crypto` helpers. Plan A already ruled this sanctioned in manage-actors' comments; extend the same one-line note to `auth.ts`'s import: `// sanctioned pure-util import (plan ruling): token-hash is node:crypto-only, no infra coupling`. No code moves (relocation would churn two tested files for zero behavior — the ticket allows "document or relocate").

- [ ] **Step 16.3: CI runs coverage.** `.github/workflows/ci.yaml`: replace `- run: pnpm test` with `- run: pnpm test:coverage` (thresholds stop being pre-push-only; backlog says so explicitly).

- [ ] **Step 16.4: Final whole-suite gate.**

```bash
pnpm test && pnpm test:coverage && pnpm lint && pnpm typecheck && pnpm build
```

Expected: all green; coverage thresholds unchanged (global ≥85, domain 100). Record the final coverage line + test count in the PR description / final commit note (Plan A convention).

- [ ] **Step 16.5: Commit:**

```bash
git add -A
LEFTHOOK_CONFIG=$PWD/lefthook.yaml git commit -m "chore(hygiene): trailing-slash public paths, ci coverage, auth note"
```

---

## Spec coverage self-check (Plan B)

| Spec                                                           | Surface                                                                                | Task                                                                            |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| §6.2 threads move on split, meta-note flag                     | `threads_on_parent` + `meta_note` (human-only, audited)                                | 5, 7                                                                            |
| §6.4.6 question gate `409 open_questions`                      | invariant-6 block in update-status (D-o)                                               | 8                                                                               |
| §6.5 threads/messages/kinds/ordering                           | threads+messages tables, seq ordering (D-y), REST surface                              | 3, 4, 5, 7                                                                      |
| §6.5 question assignee/state/answer_link/reassign, inbox event | D-m/D-n tables + use-cases + PATCH                                                     | 3, 4, 6, 7                                                                      |
| §6.5 `@handle` mentions → inbox                                | D-q extraction + routing                                                               | 1, 5                                                                            |
| §6.6 attachments: FileStore port, content-addressed, cap       | D-s, DiskFileStore                                                                     | 11, 12                                                                          |
| §6.6 links (pr/commit/doc/other + url)                         | D-t, links surface                                                                     | 13                                                                              |
| §6.8 inbox kinds/read-unread                                   | D-r (claim-conflict deferred, stated)                                                  | 5, 6, 9                                                                         |
| §7.2 thread endpoints + context bundle one-call                | routes + get-context fill                                                              | 7, 10                                                                           |
| §7.3 idempotency on new writes                                 | inherited: app-level hook covers all new POST/PATCH/PUT routes automatically           | — (no change; verify in Task 7 test that one POST with Idempotency-Key replays) |
| §10 upload sanitize + nosniff                                  | D-s serving rules                                                                      | 12                                                                              |
| §10 rate limit                                                 | D-v                                                                                    | 14                                                                              |
| §11 error taxonomy                                             | question_transition/rate_limited in errors.ts + yaml same commit; adapter codes pinned | 1, 2                                                                            |
| §14 steps 2/5/6                                                | scenarios-discussion.test.ts                                                           | 15                                                                              |

Deferred (stated at top): §6.8 event feed + webhooks (+SSE later) → Plan C; MCP → D; OIDC/UI → E; Docker/F asset note → F; FTS5 → C; §6.8 `claim-conflict` kind → C.

## Execution protocol (subagent-driven-development)

Per Plan A's proven workflow: fresh implementer subagent per task, in plan order (1→16, strict — Tasks 8/9/10 all touch `deps.ts`, so no parallel lanes on application wiring; Tasks 12 and 13 are the only candidate pair but both touch `app.ts`/`deps.ts`/yaml — keep serial). Implementer: TDD per the task's steps, commit via LEFTHOOK_CONFIG as specified, then an independent spec-review + quality-review (oracle/explore lanes per Plan A practice) BEFORE the next task starts; fix rounds re-verified. On any code ⇄ plan divergence, append the Amendment block to THIS file (byte-sync protocol, commit-hash noted). No pushes to origin — human reviews after.

**Never-lower bar:** coverage thresholds unchanged; `pnpm test:coverage` green at every commit (pre-push hook enforces; CI now too per Task 16). Machine strings `claim released by split` / `claim released on review` remain byte-exact. `PUBLIC_PATHS` set membership unchanged. `actorCtx` spread last in every new route. No new runtime dependencies.
