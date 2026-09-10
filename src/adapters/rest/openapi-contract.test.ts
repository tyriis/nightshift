import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import type { FastifyInstance } from 'fastify'
import { makeTestApp } from '#root/testing/test-app'
import { uiBuildPresent } from '#root/adapters/rest/ui'
import { DOMAIN_ERROR_STATUS } from '#root/domain/errors'
import { ADAPTER_ERROR_CODES } from '#root/adapters/rest/problem'
import { TASK_STATUSES } from '#root/domain/task'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

interface SpecPathItem {
  [method: string]: unknown
}

const specKeys = (spec: { paths: Record<string, SpecPathItem> }): string[] => {
  const keys: string[] = []
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      if (item[method.toLowerCase()]) keys.push(`${method} ${path}`)
    }
  }
  return keys.sort()
}

// The plan block walked printRoutes({ output: 'json' }) — fastify 5.12.3 ships
// find-my-way 9.9.0, which has no JSON output: the option is ignored (return stays a
// string, 'tree' is undefined) and the fastify types reject the key outright. Repaired
// to parse the pretty tree, the only supported output. Format facts (lib/pretty-print.js):
// nesting is 4 chars per level ('│   ' or '    '); with commonPrefix:false every leaf
// line prints a leading-slash segment, so the indent stack reconstructs the full path.
// Lines shaped like tree nodes but outside this grammar all fail LOUD, never drop
// silently: a wildcard route prints (commonPrefix:false) as a bare `── * (GET, HEAD)`
// leaf with NO path segment in ANY printRoutes mode — the /ui static mount (D-vv)
// prints exactly that, so the grammar LEARNS the leaf as a sentinel (`GET *`) and the
// /ui/* spelling is pinned via hasRoute below. Method-varying constraints still print
// as extra data lines — this app registers none; if a find-my-way format change ever
// shifts the other shapes, they land in the loud fail, never in a silent skip.
const ROUTE_LINE = /^((?:│ {3}| {4})*)(?:├── |└── )(\/\S*|\*) \(([^)]+)\)$/

const routeKeys = (app: FastifyInstance): string[] => {
  const keys = new Set<string>()
  const stack: string[] = []
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const match = ROUTE_LINE.exec(line)
    if (!match) {
      // fail LOUD, never silent: any tree-shaped line the regex cannot parse means the
      // grammar missed a class (constraint data line, format drift — the wildcard leaf
      // itself is grammar since D-vv and lands in the sentinel arm below).
      if (line.includes('── ')) {
        throw new Error(
          `routeKeys: unparseable route-tree line ${JSON.stringify(line)} — ROUTE_LINE covers only ` +
            'plain "/segment (METHOD)" leaves and the bare wildcard leaf (── *); method constraints ' +
            'or a find-my-way format change land here — teach the grammar before trusting the diff'
        )
      }
      continue
    }
    stack.length = match[1].length / 4
    if (match[2] === '*') {
      // wildcard leaf (the /ui static mount): pretty-print carries NO path for wildcards,
      // so the key is the SENTINEL `GET *`; the '/ui/*' spelling is pinned by hasRoute.
      for (const method of match[3].split(', ')) {
        if (method === 'HEAD') continue
        keys.add(`${method} *`)
      }
      continue
    }
    stack.push(match[2])
    for (const method of match[3].split(', ')) {
      // fastify answers HEAD wherever GET is registered; the contract documents GET
      if (method === 'HEAD') continue
      keys.add(`${method} ${stack.join('').replace(/:([^/]+)/g, '{$1}')}`)
    }
  }
  return [...keys].sort()
}

