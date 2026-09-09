import { DomainError } from '#root/domain/errors'
import type { ActorContext, AllowlistRow, Clock, UnitOfWork } from '#root/application/ports'

// D-tt email rule. The route's JSON-schema pattern ('^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$')
// twins this regex as the edge fence; the use-case owns validation AND the lowercase
// normalization — the matching side (Task 7's callback) lowercases id_token emails
// identically. Both sides pinned in the tests.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface AddAllowlistInput extends ActorContext {
  email: string
}

export interface AddAllowlistResult {
  created: boolean
  row: AllowlistRow
}

export class AddAllowlist {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock
  ) {}

  async run(input: AddAllowlistInput): Promise<AddAllowlistResult> {
    const email = input.email.trim().toLowerCase()
    if (!EMAIL_RE.test(email)) {
      throw new DomainError('invalid_request', 'invalid email (D-tt)')
    }
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      const existing = await repos.allowlist.findByEmail(email)
      // duplicate is idempotent DATA, not error (D-tt): a 409 would need a new
      // DomainErrorCode — forbidden. The created flag drives the route's 201/200.
      if (existing) return { created: false, row: existing }
      await repos.allowlist.insert({ email, added_by: input.actor.id, created_at: now })
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'allowlist_added',
        entity_type: 'allowlist',
        entity_id: email,
        after: { email },
        reason: 'allow-list entry added',
        created_at: now,
      })
      return { created: true, row: { email, added_by: input.actor.id, created_at: now } }
    })
  }
}

export interface RemoveAllowlistInput extends ActorContext {
  email: string
}

export class RemoveAllowlist {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock
  ) {}

  async run(input: RemoveAllowlistInput): Promise<void> {
    // normalize before lookup (the same lowercase rule as Add); no format
    // re-validation — ghost-404 doctrine: any absent email is the same 404
    const email = input.email.trim().toLowerCase()
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      if (!(await repos.allowlist.remove(email))) {
        throw new DomainError('not_found', `allow-list entry '${email}' not found`)
      }
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'allowlist_removed',
        entity_type: 'allowlist',
        entity_id: email,
        after: { email },
        reason: 'allow-list entry removed',
        created_at: now,
      })
    })
  }
}

export class ListAllowlist {
  constructor(private readonly uow: UnitOfWork) {}

  // the ctx rides the uniform invocation shape (every /admin op spreads actorCtx);
  // the read itself needs nothing from it
  async run(_input: ActorContext): Promise<AllowlistRow[]> {
    return this.uow.withTransaction((repos) => repos.allowlist.list())
  }
}
