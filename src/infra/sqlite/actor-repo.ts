import type { Kysely } from 'kysely'
import type { ActorRepo, ActorRow, TokenLookup, TokenRow } from '#root/application/ports'
import type { DB } from '#root/infra/sqlite/schema'

export class SqliteActorRepo implements ActorRepo {
  constructor(private readonly db: Kysely<DB>) {}

  async create(input: {
    id: string
    kind: ActorRow['kind']
    handle: string
    display_name: string
    description: string
    created_at: string
    role: ActorRow['role']
    /** D-tt: present only on OIDC-provisioned rows (the create site owns the binding) */
    oidc_subject?: string
  }): Promise<ActorRow> {
    return this.db.insertInto('actors').values(input).returningAll().executeTakeFirstOrThrow()
  }

  async findByHandle(handle: string): Promise<ActorRow | null> {
    const r = await this.db
      .selectFrom('actors')
      .selectAll()
      .where('handle', '=', handle)
      .executeTakeFirst()
    return r ?? null
  }

  async findByOidcSubject(subject: string): Promise<ActorRow | null> {
    // D-tt login path, not the token hot path: FULL row, no trim (plan pin). The
    // unique index lives on actors(oidc_subject); NULLs never match ('=' is null-
    // rejecting), so agents and pre-E humans are invisible here by construction.
    const r = await this.db
      .selectFrom('actors')
      .selectAll()
      .where('oidc_subject', '=', subject)
      .executeTakeFirst()
    return r ?? null
  }

  async findById(id: string): Promise<ActorRow | null> {
    const r = await this.db.selectFrom('actors').selectAll().where('id', '=', id).executeTakeFirst()
    return r ?? null
  }

  async findActorByTokenId(tokenId: string): Promise<ActorRow | null> {
    // Deviation from the plan block (which used unqualified selectAll() + an
    // `as ActorRow | undefined ?? null` cast): with a join, unqualified selectAll() emits
    // SELECT * and better-sqlite3 lets duplicate column names (id, created_at) resolve to
    // the LAST occurrence — the returned row carried tokens.id in `id`. selectAll('actors')
    // restricts to actor columns, is exactly ActorRow-typed (no cast needed), same idiom as
    // findActiveTokenByHash.
    const r = await this.db
      .selectFrom('actors')
      .selectAll('actors')
      .innerJoin('tokens', 'tokens.actor_id', 'actors.id')
      .where('tokens.id', '=', tokenId)
      .executeTakeFirst()
    return r ?? null
  }

  async list(): Promise<ActorRow[]> {
    return this.db.selectFrom('actors').selectAll().orderBy('handle', 'asc').execute()
  }

  async insertToken(input: {
    id: string
    actor_id: string
    token_hash: string
    label: string
    created_at: string
  }): Promise<void> {
    await this.db.insertInto('tokens').values(input).execute()
  }

  async findActiveTokenByHash(hash: string): Promise<TokenLookup | null> {
    // Trimmed actor on purpose (plan note): the auth path only consumes id/kind/handle/
    // display_name, so no description/created_at round-trip. token_hash is deliberately
    // NOT carried into TokenRow.
    const r = await this.db
      .selectFrom('tokens')
      .selectAll('tokens')
      .innerJoin('actors', 'actors.id', 'tokens.actor_id')
      .select([
        'actors.kind as a_kind',
        'actors.handle as a_handle',
        'actors.display_name as a_display',
        'actors.role as a_role',
      ])
      .where('tokens.token_hash', '=', hash)
      .where('tokens.revoked_at', 'is', null)
      .executeTakeFirst()
    if (!r) return null
    const token: TokenRow = {
      id: r.id,
      actor_id: r.actor_id,
      label: r.label,
      created_at: r.created_at,
      last_used_at: r.last_used_at,
      revoked_at: r.revoked_at,
    }
    const actor: ActorRow = {
      id: r.actor_id,
      kind: r.a_kind,
      handle: r.a_handle,
      display_name: r.a_display,
      description: '',
      created_at: '',
      role: r.a_role,
    }
    return { token, actor }
  }

  async findTokenById(id: string): Promise<TokenRow | null> {
    const r = await this.db.selectFrom('tokens').selectAll().where('id', '=', id).executeTakeFirst()
    if (!r) return null
    // map strips token_hash so the secret never leaks into returned rows
    return {
      id: r.id,
      actor_id: r.actor_id,
      label: r.label,
      created_at: r.created_at,
      last_used_at: r.last_used_at,
      revoked_at: r.revoked_at,
    }
  }

  async revokeToken(id: string, at: string): Promise<void> {
    await this.db.updateTable('tokens').set({ revoked_at: at }).where('id', '=', id).execute()
  }

  async touchToken(id: string, at: string): Promise<void> {
    await this.db.updateTable('tokens').set({ last_used_at: at }).where('id', '=', id).execute()
  }

  async listTokensForActor(actorId: string): Promise<TokenRow[]> {
    const rows = await this.db
      .selectFrom('tokens')
      .selectAll()
      .where('actor_id', '=', actorId)
      .orderBy('created_at', 'asc')
      .execute()
    // map strips token_hash so the secret never leaks into returned rows
    return rows.map((r) => ({
      id: r.id,
      actor_id: r.actor_id,
      label: r.label,
      created_at: r.created_at,
      last_used_at: r.last_used_at,
      revoked_at: r.revoked_at,
    }))
  }

  async getPolicy(key: string): Promise<string | null> {
    const r = await this.db
      .selectFrom('policy')
      .select('value')
      .where('key', '=', key)
      .executeTakeFirst()
    return r?.value ?? null
  }

  async setPolicy(key: string, value: string): Promise<void> {
    await this.db
      .insertInto('policy')
      .values({ key, value })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value }))
      .execute()
  }
}
