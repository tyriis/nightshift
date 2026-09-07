import Database from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import type { DB } from '#root/infra/sqlite/schema'

export const makeDb = (path: string): Kysely<DB> => {
  const sqlite = new Database(path)
  sqlite.pragma('foreign_keys = ON')
  if (path !== ':memory:') {
    sqlite.pragma('journal_mode = WAL')
  }
  sqlite.pragma('busy_timeout = 5000')
  return new Kysely<DB>({ dialect: new SqliteDialect({ database: sqlite }) })
}
