import type { TaskRecord, TaskStatus } from '#root/domain/task'
import { DomainError } from '#root/domain/errors'
import type {
  AttachmentRepo,
  BlockerRow,
  DependencyRepo,
  LabelRow,
  LabelRepo,
  LinkRepo,
  OpenQuestionRow,
  LinkRecord,
  AttachmentRecord,
  ThreadRepo,
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
  open_questions: OpenQuestionRow[]
  links: LinkRecord[]
  attachments: AttachmentRecord[]
}

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
      open_questions: await this.threads.openQuestionsForTask(input.taskId),
      links: await this.linksRepo.listForTask(input.taskId),
      attachments: await this.attachmentsRepo.listForTask(input.taskId),
    }
  }
}
