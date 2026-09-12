import type { ActorKind, HumanRole } from '#root/domain/task'
import { DomainError } from '#root/domain/errors'
// Utility import (pure node:crypto, no DB/adapter/transport) — sanctioned as
// plan-verbatim by orchestrator ruling; the hexagonal no-infra rule targets repo/adapter layers.
import { generateRawToken, hashToken } from '#root/infra/token-hash'
import type {
  ActorContext,
  ActorRow,
  Clock,
  IdGen,
  TokenRow,
  UnitOfWork,
} from '#root/application/ports'

export interface CreateActorInput extends ActorContext {
  kind: ActorKind
  handle: string
  display_name: string
  description?: string
  /** D-ss: humans only; default 'member' (admins stay an explicit decision); dropped for agents */
  role?: HumanRole
}

export class CreateActor {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGen
  ) {}

  async run(input: CreateActorInput): Promise<ActorRow> {
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      if (await repos.actors.findByHandle(input.handle)) {
        throw new DomainError('handle_taken', `handle '${input.handle}' already exists`)
      }
      const actor = await repos.actors.create({
        id: this.ids.newId('a'),
        kind: input.kind,
        handle: input.handle,
        display_name: input.display_name,
        description: input.description ?? '',
        created_at: now,
        // D-ss: humans default to 'member' — admin is always an explicit decision;
        // agents carry no role (null, never admin).
        role: input.kind === 'human' ? (input.role ?? 'member') : null,
      })
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'actor_created',
        entity_type: 'actor',
        entity_id: actor.id,
        after: { kind: actor.kind, handle: actor.handle },
        reason: 'actor created',
        created_at: now,
      })
      return actor
    })
  }
}

export interface SetActorRoleInput extends ActorContext {
  id: string
  /** the edge enum is the HUMAN_ROLES twin (routes/admin.ts); no second gate needed */
  role: HumanRole
}

/**
 * issue #23: the admin-managed role switch, HUMANS ONLY (agents are role-null by
 * construction — D-ss — and stay untouched). Two refusals:
 * - the last admin cannot be demoted: with zero admins the board cannot self-heal
 *   (the bootstrap `a_bootstrap` row is a plain admin row here, no special arm);
 * - non-human actors and absent ids keep their existing doctrine.
 * Audit rides `role_changed` with before/after, the update-status.ts lineage.
 */
export class SetActorRole {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock
  ) {}

  async run(input: SetActorRoleInput): Promise<ActorRow> {
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      const actor = await repos.actors.findById(input.id)
      if (!actor) throw new DomainError('not_found', `actor ${input.id} not found`)
      if (actor.kind !== 'human') {
        throw new DomainError(
          'invalid_request',
          `actor ${input.id} is not a human — only humans carry a role`
        )
      }
      // last-admin guard: a demotion needs a SECOND admin to survive on the board;
      // an already-member target is a plain rewrite, never a demotion.
      if (actor.role === 'admin' && input.role !== 'admin') {
        const admins = (await repos.actors.list()).filter(
          (a) => a.kind === 'human' && a.role === 'admin'
        )
        if (admins.length === 1) {
          throw new DomainError(
            'invalid_request',
            `actor ${input.id} is the last admin — demoting it leaves no admin`
          )
        }
      }
      await repos.actors.setRole(input.id, input.role)
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'role_changed',
        entity_type: 'actor',
        entity_id: input.id,
        before: { role: actor.role },
        after: { role: input.role },
        reason: 'role changed',
        created_at: now,
      })
      // the row was written in this very tx — the null arm of findById is unreachable
      // (the CreateToken plan-verbatim cast precedent)
      return (await repos.actors.findById(input.id)) as ActorRow
    })
  }
}

export interface CreateTokenInput extends ActorContext {
  actor_id: string
  label: string
}

export interface IssuedToken {
  raw_token: string
  token: TokenRow
}

export class CreateToken {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGen
  ) {}

  /** Raw token is returned exactly once; only its SHA-256 is stored (spec §5). */
  async run(input: CreateTokenInput): Promise<IssuedToken> {
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      const actor = await repos.actors.findById(input.actor_id)
      if (!actor) throw new DomainError('not_found', `actor ${input.actor_id} not found`)
      const raw = generateRawToken()
      const id = this.ids.newId('tok')
      await repos.actors.insertToken({
        id,
        actor_id: input.actor_id,
        token_hash: hashToken(raw),
        label: input.label,
        created_at: now,
      })
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'token_created',
        entity_type: 'actor',
        entity_id: input.actor_id,
        after: { token_id: id, label: input.label },
        reason: 'token issued',
        created_at: now,
      })
      // Plan-verbatim cast: the row was inserted on this very transaction, so the
      // null arm of findTokenById is unreachable here.
      const token = (await repos.actors.findTokenById(id)) as TokenRow
      return { raw_token: raw, token }
    })
  }
}

export interface RevokeTokenInput extends ActorContext {
  token_id: string
}

export class RevokeToken {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock
  ) {}

  async run(input: RevokeTokenInput): Promise<void> {
    const now = this.clock.now().toISOString()
    return this.uow.withTransaction(async (repos) => {
      const token = await repos.actors.findTokenById(input.token_id)
      if (!token) throw new DomainError('not_found', `token ${input.token_id} not found`)
      await repos.actors.revokeToken(input.token_id, now)
      await repos.audit.append({
        actor_id: input.actor.id,
        token_id: input.tokenId,
        action: 'token_revoked',
        entity_type: 'actor',
        entity_id: token.actor_id,
        after: { token_id: input.token_id },
        reason: 'token revoked',
        created_at: now,
      })
    })
  }
}
