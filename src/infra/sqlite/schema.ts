import type { Generated } from 'kysely'
import type { ActorKind, TaskStatus } from '#root/domain/task'

export interface ActorsTable {
  id: string
  kind: ActorKind
  handle: string
  display_name: string
  description: string
  created_at: string
}

export interface TokensTable {
  id: string
  actor_id: string
  token_hash: string
  label: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

export interface TasksTable {
  id: string
  parent_id: string | null
  title: string
  description: string
  acceptance_criteria: string
  status: TaskStatus
  blocked_flag: number
  assignee_id: string | null
  position: number
  created_by: string
  created_at: string
  updated_at: string
  claim_token_id: string | null
  claim_generation: number
  last_heartbeat_at: string | null
}

export interface DependenciesTable {
  id: Generated<number>
  blocker_id: string
  blocked_id: string
}

export interface LabelsTable {
  id: string
  name: string
  color: string
  created_at: string
}

export interface TaskLabelsTable {
  task_id: string
  label_id: string
}

export interface AuditLogTable {
  id: Generated<number>
  actor_id: string | null
  token_id: string | null
  action: string
  entity_type: string
  entity_id: string
  before_json: string | null
  after_json: string | null
  reason: string | null
  created_at: string
}

export interface PolicyTable {
  key: string
  value: string
}

export interface IdempotencyKeysTable {
  actor_id: string
  idem_key: string
  request_method: string
  request_path: string
  status: number | null
  body: string | null
  created_at: string
}

export interface DB {
  actors: ActorsTable
  tokens: TokensTable
  tasks: TasksTable
  dependencies: DependenciesTable
  labels: LabelsTable
  task_labels: TaskLabelsTable
  audit_log: AuditLogTable
  policy: PolicyTable
  idempotency_keys: IdempotencyKeysTable
}
