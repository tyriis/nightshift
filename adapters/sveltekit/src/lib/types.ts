// types.ts — one interface per DTO, transcribed from the SHIPPED route files and
// src/adapters/rest/dto.ts (+ the ports.ts rows the routes serialize raw). No field
// here exists that the named route line does not emit.

// dto.ts:3-24 TaskDto — flat task row + rollup counts + label names (R3/B12).
export interface TaskDto {
  id: string
  parent_id: string | null
  title: string
  description: string
  acceptance_criteria: string
  status: string // TASK_STATUSES (dto.ts serializes the column)
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
  labels: string[]
}

// threads.ts:18 → thread-repo.ts:55 ThreadWithMessages[]; Thread row = ports.ts:265-275.
export interface ThreadDto {
  id: string
  task_id: string
  kind: 'note' | 'question'
  state: 'open' | 'answered' | 'resolved' | 'wont_fix' | null // null for notes (D-m)
  assignee_id: string | null
  answer_message_id: string | null
  created_by: string
  created_at: string
  updated_at: string
}

// ports.ts:279-286 (threads.ts:80 message responses; addMessage/answer return it).
export interface MessageDto {
  id: string
  thread_id: string
  seq: number
  author_id: string
  body: string
  created_at: string
}

// thread-repo.ts:55 ThreadWithMessages; create-thread.ts:23-26 returns the same pair.
export interface ThreadWithMessagesDto {
  thread: ThreadDto
  messages: MessageDto[]
}

// inbox.ts:22 → ports.ts:331-342 InboxItemRecord (kind vocabulary mirrors INBOX_ITEM_KINDS).
export interface InboxItemDto {
  id: string
  actor_id: string
  kind: 'assigned' | 'mentioned' | 'question_assigned' | 'claim_conflict'
  task_id: string
  thread_id: string | null
  read: boolean
  created_at: string
}

// audit.ts:22 → ports.ts:36-47 AuditRow (search response; before/after are JSON snapshots).
export interface AuditEntryDto {
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

// routes/events.ts:7-16 FeedEvent (toEvent's FULL field list — review R4/B9: the
// cursor rides alongside, not instead of, the audit attribution fields).
export interface FeedEvent {
  cursor: number
  actor_id: string | null
  token_id: string | null
  action: string
  entity_type: string
  entity_id: string
  reason: string | null
  created_at: string
}

// auth.ts:224 GET /auth/me → actorCtx(request).actor = ports.ts:12-20 ActorRef.
export interface ActorMe {
  id: string
  kind: 'human' | 'agent'
  handle: string
  display_name: string
  role: 'admin' | 'member' | null
}

// admin.ts:10-12 GET /admin/actors → actorsRoot.list() = ActorRow + oidc_subject
// (BL1 Task-2: the admin identity surface serializes both new columns).
export interface ActorDto {
  id: string
  kind: 'human' | 'agent'
  role: 'admin' | 'member' | null
  oidc_subject: string | null
  handle: string
  display_name: string
  description: string
  created_at: string
}

// admin.ts:83-89 POST /admin/actors/{id}/tokens response (raw_token shown exactly once).
export interface TokenDto {
  token_id: string
  actor_id: string
  label: string
  created_at: string
  raw_token: string
}

// webhooks.ts:9 webhooksRoot.list() = ports.ts:415-422 WebhookRecord.
export interface WebhookDto {
  id: string
  actor_id: string
  url: string
  created_by: string
  created_at: string
  delivered_cursor: number
}

// webhooks.ts:36/:49 create/rotate spread {...webhook, secret} — secret exists only here.
export interface WebhookWithSecretDto extends WebhookDto {
  secret: string
}

// labels.ts:6 labelsRoot.list() = ports.ts:122-127 LabelRow.
export interface LabelDto {
  id: string
  name: string
  color: string
  created_at: string
}

// admin.ts:136-166 allowlist ops → ports.ts:231-235 AllowlistRow.
export interface AllowlistDto {
  email: string
  added_by: string
  created_at: string
}

// links.ts:15 linksRoot.listForTask = ports.ts:378-385 LinkRecord.
export interface LinkDto {
  id: string
  task_id: string
  kind: 'pr' | 'commit' | 'doc' | 'other'
  url: string
  created_by: string
  created_at: string
}

// attachments.ts:61 attachmentsRoot.listForTask = ports.ts:356-365 AttachmentRecord.
export interface AttachmentDto {
  id: string
  task_id: string
  filename: string
  content_type: string
  sha256: string
  bytes: number
  created_by: string
  created_at: string
}

// get-context.ts:24-34 TaskContextBundle (tasks.ts:84 passes it through un-DTO'd).
export interface ContextAncestorDto {
  id: string
  title: string
  status: string
  acceptance_criteria: string
}

// ports.ts:105-109 BlockerRow (context.blockers — UNMET blockers only, the shipped read).
export interface BlockerRowDto {
  id: string
  title: string
  status: string
}

// ports.ts:293-299 OpenQuestionRow.
export interface OpenQuestionDto {
  id: string
  state: string
  assignee_handle: string
  question: string
}

// domain/task.ts TaskRecord as the sqlite row serializes it (dto.ts toRecord fields):
// the context bundle's `task` is this RAW row — counts and labels are sibling fields,
// never inside `task` (get-context.ts:53).
export interface TaskRecordDto {
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
}

// get-context.ts:24-34: task is the raw TaskRecord row (no counts inside), counts beside.
export interface ContextBundleDto {
  task: TaskRecordDto
  child_count: number
  unmet_blockers: number
  ancestors: ContextAncestorDto[]
  blockers: BlockerRowDto[]
  labels: LabelDto[]
  open_questions: OpenQuestionDto[]
  links: LinkDto[]
  attachments: AttachmentDto[]
}

// admin.ts:106/:131 GET/PUT /admin/policy/:key → { key, value }; GetPolicy returns
// string | null (manage-policy.ts:14).
export interface PolicyDto {
  key: string
  value: string | null
}
