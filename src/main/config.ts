import { z } from 'zod'

const EnvSchema = z
  .object({
    NS_PORT: z.coerce.number().int().min(1024).max(65535).default(3123),
    NS_DB_PATH: z.string().min(1).default('./nightshift.db'),
    NS_BOOTSTRAP_TOKEN: z.string().min(32).optional(),
    NS_DATA_DIR: z.string().min(1).default('./data'),
    NS_MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).default(20_971_520),
    NS_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(0).default(120),
    NS_WEBHOOK_INTERVAL_MS: z.coerce.number().int().min(0).default(1_000),
    NS_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),
    NS_WEBHOOK_MAX_BACKOFF_MS: z.coerce.number().int().min(1_000).default(300_000),
    // Plan E (D-pp/D-qq): OIDC RP + cookie sessions. All optional — the suite and
    // every pre-E deployment stays byte-identical when absent (dormant). Trailing
    // slashes are STRIPPED here once: issuer string-equality (D-pp) and the
    // redirect_uri are built from these exact values.
    NS_OIDC_ISSUER: z
      .string()
      .min(1)
      .optional()
      .transform((v) => v?.replace(/\/+$/, '')),
    NS_OIDC_CLIENT_ID: z.string().min(1).optional(),
    // D-ff posture: env-only, never logged, never printed in tests; sent in the
    // token-endpoint BODY only (client_secret_post), never the URL.
    NS_OIDC_CLIENT_SECRET: z.string().min(8).optional(),
    NS_OIDC_SCOPE: z.string().min(1).default('openid profile email'),
    NS_PUBLIC_URL: z
      .string()
      .min(1)
      .optional()
      .transform((v) => v?.replace(/\/+$/, '')),
    NS_SESSION_KEY: z.string().min(32).optional(),
    NS_SESSION_TTL_S: z.coerce.number().int().min(60).max(2_592_000).default(28_800),
    // Plan G (D-ggg): keepalive enforcement, DORMANT by default (0/0) on the
    // NS_WEBHOOK_INTERVAL_MS precedent. Interval = sweeper tick; timeout = silence
    // budget before a silent claim expires. superRefine keeps it all-or-nothing —
    // a half-opened posture fails the boot (D-qq precedent).
    NS_KEEPALIVE_INTERVAL_MS: z.coerce.number().int().min(0).default(0),
    NS_KEEPALIVE_TIMEOUT_S: z.coerce.number().int().min(0).default(0),
    // fail-closed matrix (D-qq): once OIDC is configured (issuer AND client id),
    // the session key and our own public URL are REQUIRED — a half-configured
    // login surface is worse than no login surface.
  })
  .superRefine((e, ctx) => {
    if (e.NS_OIDC_ISSUER && e.NS_OIDC_CLIENT_ID) {
      if (!e.NS_SESSION_KEY) {
        ctx.addIssue({
          code: 'custom',
          message: 'NS_SESSION_KEY is required when OIDC is configured',
          path: ['NS_SESSION_KEY'],
        })
      }
      if (!e.NS_PUBLIC_URL) {
        ctx.addIssue({
          code: 'custom',
          message: 'NS_PUBLIC_URL is required when OIDC is configured',
          path: ['NS_PUBLIC_URL'],
        })
      }
    }
    // D-ggg fail-closed matrix: enforcement is all-or-nothing, and the budget must
    // be at least one tick (a sub-tick budget is a policy the timer cannot honor).
    if (e.NS_KEEPALIVE_INTERVAL_MS > 0 && e.NS_KEEPALIVE_TIMEOUT_S <= 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'NS_KEEPALIVE_TIMEOUT_S is required when the sweeper interval is set',
        path: ['NS_KEEPALIVE_TIMEOUT_S'],
      })
    }
    if (e.NS_KEEPALIVE_TIMEOUT_S > 0 && e.NS_KEEPALIVE_INTERVAL_MS <= 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'NS_KEEPALIVE_INTERVAL_MS is required when a lease timeout is set',
        path: ['NS_KEEPALIVE_INTERVAL_MS'],
      })
    }
    if (
      e.NS_KEEPALIVE_INTERVAL_MS > 0 &&
      e.NS_KEEPALIVE_TIMEOUT_S * 1000 < e.NS_KEEPALIVE_INTERVAL_MS
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'NS_KEEPALIVE_TIMEOUT_S must be at least the sweeper interval',
        path: ['NS_KEEPALIVE_TIMEOUT_S'],
      })
    }
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
  oidcIssuer?: string
  oidcClientId?: string
  oidcClientSecret?: string
  oidcScope: string
  publicUrl?: string
  sessionKey?: string
  sessionTtlS: number
  keepaliveIntervalMs: number
  keepaliveTimeoutS: number
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
    oidcIssuer: r.data.NS_OIDC_ISSUER,
    oidcClientId: r.data.NS_OIDC_CLIENT_ID,
    oidcClientSecret: r.data.NS_OIDC_CLIENT_SECRET,
    oidcScope: r.data.NS_OIDC_SCOPE,
    publicUrl: r.data.NS_PUBLIC_URL,
    sessionKey: r.data.NS_SESSION_KEY,
    sessionTtlS: r.data.NS_SESSION_TTL_S,
    keepaliveIntervalMs: r.data.NS_KEEPALIVE_INTERVAL_MS,
    keepaliveTimeoutS: r.data.NS_KEEPALIVE_TIMEOUT_S,
  }
}

/** The SINGLE enabled-truth (D-pp/D-qq): superRefine above guarantees the other
 * three members whenever issuer+clientId are set, so this guard is complete. */
export const oidcEnabled = (
  c: Config
): c is Config & {
  oidcIssuer: string
  oidcClientId: string
  publicUrl: string
  sessionKey: string
} => Boolean(c.oidcIssuer && c.oidcClientId && c.publicUrl && c.sessionKey)
