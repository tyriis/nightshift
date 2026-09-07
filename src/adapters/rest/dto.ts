import type { TaskWithCounts } from '#root/application/ports'

export interface TaskDto {
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
  child_count: number
  unmet_blockers: number
}

// The ONLY place tasks become public JSON. Claim internals are exposed
// deliberately — "nothing hidden" (spec §5).
export const toTaskDto = (row: TaskWithCounts): TaskDto => ({
  ...row.task,
  child_count: row.child_count,
  unmet_blockers: row.unmet_blockers,
})
