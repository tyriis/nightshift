import type { Kysely } from 'kysely'
import type { IdempotencyOutcome, IdempotencyRepo } from '#root/application/ports'
import type { DB } from '#root/infra/sqlite/schema'

export class SqliteIdempotencyRepo implements IdempotencyRepo {
  constructor(private readonly db: Kysely<DB>) {}

  async reserve(input: {
    actor_id: string
    idem_key: string
    request_method: string
    request_path: string
    created_at: string
  }): Promise<IdempotencyOutcome> {
    // First-caller wins: the composite PK (actor_id, idem_key) makes a duplicate
    // insert a no-op (doNothing), so `numInsertedOrUpdatedRows` is 0 for a racer and
    // 1 for the original. A no-returning insert always yields exactly one InsertResult,
    // so executeTakeFirstOrThrow mirrors the Task-4/5 idiom (no `as`-cast).
    const res = await this.db
      .insertInto('idempotency_keys')
      .values({ ...input, status: null, body: null })
      .onConflict((oc) => oc.columns(['actor_id', 'idem_key']).doNothing())
      .executeTakeFirstOrThrow()
    if (Number(res.numInsertedOrUpdatedRows) === 1) return { state: 'reserved' }

    // Conflict: read whoever owns the key. A stored body means the original finished
    // (=> replay); a null body means it is still in flight (=> a duplicate racing it).
    const row = await this.db
      .selectFrom('idempotency_keys')
      .selectAll()
      .where('actor_id', '=', input.actor_id)
      .where('idem_key', '=', input.idem_key)
      .executeTakeFirst()
    if (row && row.status !== null && row.body !== null) {
      return { state: 'complete', status: row.status, body: row.body }
    }
    return { state: 'in_flight' }
  }

  async complete(actorId: string, key: string, status: number, body: string): Promise<void> {
    // Stores the response for replay. An UPDATE that matches no row is a silent
    // no-op (never materialises a phantom key), matching remove()'s key-scoping.
    await this.db
      .updateTable('idempotency_keys')
      .set({ status, body })
      .where('actor_id', '=', actorId)
      .where('idem_key', '=', key)
      .execute()
  }

  async remove(actorId: string, key: string): Promise<void> {
    // Called on the 5xx path so a failed attempt never poisons the key (decision D-j).
    await this.db
      .deleteFrom('idempotency_keys')
      .where('actor_id', '=', actorId)
      .where('idem_key', '=', key)
      .execute()
  }
}
