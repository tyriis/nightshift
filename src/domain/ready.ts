import type { TaskStatus } from '#root/domain/task'

export interface ReadyCandidate {
  status: TaskStatus
  blocked_flag: boolean
  child_count: number
  claim_holder: boolean
  unmet_blockers: number
}

export const isTaskReady = (t: ReadyCandidate): boolean =>
  t.status === 'todo' &&
  !t.blocked_flag &&
  t.child_count === 0 &&
  !t.claim_holder &&
  t.unmet_blockers === 0
