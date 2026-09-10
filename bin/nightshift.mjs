#!/usr/bin/env node
// nightshift CLI shim (D-bbb): five honest lines — the repo-bin resolves #root/cli/run
// through the package imports map: dist/ after `pnpm build` (the image ships this form),
// src/ under --conditions=development (the `pnpm cli` dev path — shim.test.ts spawns it).
import { runCli } from '#root/cli/run'

process.exitCode = await runCli({
  argv: process.argv.slice(2),
  env: process.env,
  stdout: (line) => void process.stdout.write(line + '\n'),
  stderr: (line) => void process.stderr.write(line + '\n'),
  fetch: globalThis.fetch,
})
