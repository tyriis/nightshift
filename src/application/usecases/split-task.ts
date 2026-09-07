import { TASK_STATUSES, type TaskRecord, type TaskStatus } from '#root/domain/task'
import { DomainError } from '#root/domain/errors'
import type {
  ActorContext,
  Clock,
  IdGen,
  UnitOfWork,
  TaskWithCounts,
} from '#root/application/ports'

export interface SplitChildDraft {
  title: string
  description?: string
  acceptance_criteria?: string
  status?: TaskStatus
}

export interface SplitTaskInput extends ActorContext {
  taskId: string
  children: SplitChildDraft[]
}

export interface SplitTaskResult {
  parent: TaskWithCounts
  created: TaskRecord[]
}

export class SplitTask {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGen
  ) {}

  async run(input: SplitTaskInput): Promise<SplitTaskResult> {
    const now = this.clock.now().toISOString()
    if (input.children.length === 0) {
      throw new DomainError('invalid_request', 'split requires at least one child')
    }
    for (const child of input.children) {
      const status = child.status ?? 'backlog'
      if (!TASK_STATUSES.includes(status)) {
        throw new DomainError('invalid_request', `unknown status '${status}'`)
      }
    }
    return this.uow.withTransaction(async (repos) => {
      const parent = await repos.tasks.findById(input.taskId)
      if (!parent) throw new DomainError('not_found', `task ${input.taskId} not found`)

      if (parent.claim_token_id) {
        await repos.tasks.clearClaim(input.taskId, now)
        await repos.audit.append({
          actor_id: input.actor.id,
          token_id: input.tokenId,
          action: 'claim_released',
          entity_type: 'task',
          entity_id: input.taskId,
          reason: 'claim released by split',
          created_at: now,
        })
      }

      const created: TaskRecord[] = []
      for (const child of input.children) {
        const position = await repos.tasks.nextPosition(input.taskId)
        const childTask = await repos.tasks.create({
          id: this.ids.newId('t'),
          parent_id: input.taskId,
          title: child.title,
          description: child.description ?? '',
          acceptance_criteria: child.acceptance_criteria ?? '',
          // Ruling A (default derivation, not a status gate — nothing is ever rejected on
          // parent status): children of a groomed parent (beyond backlog) default to 'todo',
          // the claim-ready status (spec ready(), §6.4.1), so the ex-claimant "continues by
          // claiming one of the children" (spec §6.2, §14.4). Backlog parents keep backlog
          // children (Task 8 test 1 pin). 'todo' (not inherited in_progress) keeps D-a's
          // atomic todo→in_progress claim transition and "in_progress ⇒ being worked".
          status: child.status ?? (parent.status === 'backlog' ? 'backlog' : 'todo'),
          position,
          created_by: input.actor.id,
          created_at: now,
          updated_at: now,
        })
        created.push(childTask)
      }

      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'task_split',
        entity_type: 'task',
        entity_id: input.taskId,
        after: { child_ids: created.map((c) => c.id) },
        reason: `split into ${created.length} children`,
        created_at: now,
      })

      const parentWithCounts = (await repos.tasks.findWithCounts(input.taskId)) as TaskWithCounts
      return { parent: parentWithCounts, created }
    })
  }
}
