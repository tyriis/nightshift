import { z } from 'zod'

const EnvSchema = z.object({
  NS_PORT: z.coerce.number().int().min(1024).max(65535).default(3123),
  NS_DB_PATH: z.string().min(1).default('./nightshift.db'),
  NS_BOOTSTRAP_TOKEN: z.string().min(32).optional(),
  NS_DATA_DIR: z.string().min(1).default('./data'),
  NS_MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).default(20_971_520),
  NS_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(0).default(120),
  NS_WEBHOOK_INTERVAL_MS: z.coerce.number().int().min(0).default(1_000),
  NS_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),
  NS_WEBHOOK_MAX_BACKOFF_MS: z.coerce.number().int().min(1_000).default(300_000),
})

export interface Config {
  port: number
  dbPath: string
  bootstrapToken?: string
  dataDir: string
  maxUploadBytes: number
  rateLimitPerMin: number
  /** delivery-loop poll interval; 0 = loop disabled (test default; D-v lineage) */
  webhookIntervalMs: number
  webhookTimeoutMs: number
  webhookMaxBackoffMs: number
}

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const r = EnvSchema.safeParse(env)
  if (!r.success) {
    throw new Error(`invalid env: ${JSON.stringify(z.treeifyError(r.error))}`)
  }
  return {
    port: r.data.NS_PORT,
    dbPath: r.data.NS_DB_PATH,
    bootstrapToken: r.data.NS_BOOTSTRAP_TOKEN,
    dataDir: r.data.NS_DATA_DIR,
    maxUploadBytes: r.data.NS_MAX_UPLOAD_BYTES,
    rateLimitPerMin: r.data.NS_RATE_LIMIT_PER_MIN,
    webhookIntervalMs: r.data.NS_WEBHOOK_INTERVAL_MS,
    webhookTimeoutMs: r.data.NS_WEBHOOK_TIMEOUT_MS,
    webhookMaxBackoffMs: r.data.NS_WEBHOOK_MAX_BACKOFF_MS,
  }
}
