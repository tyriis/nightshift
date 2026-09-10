// src/cli/run.ts — the nightshift CLI core (D-aaa): argv+env+io+fetch in, exit code out.
// Zero new runtime deps (zod + the D-kk client, both already shipped); ZERO server-contract
// change — every arm rides EXISTING documented ops (Task 8's zero-churn list is the proof).
// stderr line 1 is the machine string `nightshift: <token>`; the exit ladder is pinned and
// grep-stable (spec §11 — agents branch on the code, never parse prose):
//   0 ok · 1 transport_error · 2 usage_error/config_error (NOTHING sent) · 3 API problem
// (the server's taxonomy code verbatim; the flat D-jj problem JSON rides on line 2).
import { z } from 'zod'
import { createNightshiftClient } from '#root/client/index'

export interface CliIo {
  argv: readonly string[]
  env: NodeJS.ProcessEnv
  stdout: (line: string) => void
  stderr: (line: string) => void
  // REQUIRED (D-aaa): runCli never reads globalThis.fetch — the caller injects it
  // (the bin shim passes the platform; the tests inject the zero-socket harness).
  fetch: typeof globalThis.fetch
}

const EnvSchema = z.object({
  NS_URL: z.url(),
  NS_TOKEN: z.string().min(1),
  NS_TIMEOUT_MS: z.coerce.number().int().min(100).default(15_000), // per-call AbortSignal
})

// the command surface, one exact set (D-aaa): COMMANDS keys and the dispatch chain ship in
// lockstep — claim (Task 2) and report (Task 3) join BOTH, never one alone
const COMMANDS: Record<string, readonly string[]> = {
  next: ['label', 'limit'],
  claim: [],
}

const LimitSchema = z.coerce.number().int().min(1).max(100) // mirrors the yaml /tasks/next pin

const USAGE = [
  'usage: nightshift next [--label L] [--limit N] | claim <task-id> | report <task-id> [--message M] [--status S --reason R]',
  'env: NS_URL + NS_TOKEN required · NS_LEASE_TOKEN for --status · NS_TIMEOUT_MS default 15000 (secrets via env, never argv — D-ff)',
  'exit: 0 ok · 1 transport_error · 2 usage/config (nothing sent) · 3 API problem (`nightshift: <code>` on stderr)',
]

interface ParsedArgs {
  positionals: string[]
  flags: Record<string, string>
}

// ParsedArgs or a one-line usage reason (string): a trailing `--flag` or `--flag --other`
// is a MISSING value, never a value starting with --.
const parseArgs = (args: readonly string[]): ParsedArgs | string => {
  const positionals: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('--')) {
      positionals.push(a)
      continue
    }
    const value = args[i + 1]
    if (value === undefined || value.startsWith('--')) return `flag ${a} needs a value`
    flags[a.slice(2)] = value
    i++
  }
  return { positionals, flags }
}

// the D-jj door: a problem with a string code → exit 3 + the flat envelope verbatim;
// anything else (garbage body, empty 2xx) is a transport failure against the contract
// → exit 1 (D-aaa). null = data present, the caller proceeds.
const failFrom = (io: CliIo, r: { data?: unknown; error?: unknown }): number | null => {
  if (r.data !== undefined) return null
  const err = r.error as { code?: unknown } | undefined
  if (typeof err?.code === 'string') {
    io.stderr(`nightshift: ${err.code}`)
    io.stderr(JSON.stringify(err))
    return 3
  }
  io.stderr('nightshift: transport_error')
  io.stderr(
    typeof err === 'string'
      ? err
      : JSON.stringify(err ?? 'empty response — no data, no problem body')
  )
  return 1
}

export const runCli = async (io: CliIo): Promise<number> => {
  const usageError = (why: string): number => {
    io.stderr(`nightshift: usage_error ${why}`)
    USAGE.forEach((line) => io.stderr(line))
    return 2
  }
  const [cmd = '', ...rest] = io.argv
  if (cmd === 'help' || cmd === '--help') {
    USAGE.forEach((line) => io.stderr(line))
    return 0
  }
  if (!Object.hasOwn(COMMANDS, cmd)) return usageError(`unknown command '${cmd}'`)
  const parsed = parseArgs(rest)
  if (typeof parsed === 'string') return usageError(parsed)
  for (const key of Object.keys(parsed.flags)) {
    if (!COMMANDS[cmd].includes(key)) return usageError(`unknown flag --${key} for '${cmd}'`)
  }
  const idWanted = cmd === 'claim'
  if (parsed.positionals.length !== (idWanted ? 1 : 0)) {
    return usageError(
      idWanted ? `'${cmd}' takes exactly one <task-id>` : `'${cmd}' takes no positional arguments`
    )
  }
  const env = EnvSchema.safeParse(io.env)
  if (!env.success) {
    io.stderr(
      'nightshift: config_error check NS_URL / NS_TOKEN / NS_TIMEOUT_MS (values never echoed)'
    )
    io.stderr(JSON.stringify(z.treeifyError(env.error)))
    return 2
  }
  let limit: number | undefined
  if (parsed.flags.limit !== undefined) {
    const r = LimitSchema.safeParse(parsed.flags.limit)
    if (!r.success) {
      io.stderr('nightshift: config_error --limit must be an integer 1..100 (the server pin)')
      return 2
    }
    limit = r.data
  }
  const label = parsed.flags.label
  const client = createNightshiftClient({
    baseUrl: env.data.NS_URL,
    token: env.data.NS_TOKEN,
    fetch: (input, init) =>
      io.fetch(input, { ...init, signal: AbortSignal.timeout(env.data.NS_TIMEOUT_MS) }),
  })
  try {
    if (cmd === 'next') {
      // Task 1 ships the single command directly (COMMANDS === {next}); Task 2 grows the
      // dispatch chain with claim, Task 3 with report — exact set, lockstep.
      const r = await client.GET('/tasks/next', {
        params: {
          query: {
            ...(label === undefined ? {} : { label }),
            ...(limit === undefined ? {} : { limit }),
          },
        },
      })
      const f = failFrom(io, r)
      if (f !== null) return f
      // server DTO pass-through as JSONL (D-aaa) — the CLI never reshapes the contract.
      // Trust-cast (B5/P10): failFrom PROVED data present — a `?? []` right-arm would be
      // statically uncoverable and the never-lower bar forbids it.
      for (const task of r.data as unknown[]) io.stdout(JSON.stringify(task))
      return 0
    }
    const id = parsed.positionals[0] // arity gate proved it
    const claim = await client.POST('/tasks/{id}/claim', { params: { path: { id } } })
    const f = failFrom(io, claim)
    if (f !== null) return f
    // trust-cast (D-aaa): failFrom proved data present
    const d = claim.data as { lease_token?: string; generation?: number }
    io.stdout(JSON.stringify({ task_id: id, lease_token: d.lease_token, generation: d.generation }))
    return 0
  } catch (err) {
    io.stderr('nightshift: transport_error')
    io.stderr(err instanceof Error ? `${err.name}: ${err.message}` : String(err))
    return 1
  }
}
