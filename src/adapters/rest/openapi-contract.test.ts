import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import type { FastifyInstance } from 'fastify'
import { makeTestApp } from '#root/testing/test-app'
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
// leaf with no path segment; method-varying constraints print as extra data lines; a
// find-my-way format change shifts every other shape. This app registers neither — if
// that ever changes, teach the grammar before trusting the diff.
const ROUTE_LINE = /^((?:│ {3}| {4})*)(?:├── |└── )(\/\S*) \(([^)]+)\)$/

const routeKeys = (app: FastifyInstance): string[] => {
  const keys = new Set<string>()
  const stack: string[] = []
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const match = ROUTE_LINE.exec(line)
    if (!match) {
      // fail LOUD, never silent: any tree-shaped line the regex cannot parse means the
      // grammar missed a class (wildcard leaf, constraint data line, format drift).
      if (line.includes('── ')) {
        throw new Error(
          `routeKeys: unparseable route-tree line ${JSON.stringify(line)} — ROUTE_LINE covers only ` +
            'plain "/segment (METHOD)" leaves; wildcards (── *), method constraints, or a ' +
            'find-my-way format change land here — teach the grammar before trusting the diff'
        )
      }
      continue
    }
    stack.length = match[1].length / 4
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
    const served = routeKeys(t.app)
    const documented = specKeys(spec)
    await t.close()

    expect(documented).toEqual(served)
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
    // Live capture (find-my-way 9.9.0): registering GET /wildcard-probe/* prints a bare
    // wildcard leaf with no path segment — the silent skip this replaced read as false
    // GREEN (reviewer exp-15). Stubbing printRoutes is the pin's injection point: fastify
    // refuses route registration after boot, so the wildcard shape stays out of the app.
    const tree = '├── /tasks (POST, GET, HEAD)\n└── * (GET, HEAD)\n'
    const app = { printRoutes: () => tree } as unknown as FastifyInstance
    expect(() => routeKeys(app)).toThrow('── * (GET, HEAD)')
  })
})
