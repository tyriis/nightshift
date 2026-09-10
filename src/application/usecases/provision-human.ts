// D-tt: OIDC first-login provisioning — reached ONLY from the /auth/callback
// allow-list leg (email_verified ∧ listed). The handle-derivation algorithm is
// PINNED by provision-human.test.ts; audits human_provisioned on the spine
// (bootstrap's unaudited-init ruling does NOT extend here — this is a runtime
// mutation). The tx carries the race guard: a double callback cannot
// double-provision.
import { DomainError } from '#root/domain/errors'
import type { ActorRow, Clock, IdGen, UnitOfWork } from '#root/application/ports'

export interface ProvisionHumanInput {
  /** the VERIFIED id_token sub — bound to the row as oidc_subject */
  sub: string
  email?: string
  preferred_username?: string
}

// PINNED handle algorithm (review note (b): D-q grammar [A-Za-z0-9][A-Za-z0-9_-]*
// with lowercase normalization; Task 7's sanitize governs): lowercase → strip every
// char outside [a-z0-9_-] → strip leading chars until alphanumeric → 'user' if
// empty → slice(0, 60). Source preference: username → email local-part → subject.
export const oidcHandle = (input: ProvisionHumanInput): string => {
  const source =
    input.preferred_username ?? (input.email ? input.email.split('@')[0] : undefined) ?? input.sub
  const stripped = source
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^[^a-z0-9]+/, '')
  return (stripped === '' ? 'user' : stripped).slice(0, 60)
}

export class ProvisionHumanFromOidc {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGen
  ) {}

  async run(input: ProvisionHumanInput): Promise<ActorRow> {
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      // race guard (pinned): the subject wins — an existing binding is RETURNED
      // with zero create/audit (two concurrent callbacks, one human)
      const existing = await repos.actors.findByOidcSubject(input.sub)
      if (existing) return existing
      const base = oidcHandle(input)
      // collisions append -2, -3, … (handle_taken is NEVER thrown at provision
      // time); the candidate space is base + -2..-20 (pinned), exhaustion →
      // invalid_request
      let handle: string | null = null
      for (let n = 1; n <= 20; n++) {
        const candidate = n === 1 ? base : `${base}-${n}`
        if (!(await repos.actors.findByHandle(candidate))) {
          handle = candidate
          break
        }
      }
      if (handle === null) {
        throw new DomainError('invalid_request', 'handle space exhausted (D-tt)')
      }
      const actor = await repos.actors.create({
        id: this.ids.newId('a'),
        kind: 'human',
        handle,
        display_name: handle, // pinned: display_name rides the handle
        description: '',
        created_at: now,
        // D-ss: MEMBERS arrive only via D-tt provisioning — admin is never here
        role: 'member',
        oidc_subject: input.sub,
      })
      await repos.audit.append({
        // the spine attributes the event to the provisioned actor (no session,
        // no token exists yet — the sub rides `after`)
        actor_id: actor.id,
        token_id: null,
        action: 'human_provisioned',
        entity_type: 'actor',
        entity_id: actor.id,
        after: { handle, subject: input.sub },
        reason: 'oidc first-login allow-list', // pinned (D-tt)
        created_at: now,
      })
      return actor
    })
  }
}
