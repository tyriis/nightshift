import type { TaskRecord, TaskStatus } from '#root/domain/task'
import { DomainError } from '#root/domain/errors'
import type {
  BlockerRow,
  DependencyRepo,
  LabelRow,
  LabelRepo,
  TaskRepo,
} from '#root/application/ports'

export interface ContextAncestor {
  id: string
  title: string
  status: TaskStatus
  acceptance_criteria: string
}

export interface TaskContextBundle {
  task: TaskRecord
  child_count: number
  unmet_blockers: number
  ancestors: ContextAncestor[]
  blockers: BlockerRow[]
  labels: LabelRow[]
  /** seams — populated in Plan B (threads) / later plans; shape fixed by spec §7.2 */
  open_questions: unknown[]
  links: unknown[]
  attachments: unknown[]
}

export class GetContext {
  constructor(
    private readonly tasks: TaskRepo,
    private readonly deps: DependencyRepo,
    private readonly labels: LabelRepo
  ) {}

  async run(input: { taskId: string }): Promise<TaskContextBundle> {
    const withCounts = await this.tasks.findWithCounts(input.taskId)
    if (!withCounts) throw new DomainError('not_found', `task ${input.taskId} not found`)
    const ancestors = await this.tasks.ancestors(input.taskId)
    const blockers = await this.deps.unmetBlockers(input.taskId)
    const labels = await this.labels.labelsFor(input.taskId)
    return {
      task: withCounts.task,
      child_count: withCounts.child_count,
      unmet_blockers: withCounts.unmet_blockers,
      ancestors: ancestors.map((a) => ({
        id: a.id,
        title: a.title,
        status: a.status,
        acceptance_criteria: a.acceptance_criteria,
      })),
      blockers,
      labels,
      open_questions: [],
      links: [],
      attachments: [],
    }
  }
}
