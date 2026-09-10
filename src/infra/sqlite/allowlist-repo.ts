import type { Kysely } from 'kysely'
import type { AllowlistRepo, AllowlistRow } from '#root/application/ports'
import type { DB } from '#root/infra/sqlite/schema'

// D-tt: admin-managed first-login allow-list. Writes ride the tx Repos seam
// (uow.ts, through the use-cases); deps.allowlistRoot is the root-connection twin
// for read paths — same dual-wiring rationale as actorsRoot/sessionsRoot.
export class SqliteAllowlistRepo implements AllowlistRepo {
  constructor(private readonly db: Kysely<DB>) {}

  async list(): Promise<AllowlistRow[]> {
    // deterministic wire order: emails ascending (pinned in the repo test)
    return this.db.selectFrom('oidc_allowlist').selectAll().orderBy('email').execute()
  }

  async findByEmail(email: string): Promise<AllowlistRow | null> {
    const row = await this.db
      .selectFrom('oidc_allowlist')
      .selectAll()
      .where('email', '=', email)
      .executeTakeFirst()
    return row ?? null
  }

  async insert(input: { email: string; added_by: string; created_at: string }): Promise<void> {
    await this.db.insertInto('oidc_allowlist').values(input).execute()
  }

  async remove(email: string): Promise<boolean> {
    const res = await this.db
      .deleteFrom('oidc_allowlist')
      .where('email', '=', email)
      .executeTakeFirst()
    return Number(res.numDeletedRows) > 0
  }
}