describe('OpenAPI contract (spec §7.1: committed spec = product contract)', () => {
  it('serves the spec at /openapi.yaml', async () => {
    const t = await makeTestApp()
    const res = await t.app.inject({ method: 'GET', url: '/openapi.yaml' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/yaml')
    await t.close()
  })

  it('no drift: every documented path+method is served, every served route is documented', async () => {
    const spec = parse(await readFile('openapi/openapi.yaml', 'utf8')) as {
      openapi: string
      paths: Record<string, SpecPathItem>
    }
    expect(spec.openapi).toBe('3.1.0')

    const t = await makeTestApp()
    // ready() before printRoutes: /mcp registers inside an encapsulated scope
    // (mount.ts) and plugin routes only enter the router tree at boot
    await t.app.ready()
    const served = routeKeys(t.app)
    // hasRoute captures MUST sit before t.close() (fastify refuses router access
    // after close): the /ui/* SPELLING the sentinel cannot carry
    const hasUiGet = t.app.hasRoute({ method: 'GET', url: '/ui/*' })
    const hasUiPost = t.app.hasRoute({ method: 'POST', url: '/ui/*' })
    const documented = specKeys(spec)
    await t.close()

    // /mcp is the JSON-RPC transport mount — the yaml cannot describe MCP (D-ll).
    // The exemption is an EXACT set: a fourth /mcp verb, or any non-/mcp route
    // hidden here, fails the pin. The MCP surface is pinned by the tools-list
    // snapshot + the §11.4 parity harness instead.
    const MCP_ROUTES = ['DELETE /mcp', 'GET /mcp', 'POST /mcp']
    const mcpPresent = served.filter((key) => key.endsWith(' /mcp')).sort()
    expect(mcpPresent).toEqual(MCP_ROUTES)
    expect(documented.some((key) => key.includes('/mcp'))).toBe(false)

    // D-vv exact-set #2 — the yaml cannot describe a built asset tree. The static
    // mount prints as the BARE wildcard leaf (no path in ANY printRoutes mode), so
    // routeKeys classifies it as the sentinel `GET *`; a second wildcard registration
    // duplicates the sentinel and fails this pin, and the hasRoute pair pins the
    // '/ui/*' spelling + the absence of any POST sibling. Both faces honest: with a
    // build the sentinel is served; without one the STATIC set is EMPTY (zero-member
    // pin) — uiBuildPresent() is the SAME helper ui.ts uses, so test and mount share
    // one tree-truth.
    const STATIC_KEYS = ['GET *'] // sentinel — the /ui/* spelling is pinned by hasRoute
    const staticPresent = served.filter((key) => key.endsWith(' *')).sort()
    expect(staticPresent).toEqual(uiBuildPresent() ? STATIC_KEYS : [])
    expect(hasUiGet).toBe(uiBuildPresent())
    expect(hasUiPost).toBe(false)
    expect(documented.some((key) => key.includes('/ui'))).toBe(false)
    expect(
      served.filter((key) => !mcpPresent.includes(key) && !staticPresent.includes(key))
    ).toEqual(documented)
  })

  it('pins schema enums to the domain single sources (no stale-enum drift)', async () => {
    // Derived from the domain single source, never re-listed: a new TASK_STATUSES or DomainErrorCode
    // member joins the expected set the moment it lands in the domain and stays RED until the yaml
    // enum catches up — the mechanism closing the false-GREEN class one layer below path×method.
    // internal_error rides in ADAPTER_ERROR_CODES with the other transport codes (D-u).
    const spec = parse(await readFile('openapi/openapi.yaml', 'utf8')) as {
      components: {
        schemas: {
          TaskStatus: { enum: string[] }
          Problem: { properties: { code: { enum: string[] } } }
        }
      }
    }
    // statuses: order-sensitive exact; codes: sorted for set equality — exact, no superset tolerance
    expect(spec.components.schemas.TaskStatus.enum).toEqual([...TASK_STATUSES])
    // domain ∪ adapter (D-u): transport codes join the same pinned vocabulary
    const expectedCodes = Object.keys(DOMAIN_ERROR_STATUS)
      .concat(Object.keys(ADAPTER_ERROR_CODES))
      .sort()
    expect(spec.components.schemas.Problem.properties.code.enum.sort()).toEqual(expectedCodes)
  })

  it('routeKeys fails loudly on tree shapes outside the grammar', () => {
    // RE-PINNED in the SAME edit that taught the grammar the wildcard leaf (D-vv,
    // preflight P7/fix12): the old wildcard-as-junk fixture IS grammar now — it
    // parses to the sentinel plus the plain leaves — so the loud-fail class keeps a
    // GENUINELY out-of-shape line (the junk leaf must still throw). The bite stays.
    const wildcard = '├── /tasks (POST, GET, HEAD)\n└── * (GET, HEAD)\n'
    expect(routeKeys({ printRoutes: () => wildcard } as unknown as FastifyInstance)).toEqual([
      'GET *',
      'GET /tasks',
      'POST /tasks',
    ])
    const junk = '├── /tasks (POST, GET, HEAD)\n└── ???junk (GET)\n'
    expect(() => routeKeys({ printRoutes: () => junk } as unknown as FastifyInstance)).toThrow(
      '── ???junk (GET)'
    )
  })
})
