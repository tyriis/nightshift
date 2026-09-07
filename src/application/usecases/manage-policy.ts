import { DomainError } from '#root/domain/errors'
import type { ActorContext, Clock, UnitOfWork } from '#root/application/ports'

const POLICY_ALLOWLIST: Record<string, readonly string[]> = {
  review_gate: ['on', 'off'],
}

export class GetPolicy {
  constructor(private readonly uow: UnitOfWork) {}

  async run(input: { key: string }): Promise<string | null> {
    if (!(input.key in POLICY_ALLOWLIST)) {
      throw new DomainError('not_found', `unknown policy key '${input.key}'`)
    }
    return this.uow.withTransaction(async (repos) => repos.actors.getPolicy(input.key))
  }
}

export interface SetPolicyInput extends ActorContext {
  key: string
  value: string
}

export class SetPolicy {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock
  ) {}

  async run(input: SetPolicyInput): Promise<void> {
    const allowed = POLICY_ALLOWLIST[input.key]
    if (!allowed || !allowed.includes(input.value)) {
      throw new DomainError(
        'invalid_request',
        `policy '${input.key}' does not accept value '${input.value}'`
      )
    }
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      await repos.actors.setPolicy(input.key, input.value)
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'policy_set',
        entity_type: 'policy',
        entity_id: input.key,
        after: { value: input.value },
        reason: 'policy updated',
        created_at: now,
      })
    })
  }
}
