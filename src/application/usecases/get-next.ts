import { isTaskReady } from '#root/domain/ready'
import type { TaskRepo, TaskWithCounts } from '#root/application/ports'

export interface GetNextInput {
  label?: string
  limit?: number
}

export class GetNext {
  constructor(private readonly tasks: TaskRepo) {}

  /**
   * The SQL in `listReady` is a coarse pre-filter; the domain predicate
   * (`domain/ready.ts`) is the authoritative gate (spec §6.3/§9: invariants live in the domain).
   */
  async run(input: GetNextInput): Promise<TaskWithCounts[]> {
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 100)
    const rows = await this.tasks.listReady({ label: input.label, limit })
    return rows.filter((r) =>
      isTaskReady({
        status: r.task.status,
        blocked_flag: r.task.blocked_flag,
        child_count: r.child_count,
        claim_holder: r.task.claim_token_id !== null,
        unmet_blockers: r.unmet_blockers,
      })
    )
  }
}
