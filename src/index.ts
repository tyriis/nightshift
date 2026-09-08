import { loadConfig } from '#root/main/config'
import { makeDepsFromDb } from '#root/main/deps'
import { ensureBootstrapAdmin } from '#root/main/bootstrap'
import { makeDb } from '#root/infra/sqlite/db'
import { migrateToLatest } from '#root/infra/sqlite/migrations'
import { buildApp } from '#root/adapters/rest/app'

const config = loadConfig()

// module-level double-signal guard: a second SIGTERM/SIGINT while close() is
// already running must be a no-op, not a re-entrant shutdown
let closing = false

const start = async (): Promise<void> => {
  try {
    const db = makeDb(config.dbPath)
    await migrateToLatest(db)
    // D-j startup purge: reservations (status IS NULL) left behind by a crash can
    // never complete — a fresh process has nothing in flight, so clear them and
    // leave those keys retryable.
    await db.deleteFrom('idempotency_keys').where('status', 'is', null).execute()
    const deps = makeDepsFromDb(db, config)
    await ensureBootstrapAdmin(deps)
    const server = buildApp(deps, { logger: true })
    await server.listen({ port: config.port, host: '0.0.0.0' })
    deps.deliveryLoop.start() // refuses when intervalMs 0 (config-level kill, D-v lineage)

    const shutdown = async (): Promise<void> => {
      if (closing) return
      closing = true
      server.log.info('Graceful shutdown signal received')
      await deps.deliveryLoop.stop() // drains the in-flight pass before the db goes away
      await server.close()
      await db.destroy()
      process.exit(0)
    }
    process.on('SIGTERM', () => void shutdown())
    process.on('SIGINT', () => void shutdown())
  } catch (err) {
    // startup failure (migrate/purge/bootstrap/listen) = clean exit(1),
    // not a bare unhandled rejection
    console.error(err)
    process.exit(1)
  }
}

void start()
