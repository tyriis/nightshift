import type { Kysely } from 'kysely'
import type { Repos, UnitOfWork } from '#root/application/ports'
import type { DB } from '#root/infra/sqlite/schema'
import { SqliteActorRepo } from '#root/infra/sqlite/actor-repo'
import { SqliteAttachmentRepo } from '#root/infra/sqlite/attachment-repo'
import { SqliteAuditRepo } from '#root/infra/sqlite/audit-repo'
import { SqliteDependencyRepo } from '#root/infra/sqlite/dependency-repo'
import { SqliteInboxRepo } from '#root/infra/sqlite/inbox-repo'
import { SqliteLabelRepo } from '#root/infra/sqlite/label-repo'
import { SqliteLinkRepo } from '#root/infra/sqlite/link-repo'
import { SqliteTaskRepo } from '#root/infra/sqlite/task-repo'
import { SqliteThreadRepo } from '#root/infra/sqlite/thread-repo'

export class SqliteUnitOfWork implements UnitOfWork {
  constructor(private readonly db: Kysely<DB>) {}

  private repos(tx: Kysely<DB>): Repos {
    return {
      tasks: new SqliteTaskRepo(tx),
      audit: new SqliteAuditRepo(tx),
      deps: new SqliteDependencyRepo(tx),
      labels: new SqliteLabelRepo(tx),
      actors: new SqliteActorRepo(tx),
      threads: new SqliteThreadRepo(tx),
      inbox: new SqliteInboxRepo(tx),
      attachments: new SqliteAttachmentRepo(tx),
      links: new SqliteLinkRepo(tx),
    }
  }

  // Kysely 0.29.5 already serializes connection acquisition for SQLite
  // (RuntimeDriver wraps the single connection in its own ConnectionMutex, held from
  // BEGIN through COMMIT/ROLLBACK), so overlapping transactions do NOT error. This
  // promise-chain queue adds STRICT FIFO fairness on the single writer and keeps
  // ordering deterministic if a pooled or multi-connection dialect ever replaces
  // SqliteDialect.
  //
  // NOT reentrant: never touch the root db from inside fn — neither a nested
  // withTransaction nor a plain root-db query. Kysely's own connection mutex is held
  // for the whole transaction, so an inner acquisition waits FOREVER (silent deadlock,
  // no error, no timeout). Use-cases own transactions; repos receive the tx and never
  // start their own or capture the root db.
  //
  // FIFO scope is per-instance; SAFETY is global (Kysely's driver mutex), so multiple
  // UoW instances over one db cannot corrupt anything — they only lose shared ordering.
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
