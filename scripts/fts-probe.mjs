#!/usr/bin/env node
// fts-probe.mjs — the FTS5 arms Plan C declared-not-pinned (D-eee): the in-migration
// rebuild's data-carry and the delete trigger (task_fts_ad has no app-level delete path).
// Run against a COPY of the volume db, never the live file (the checklist shows the
// copy). Uses the repo's/image's better-sqlite3; FK enforcement is ON on a bare
// connection (measured at Task 6 execution — the plan's "off (bare default)" claim is
// wrong; amendment) — this is a TRIGGER + index check, stated honestly, so the
// smoke task's FK children (their own note + attachment) are cleared on the COPY first.
// usage: node scripts/fts-probe.mjs <copy-of-nightshift.db>
import Database from 'better-sqlite3'

const file = process.argv[2]
if (!file) {
  console.error('usage: node scripts/fts-probe.mjs <copy-of-nightshift.db>')
  process.exit(2)
}
const db = new Database(file)
const count = (q, ...args) => db.prepare(q).get(...args).n
// arm 1 — data-carry: the deploy-smoke task (created by scripts/deploy-smoke.mjs)
// must be MATCH-able through the fts index exactly as the app writes it
// the double-quote PHRASE wrapping is load-bearing: bare deploy-smoke is FTS5
// column-exclusion grammar (the hyphen), not a term — the plan text threw
// "no such column: smoke" at execution (Task 6 amendment; same tokens, same test)
const matched = count(`select count(*) as n from task_fts where task_fts match '"deploy-smoke"'`)
const smoke = db
  .prepare("select rowid as rid, id from tasks where title like 'deploy-smoke%' limit 1")
  .get()
if (matched < 1 || smoke === undefined) {
  console.log(
    `FAIL fts data-carry — match:${matched} task:${smoke ? smoke.id : 'none'} (run deploy-smoke.mjs against this volume first)`
  )
  process.exit(1)
}
console.log(`PASS fts data-carry — ${matched} MATCH 'deploy-smoke' row(s), task ${smoke.id}`)
// arm 2 — the delete trigger: on the COPY, removing the tasks row must prune task_fts.
// The three child-row deletes are copy-side SETUP for the FK-enforced copy (deploy-smoke
// INTENTIONALLY leaves the note + attachment children); the arm under test stays the
// tasks delete + the pruning assertion below.
const before = count('select count(*) as n from task_fts')
db.prepare(
  'delete from messages where thread_id in (select id from threads where task_id = ?)'
).run(smoke.id)
db.prepare('delete from attachments where task_id = ?').run(smoke.id)
db.prepare('delete from threads where task_id = ?').run(smoke.id)
db.prepare('delete from tasks where id = ?').run(smoke.id)
const survives = count('select count(*) as n from task_fts where rowid = ?', smoke.rid)
console.log(
  survives === 0
    ? `PASS fts delete-trigger — rowid ${smoke.rid} pruned (${before} → ${count('select count(*) as n from task_fts')}, copy only)`
    : `FAIL fts delete-trigger — fts rowid ${smoke.rid} survives the tasks delete`
)
process.exit(survives === 0 ? 0 : 1)
