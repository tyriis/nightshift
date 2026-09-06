import { sql, type Kysely } from 'kysely'
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration'
import type { DB } from '#root/infra/sqlite/schema'

const migrations: Record<string, Migration> = {
  '2026-09-06_init': {
    up: async (db: Kysely<DB>) => {
      await sql`create table actors (
        id text primary key,
        kind text not null check (kind in ('human','agent')),
        handle text not null unique,
        display_name text not null,
        description text not null default '',
        created_at text not null
      )`.execute(db)

      await sql`create table tokens (
        id text primary key,
        actor_id text not null references actors(id),
        token_hash text not null unique,
        label text not null,
        created_at text not null,
        last_used_at text,
        revoked_at text
      )`.execute(db)

      await sql`create table tasks (
        id text primary key,
        parent_id text references tasks(id),
        title text not null,
        description text not null default '',
        acceptance_criteria text not null default '',
        status text not null default 'backlog'
          check (status in ('backlog','todo','in_progress','in_review','done','canceled')),
        blocked_flag integer not null default 0,
        assignee_id text references actors(id),
        position real not null,
        created_by text not null references actors(id),
        created_at text not null,
        updated_at text not null,
        claim_token_id text references tokens(id),
        claim_generation integer not null default 0,
        last_heartbeat_at text
      )`.execute(db)
      await sql`create index tasks_parent_idx on tasks (parent_id)`.execute(db)
      await sql`create index tasks_status_idx on tasks (status)`.execute(db)

      await sql`create table dependencies (
        id integer primary key autoincrement,
        blocker_id text not null references tasks(id),
        blocked_id text not null references tasks(id),
        unique (blocker_id, blocked_id),
        check (blocker_id <> blocked_id)
      )`.execute(db)

      await sql`create table labels (
        id text primary key,
        name text not null unique,
        color text not null default '#888888',
        created_at text not null
      )`.execute(db)

      await sql`create table task_labels (
        task_id text not null references tasks(id),
        label_id text not null references labels(id),
        primary key (task_id, label_id)
      )`.execute(db)

      await sql`create table audit_log (
        id integer primary key autoincrement,
        actor_id text,
        token_id text,
        action text not null,
        entity_type text not null,
        entity_id text not null,
        before_json text,
        after_json text,
        reason text,
        created_at text not null
      )`.execute(db)

      await sql`create table policy (key text primary key, value text not null)`.execute(db)
      await sql`insert into policy (key, value) values ('review_gate', 'on')`.execute(db)

      await sql`create table idempotency_keys (
        actor_id text not null,
        idem_key text not null,
        request_method text not null,
        request_path text not null,
        status integer,
        body text,
        created_at text not null,
        primary key (actor_id, idem_key)
      )`.execute(db)
    },
  },
}

class InCodeMigrationProvider implements MigrationProvider {
  getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve(migrations)
  }
}

export const migrateToLatest = async (db: Kysely<DB>): Promise<void> => {
  const { error } = await new Migrator({
    db,
    provider: new InCodeMigrationProvider(),
  }).migrateToLatest()
  if (error) throw error instanceof Error ? error : new Error('migration failed', { cause: error })
}
