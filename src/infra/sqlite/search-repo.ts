import { sql, type Kysely } from 'kysely'
import { DomainError } from '#root/domain/errors'
import type { TaskSearchHit, TaskSearchRepo } from '#root/application/ports'
import type { DB } from '#root/infra/sqlite/schema'

// D-gg: read-only over the FTS5 external-content index. LIMIT is a bound parameter after
// integer clamping — the limit is our own validated integer, not user text. bm25() is
// negative-better; flipped to score (higher = better) at the port boundary.
// FTS5 SYNTAX errors are QUERY facts (the MATCH string is user input) — mapped to
// invalid_request, taxonomy unchanged. The map is exact: PROBED, better-sqlite3 raises
// SqliteError with two malformed-query shapes — 'fts5: syntax error near …' (e.g.
// 'AND OR') and bare 'unterminated string' (e.g. '"unbalanced'). Anything else
// RE-THROWS (internal_error honesty — no blanket catch that swallows real bugs).
export class SqliteSearchRepo implements TaskSearchRepo {
  constructor(private readonly db: Kysely<DB>) {}

  async search(query: string, limit: number): Promise<TaskSearchHit[]> {
    const capped = Math.max(1, Math.min(200, Math.trunc(limit)))
    let r
    try {
      r = await sql<TaskSearchHit>`
        select
          t.id as id,
          t.title as title,
          snippet(task_fts, 0, '[', ']', '…', 16) as snippet,
          -bm25(task_fts) as score
        from task_fts
        join tasks t on t.rowid = task_fts.rowid
        where task_fts match ${query}
        order by score desc
        limit ${capped}
      `.execute(this.db)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // Probe-confirmed malformed-FTS5 message shapes (never assumed): 'fts5: syntax
      // error near …' and 'unterminated string'. Both are purely functions of the
      // user-supplied MATCH string ⇒ invalid_request. Everything else RE-THROWS.
      if (/^fts5:/i.test(msg) || /^unterminated string/i.test(msg))
        throw new DomainError('invalid_request', `invalid search query: ${msg}`)
      throw e // unknown errors stay internal_error (problem.ts fallback)
    }
    return r.rows.map((row) => ({ ...row, score: Number(row.score) }))
  }
}
