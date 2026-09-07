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

// ---- actor context passed into every use-case invocation

export interface ActorContext {
  actor: ActorRef
  /** id of the authenticated token performing the request (audit attribution, spec §5) */
  tokenId: string | null
}
