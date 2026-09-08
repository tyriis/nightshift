import type { InboxItemKind, LinkKind, QuestionState, ThreadKind } from '#root/domain/discussion'
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
  getById(id: string): Promise<LabelRow | null>
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
  /** Actor that owns the given token id (for exposing a claim holder's public identity). */
  findActorByTokenId(tokenId: string): Promise<ActorRow | null>
  list(): Promise<ActorRow[]>
  insertToken(input: {
    id: string
    actor_id: string
    token_hash: string
    label: string
    created_at: string
  }): Promise<void>
  findActiveTokenByHash(hash: string): Promise<TokenLookup | null>
  findTokenById(id: string): Promise<TokenRow | null>
  revokeToken(id: string, at: string): Promise<void>
  touchToken(id: string, at: string): Promise<void>
  listTokensForActor(actorId: string): Promise<TokenRow[]>
  getPolicy(key: string): Promise<string | null>
  setPolicy(key: string, value: string): Promise<void>
}

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

export type ThreadRecord = ThreadDraft

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

// The D-r vocabulary lives in the domain (INBOX_ITEM_KINDS, the sqlite CHECK's twin);
// ports only names the type for app-layer consumers — no second source to drift.
export type InboxKind = InboxItemKind

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

export type LinkRecord = LinkDraft

export interface LinkRepo {
  add(draft: LinkDraft): Promise<LinkRecord>
  find(id: string): Promise<LinkRecord | null>
  findByTaskKindUrl(taskId: string, kind: LinkKind, url: string): Promise<LinkRecord | null>
  remove(id: string): Promise<void>
  listForTask(taskId: string): Promise<LinkRecord[]>
}

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

// ---- wiring seams

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

export interface UnitOfWork {
  withTransaction<T>(fn: (repos: Repos) => Promise<T>): Promise<T>
}

// ---- actor context passed into every use-case invocation

export interface ActorContext {
  actor: ActorRef
  /** id of the authenticated token performing the request (audit attribution, spec §5) */
  tokenId: string | null
}
