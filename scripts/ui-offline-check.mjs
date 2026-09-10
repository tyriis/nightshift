// D-vv: the built shell must reference NO external host — no CDN, no fonts, no
// phoning home. DevDeps stay in node_modules; this proves the ARTIFACT is honest.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = 'adapters/sveltekit/build'
const urls = new Set()
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (!/\.(br|gz)$/.test(name))
      for (const m of readFileSync(p, 'utf8').matchAll(/https?:\/\/[A-Za-z0-9.-]+/g)) urls.add(m[0])
  }
}
walk(root)
const allowed = new Set([
  'http://localhost',
  'https://localhost',
  'http://127.0.0.1',
  'https://127.0.0.1',
  // Inert identifier strings, never fetched: XML namespace IDs (favicon xmlns,
  // svelte's XHTML createElementNS constant) and svelte prod error/warning
  // messages that name a docs page as text. Any OTHER host still fails this gate.
  'http://www.w3.org',
  'https://svelte.dev',
])
const bad = [...urls].filter((u) => !allowed.has(u))
if (bad.length > 0) {
  console.error('external references in UI build:', bad)
  process.exit(1)
}
console.log(`ui build offline-safe; hosts seen: ${[...urls].join(' ') || '(none)'}`)
