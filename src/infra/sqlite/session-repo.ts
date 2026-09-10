import type { Kysely } from 'kysely'
import type { SessionLookup, SessionRepo } from '#root/application/ports'
import type { DB } from '#root/infra/sqlite/schema'

// D-qq: the sessions table is the revocation truth; the auth hot path reads
// through here (root connection — deps.ts sessionsRoot, not the tx Repos seam).
export class SqliteSessionRepo implements SessionRepo {
  constructor(private readonly db: Kysely<DB>) {}

  async create(input: {
    id: string
    actor_id: string
    csrf: string
    created_at: string
    expires_at: string
  }): Promise<void> {
    await this.db.insertInto('sessions').values(input).execute()
  }

  async findValid(id: string, now: string): Promise<SessionLookup | null> {
    const row = await this.db
      .selectFrom('sessions')
      .innerJoin('actors', 'actors.id', 'sessions.actor_id')
      .selectAll('sessions')
      .select([
        'actors.id as a_id',
        'actors.kind as a_kind',
        'actors.handle as a_handle',
        'actors.display_name as a_display_name',
        'actors.role as a_role',
      ])
      .where('sessions.id', '=', id)
      .where('sessions.revoked_at', 'is', null)
      .where('sessions.expires_at', '>', now) // ISO lexicographic — same story as every timestamp here
      .executeTakeFirst()
    if (!row) return null
    const { a_id, a_kind, a_handle, a_display_name, a_role, ...session } = row
    return {
      session: { ...session, revoked_at: null }, // the where-arm guarantees null; shape kept total
      actor: {
        id: a_id,
        kind: a_kind,
        handle: a_handle,
        display_name: a_display_name,
        role: a_role,
        description: '',
        created_at: '',
      },
    }
  }

  async revoke(id: string, at: string): Promise<void> {
    await this.db.updateTable('sessions').set({ revoked_at: at }).where('id', '=', id).execute()
  }
}
