import { loadConfig } from '#root/main/config'
import { makeDepsFromDb } from '#root/main/deps'
import { ensureBootstrapAdmin } from '#root/main/bootstrap'
import { makeDb } from '#root/infra/sqlite/db'
import { migrateToLatest } from '#root/infra/sqlite/migrations'
import { buildApp } from '#root/adapters/rest/app'

const config = loadConfig()

const start = async (): Promise<void> => {
  const db = makeDb(config.dbPath)
  await migrateToLatest(db)
  // D-j startup purge: reservations (status IS NULL) left behind by a crash can
  // never complete — a fresh process has nothing in flight, so clear them and
  // leave those keys retryable.
  await db.deleteFrom('idempotency_keys').where('status', 'is', null).execute()
  const deps = makeDepsFromDb(db, config)
  await ensureBootstrapAdmin(deps)
  const server = buildApp(deps, { logger: true })

  try {
    await server.listen({ port: config.port, host: '0.0.0.0' })
  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }

  const shutdown = async (): Promise<void> => {
    server.log.info('Graceful shutdown signal received')
    await server.close()
    await db.destroy()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
}

void start()
