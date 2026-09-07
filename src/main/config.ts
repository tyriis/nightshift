import { z } from 'zod'

const EnvSchema = z.object({
  NS_PORT: z.coerce.number().int().min(1024).max(65535).default(3123),
  NS_DB_PATH: z.string().min(1).default('./nightshift.db'),
  NS_BOOTSTRAP_TOKEN: z.string().min(32).optional(),
})

export interface Config {
  port: number
  dbPath: string
  bootstrapToken?: string
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
  }
}
