import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import type { FastifyInstance } from 'fastify'
import { makeTestApp } from '#root/testing/test-app'

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
// A node whose methods differ in constraints serializes them as extra indented data
// lines the regex below would silently drop — this app registers no route constraints;
// if that ever changes, teach routeKeys to fold them before trusting the diff.
const ROUTE_LINE = /^((?:│ {3}| {4})*)(?:├── |└── )(\/\S*) \(([^)]+)\)$/

const routeKeys = (app: FastifyInstance): string[] => {
  const keys = new Set<string>()
  const stack: string[] = []
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const match = ROUTE_LINE.exec(line)
    if (!match) continue
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
})
