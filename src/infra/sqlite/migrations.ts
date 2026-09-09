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
        blocked_flag integer not null default 0 check (blocked_flag in (0,1)),
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
      // blocked_id-leading index: wouldCycle CTE, unmetBlockers, the unmet-blocker correlated
      // subqueries and listReady's NOT EXISTS all filter by blocked_id alone (EXPLAIN-verified:
      // without it each is a full SCAN per candidate — get-next is the hot agent-poll path).
      await sql`create index dependencies_blocked_idx on dependencies (blocked_id)`.execute(db)

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
      // entity_id index: audit is never purged (spec §6.7) and every entity/activity-tab read
      // filters entity_id order by id desc (EXPLAIN-verified: SCAN without this).
      await sql`create index audit_log_entity_idx on audit_log (entity_id)`.execute(db)

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

  '2026-09-11_discussion': {
    up: async (db: Kysely<DB>) => {
      // D-m: question IS a thread (kind='question'); the CHECKs encode the shape rules
      // so a malformed row cannot exist no matter which code path wrote it.
      await sql`create table threads (
        id text primary key,
        task_id text not null references tasks(id),
        kind text not null check (kind in ('note','question')),
        state text check (state in ('open','answered','resolved','wont_fix')),
        assignee_id text references actors(id),
        answer_message_id text,
        created_by text not null references actors(id),
        created_at text not null,
        updated_at text not null,
        check ((kind = 'question') = (state is not null)),
        check (kind = 'note' or assignee_id is not null)
      )`.execute(db)
      // task_id-leading index: every thread read filters by task (the thread list, the
      // invariant-6 open-question gate). EXPLAIN-verified: SEARCH threads USING INDEX
      // threads_task_idx (task_id=?) with it — including the task_id+kind+state gate
      // variant — full SCAN threads without (created_at ordering stays a TEMP B-TREE;
      // the autoindex is the text-PK only and covers nothing else).
      await sql`create index threads_task_idx on threads (task_id)`.execute(db)
      // answer_message_id carries no FK: the integrity guarantee lives in AnswerQuestion's
      // single transaction (D-n) — the column is only set after the answer row exists.
      // (SQLite permits forward FK refs at CREATE, so creation order was never the constraint.)

      await sql`create table messages (
        id text primary key,
        thread_id text not null references threads(id),
        seq integer not null,
        author_id text not null references actors(id),
        body text not null,
        created_at text not null,
        unique (thread_id, seq)
      )`.execute(db)

      await sql`create table inbox_items (
        id text primary key,
        actor_id text not null references actors(id),
        kind text not null check (kind in ('assigned','mentioned','question_assigned')),
        task_id text not null references tasks(id),
        thread_id text references threads(id),
        read integer not null default 0 check (read in (0,1)),
        created_at text not null
      )`.execute(db)
      // (actor, read)-leading index: GET /inbox?unread is THE inbox read path; small
      // circle ⇒ the two hot filters are covered by this one index. EXPLAIN-verified:
      // SEARCH inbox_items USING INDEX inbox_actor_idx (actor_id=? AND read=?), full
      // SCAN without it (created_at ordering stays a TEMP B-TREE).
      await sql`create index inbox_actor_idx on inbox_items (actor_id, read)`.execute(db)

      await sql`create table attachments (
        id text primary key,
        task_id text not null references tasks(id),
        filename text not null,
        content_type text not null,
        sha256 text not null,
        bytes integer not null,
        created_by text not null references actors(id),
        created_at text not null,
        unique (task_id, sha256, filename)
      )`.execute(db)

      await sql`create table links (
        id text primary key,
        task_id text not null references tasks(id),
        kind text not null check (kind in ('pr','commit','doc','other')),
        url text not null,
        created_by text not null references actors(id),
        created_at text not null,
        unique (task_id, kind, url)
      )`.execute(db)
    },
  },

  '2026-09-12_inbox_claim_conflict': {
    up: async (db: Kysely<DB>) => {
      // D-cc: claim_conflict joins the inbox vocabulary (D-r deferred it until runner
      // wake paths exist — webhooks ship that path in this plan). SQLite cannot ALTER
      // a CHECK, so the table is rebuilt in place: identical columns, extended set,
      // then the data rides across in one statement. Column list is explicit (never
      // select *) so a future column addition fails this copy LOUDLY.
      await sql`create table inbox_items_v2 (
        id text primary key,
        actor_id text not null references actors(id),
        kind text not null check (kind in ('assigned','mentioned','question_assigned','claim_conflict')),
        task_id text not null references tasks(id),
        thread_id text references threads(id),
        read integer not null default 0 check (read in (0,1)),
        created_at text not null
      )`.execute(db)
      await sql`insert into inbox_items_v2
                  select id, actor_id, kind, task_id, thread_id, read, created_at from inbox_items`.execute(
        db
      )
      await sql`drop table inbox_items`.execute(db)
      await sql`alter table inbox_items_v2 rename to inbox_items`.execute(db)
      // re-create the (actor, read) index dropped with the old table — same name, same
      // definition as the discussion migration's EXPLAIN-verified pin
      await sql`create index inbox_actor_idx on inbox_items (actor_id, read)`.execute(db)
    },
  },

  '2026-09-12_webhooks': {
    up: async (db: Kysely<DB>) => {
      // D-bb/D-ff: one row per registered callback, its delivery checkpoint riding
      // with it (a separate ledger table is the second source D-aa rejects). secret
      // is PLAINTEXT on purpose — an HMAC signing key the loop must re-read; unlike
      // bearer tokens it cannot be stored hashed (D-ff states the exception). url is
      // UNIQUE: a runner gets exactly one wake path, and a re-register is an upsert
      // decision this board refuses to make silently.
      await sql`create table webhooks (
        id text primary key,
        actor_id text not null references actors(id),
        url text not null unique,
        secret text not null,
        created_by text not null references actors(id),
        created_at text not null,
        delivered_cursor integer not null default 0,
        attempts integer not null default 0,
        next_attempt_at integer not null default 0
      )`.execute(db)
    },
  },

  '2026-09-12_fts_search': {
    up: async (db: Kysely<DB>) => {
      // D-gg (spec §9 "nearly free"): EXTERNAL-CONTENT FTS5 — text lives in `tasks`,
      // the index lives here. content_rowid='rowid': tasks.id is TEXT (RandomIdGen),
      // which cannot alias rowid, but a rowid table KEEPS its implicit rowid — the
      // triggers mirror (task_ai/ad/au) keep the index honest. NO UI yet (§12):
      // reads ship as a repo port only.
      await sql`create virtual table task_fts using fts5(
        title, description, acceptance_criteria,
        content='tasks', content_rowid='rowid', tokenize='unicode61'
      )`.execute(db)
      await sql`create trigger task_fts_ai after insert on tasks begin
        insert into task_fts (rowid, title, description, acceptance_criteria)
          values (new.rowid, new.title, new.description, new.acceptance_criteria);
      end`.execute(db)
      await sql`create trigger task_fts_ad after delete on tasks begin
        insert into task_fts (task_fts, rowid) values ('delete', old.rowid);
      end`.execute(db)
      await sql`create trigger task_fts_au after update on tasks begin
        insert into task_fts (task_fts, rowid, title, description, acceptance_criteria)
          values ('delete', old.rowid, old.title, old.description, old.acceptance_criteria);
        insert into task_fts (rowid, title, description, acceptance_criteria)
          values (new.rowid, new.title, new.description, new.acceptance_criteria);
      end`.execute(db)
      // population: external-content FTS5 does NOT back-fill on its own. The canonical
      // rebuild ships IN the migration: on CI the content table is empty (no-op) and on
      // a homelab upgrade it indexes every pre-existing task — one statement, both paths.
      await sql`insert into task_fts(task_fts) values ('rebuild')`.execute(db)
    },
  },

  '2026-09-13_human_identity': {
    up: async (db: Kysely<DB>) => {
      // D-ss (AMENDED pre-dispatch, preflight P4/fix5 — amendment ledger): ADD
      // COLUMN, NOT a _v2 rebuild. The 2026-09-12_inbox_claim_conflict exemplar
      // drops a CHILD table; actors is a PARENT — eight pre-E tables carry
      // references actors(id) — and with makeDb's foreign_keys=ON a parent DROP
      // throws FOREIGN KEY constraint failed inside the migration transaction on
      // any deployed DB with child rows (defer_foreign_keys still fails at COMMIT
      // even with the parent restored by name; foreign_keys=OFF is a no-op
      // mid-transaction — both probe-recorded; actors-only test fixtures cannot
      // see it). ADD COLUMN + a UNIQUE INDEX enforce the identical semantics: the
      // CHECK rejects non-vocabulary roles; the index rejects duplicate subjects
      // and permits many NULLs. Roles + subject ride the actors row itself (the
      // auth hot path already loads it; a side table would fork actor truth).
      await sql`alter table actors add column role text check (role in ('admin','member'))`.execute(
        db
      )
      await sql`alter table actors add column oidc_subject text`.execute(db)
      await sql`create unique index actors_oidc_subject_u on actors (oidc_subject)`.execute(db)
      // Backfill: every PRE-E human created the board or was admin-created with a
      // login token => 'admin'; MEMBERS arrive only via the D-tt provisioning path.
      await sql`update actors set role = 'admin' where kind = 'human'`.execute(db)

      // D-qq: server-side sessions are the revocation truth; the cookie is a
      // signed pointer, not the state. Lazy expiry on read — no sweeper loop.
      await sql`create table sessions (
        id text primary key,
        actor_id text not null references actors(id),
        csrf text not null,
        created_at text not null,
        expires_at text not null,
        revoked_at text
      )`.execute(db)

      // D-tt: admin-managed first-login allow-list (email = lowercased identity email)
      await sql`create table oidc_allowlist (
        email text primary key,
        added_by text not null references actors(id),
        created_at text not null
      )`.execute(db)

      // fail-closed default (update-status.ts:72-79 lineage): off = deny all first-logins
      await sql`insert into policy (key, value) values ('oidc_provisioning', 'off')`.execute(db)
    },
  },
}

class InCodeMigrationProvider implements MigrationProvider {
  getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve(migrations)
  }
}

// Pinned export (Task 2): the migration test stops the Migrator at the PRE-E head to
// exercise the human-identity backfill — same record the provider serves.
export const MIGRATIONS = migrations

export const migrateToLatest = async (db: Kysely<DB>): Promise<void> => {
  const { error } = await new Migrator({
    db,
    provider: new InCodeMigrationProvider(),
  }).migrateToLatest()
  if (error) throw error instanceof Error ? error : new Error('migration failed', { cause: error })
}
