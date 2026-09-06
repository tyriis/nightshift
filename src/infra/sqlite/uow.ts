import type { Kysely } from 'kysely'
import type { Repos, UnitOfWork } from '#root/application/ports'
import type { DB } from '#root/infra/sqlite/schema'
import { SqliteActorRepo } from '#root/infra/sqlite/actor-repo'
import { SqliteAuditRepo } from '#root/infra/sqlite/audit-repo'
import { SqliteDependencyRepo } from '#root/infra/sqlite/dependency-repo'
import { SqliteLabelRepo } from '#root/infra/sqlite/label-repo'
import { SqliteTaskRepo } from '#root/infra/sqlite/task-repo'

export class SqliteUnitOfWork implements UnitOfWork {
  constructor(private readonly db: Kysely<DB>) {}

  private repos(tx: Kysely<DB>): Repos {
    return {
      tasks: new SqliteTaskRepo(tx),
      audit: new SqliteAuditRepo(tx),
      deps: new SqliteDependencyRepo(tx),
      labels: new SqliteLabelRepo(tx),
      actors: new SqliteActorRepo(tx),
    }
  }

  // Kysely 0.29.5's SqliteDialect hands EVERY caller the same better-sqlite3 connection
  // with no queueing (verified: the sqlite dialect does not use SingleConnectionProvider)
  // — so two overlapping withTransaction() calls make the loser's BEGIN throw
  // "cannot start a transaction within a transaction": a 500, not a domain code. Task 18's
  // §14.3 two-session claim race goes through here. A promise-chain mutex serializes
  // transactions on the single writer — correct and cheap at homelab scale.
  //
  // NOT reentrant: calling withTransaction from inside fn() would enqueue behind itself
  // and deadlock — use-cases own transactions; repos must never call withTransaction.
  //
  // Scope is PER-INSTANCE: serialization only holds between callers of this same UoW
  // object; the wiring provides one singleton SqliteUnitOfWork per Kysely/db.
  private txQueue: Promise<unknown> = Promise.resolve()

  async withTransaction<T>(fn: (repos: Repos) => Promise<T>): Promise<T> {
    const run = (): Promise<T> => this.db.transaction().execute((trx) => fn(this.repos(trx)))
    const result = this.txQueue.then(run, run)
    this.txQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
