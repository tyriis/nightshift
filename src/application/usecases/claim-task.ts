import { formatLeaseToken } from '#root/domain/claim'
import { DomainError, isDomainError } from '#root/domain/errors'
import type { TaskStatus } from '#root/domain/task'
import type { ActorContext, Clock, IdGen, UnitOfWork } from '#root/application/ports'

export interface ClaimTaskInput extends ActorContext {
  taskId: string
}

export interface ClaimResult {
  lease_token: string
  generation: number
}

export class ClaimTask {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGen // D-cc: the loser inbox copy needs an id
  ) {}

  async run(input: ClaimTaskInput): Promise<ClaimResult> {
    const now = this.clock.now().toISOString()
    if (!input.tokenId) {
      throw new DomainError('invalid_request', 'claiming requires an authenticated token')
    }
    // Typecheck deviation (sanctioned, inherited): input.tokenId loses its null-guard
    // narrowing inside the transaction closure — capture the narrowed string here.
    const tokenId = input.tokenId
    try {
      return await this.uow.withTransaction(async (repos) => {
        const task = await repos.tasks.findById(input.taskId)
        if (!task) throw new DomainError('not_found', `task ${input.taskId} not found`)
        if (task.status === 'canceled') {
          throw new DomainError('canceled_terminal', `task ${input.taskId} is canceled`)
        }
        if (task.status !== 'todo' && task.status !== 'in_progress') {
          throw new DomainError(
            'invalid_request',
            `task in status '${task.status}' is not claimable`
          )
        }
        // Invariant 1 / D6: leaf-claim
        if (await repos.tasks.hasChildren(input.taskId)) {
          throw new DomainError('not_a_leaf', 'work happens on leaves; claim a child instead')
        }

        const alreadyClaimed = async (): Promise<DomainError> => {
          // ora-14 M-1 (inherited): FRESH re-read — after a lost CAS the current row is
          // the truth about who holds the claim today.
          const fresh = await repos.tasks.findById(input.taskId)
          const holder = fresh?.claim_token_id
            ? await repos.actors.findActorByTokenId(fresh.claim_token_id)
            : null
          return new DomainError(
            'already_claimed',
            `task is claimed by ${holder?.display_name ?? 'another actor'}`,
            {
              holder_handle: holder?.handle ?? null,
              holder_display_name: holder?.display_name ?? null,
            }
          )
        }

        if (task.claim_token_id) throw await alreadyClaimed()

        const newStatus: TaskStatus = task.status === 'todo' ? 'in_progress' : task.status
        const result = await repos.tasks.tryClaim(task.id, tokenId, input.actor.id, newStatus, now)
        if (!result) throw await alreadyClaimed() // lost a race between check and CAS

        await repos.audit.append({
          actor_id: input.actor.id,
          token_id: input.tokenId,
          action: 'claim_acquired',
          entity_type: 'task',
          entity_id: task.id,
          after: { generation: result.generation },
          reason: 'claim acquired',
          created_at: now,
        })
        return {
          lease_token: formatLeaseToken(task.id, result.generation),
          generation: result.generation,
        }
      })
    } catch (e) {
      // D-cc: the race loser's async copy (deferred by D-r until wake paths existed —
      // webhooks shipped them). It MUST ride a SECOND transaction: the first one just
      // rolled back, so writing inside it is writing nothing. Rethrow is byte-exact:
      // the 409 contract (code + holder details) is unchanged for synchronous callers.
      if (isDomainError(e) && e.code === 'already_claimed' && !selfReclaim(input.actor.handle, e)) {
        await this.uow.withTransaction(async (repos) => {
          await repos.inbox.add({
            id: this.ids.newId('ib'),
            actor_id: input.actor.id,
            kind: 'claim_conflict',
            task_id: input.taskId,
            thread_id: null,
            created_at: now,
          })
        })
      }
      throw e
    }
  }
}

/** D-cc guard: a holder retrying its OWN claimed task must not spam its inbox — the
 *  synchronous 409 already tells it exactly that. Handle-identity, not id: the 409's
 *  details carry the holder's PUBLIC handle vocabulary (ora-14 M-1 shape unchanged). */
const selfReclaim = (handle: string, e: DomainError): boolean => e.details?.holder_handle === handle
