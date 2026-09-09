// regeneration ⇄ committed artifact, byte-for-byte (D-kk)
import { execFile } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)

describe('nightshift-client drift pin (D-kk)', () => {
  it('committed schema.d.ts equals a fresh regen + prettier, byte-for-byte', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ns-client-drift-'))
    const tmp = join(dir, 'schema.d.ts')
    await run('pnpm', ['exec', 'openapi-typescript', 'openapi/openapi.yaml', '-o', tmp])
    // the temp file lives OUTSIDE the repo, so prettier's own config walk finds nothing —
    // point it at the repo config explicitly or the two sides format under different rules
    await run('pnpm', [
      'exec',
      'prettier',
      '--write',
      '--config',
      fileURLToPath(new URL('../../.prettierrc', import.meta.url)),
      tmp,
    ])
    const fresh = await readFile(tmp)
    const committed = await readFile(new URL('./schema.d.ts', import.meta.url))
    expect(fresh.equals(committed)).toBe(true)
  }, 120_000)
})
