// src/cli/shim.test.ts — the D-bbb bin pin: the spawn path IS the dev/runtime story.
// NODE_OPTIONS=--conditions=development + the tsx loader resolve #root/cli/run through
// the package imports map (the start:dev precedent); the exit ladder must cross the
// PROCESS boundary, and the shim stays a five-line honest transport with no logic.
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const spawnShim = (argv: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ['--import', 'tsx', 'bin/nightshift.mjs', ...argv], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '--conditions=development', ...env },
  })

describe('bin shim (D-bbb)', () => {
  it('the shim stays honest: shebang, one #root import, exitCode wiring — no logic', () => {
    const src = readFileSync('bin/nightshift.mjs', 'utf8')
    expect(src.startsWith('#!/usr/bin/env node')).toBe(true)
    expect(src).toContain("from '#root/cli/run'")
    expect(src).toContain('process.exitCode = await runCli(')
    expect(src).toContain('fetch: globalThis.fetch') // the ONLY globalThis.fetch site (D-aaa)
  })
  it('--help exits 0 with the usage contract and NO env', () => {
    const r = spawnShim(['--help'])
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('nightshift next')
  })
  it('config and usage errors cross the process boundary with the pinned codes', () => {
    const cfg = spawnShim(['next'], { NS_URL: '', NS_TOKEN: 't' })
    expect(cfg.status).toBe(2)
    expect(cfg.stderr).toContain('nightshift: config_error')
    const usage = spawnShim(['wat'], { NS_URL: 'http://x.test', NS_TOKEN: 't' })
    expect(usage.status).toBe(2)
    expect(usage.stderr).toContain('nightshift: usage_error')
  })
})
