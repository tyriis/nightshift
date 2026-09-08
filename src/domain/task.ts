export const TASK_STATUSES = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'canceled',
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const ACTOR_KINDS = ['human', 'agent'] as const
export type ActorKind = (typeof ACTOR_KINDS)[number] // identical union to the prior hand-written type

export interface TaskRecord {
  id: string
  parent_id: string | null
  title: string
  description: string
  acceptance_criteria: string
  status: TaskStatus
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

export interface TaskDraft {
  id: string
  parent_id: string | null
  title: string
  description: string
  acceptance_criteria: string
  status: TaskStatus
  position: number
  created_by: string
  created_at: string
  updated_at: string
}
