import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineTool, McpEnvelopeError, okResult, runTool } from '#root/adapters/mcp/bridge'
import { buildMcpServer } from '#root/adapters/mcp/server'
import { InMemoryTransport } from '@modelcontextprotocol/client'
import { Client } from '@modelcontextprotocol/client'
import { DomainError } from '#root/domain/errors'
import type { ActorContext } from '#root/application/ports'
import type { AppDeps } from '#root/main/deps'

const ctx: ActorContext = {
  actor: { id: 'actor_fake', kind: 'human', handle: 'a_fake', display_name: 'Fake' },
  tokenId: null,
}
const deps = {} as AppDeps // the fixtures below never touch deps

const echo = defineTool({
  name: 'echo',
  description: 'echo',
  input: z.object({ msg: z.string() }),
  run: async (_d, _c, { msg }) => ({ msg }),
})

describe('mcp envelope bridge (D-jj)', () => {
  it('success envelope: { result } mirrored into text', async () => {
    const r = await runTool(echo, deps, ctx, { msg: 'hi' })
    expect(r.isError).toBeUndefined()
    expect(r.structuredContent).toEqual({ result: { msg: 'hi' } })
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({ result: { msg: 'hi' } })
  })

  it('void result normalizes to { result: null } (the 204 analog)', async () => {
    const voidTool = defineTool({
      name: 'v',
      description: 'v',
      input: z.object({}),
      run: async () => undefined,
    })
    expect((await runTool(voidTool, deps, ctx, {})).structuredContent).toEqual({ result: null })
  })

  it('DomainError lands FLAT: code, status, details at top level', async () => {
    const boom = defineTool({
      name: 'b',
      description: 'b',
      input: z.object({}),
      run: async () => {
        throw new DomainError('already_claimed', 'claimed', {
          holder_handle: 'a_x',
          claimed: false,
        })
      },
    })
    const r = await runTool(boom, deps, ctx, {})
    expect(r.isError).toBe(true)
    expect(r.structuredContent).toEqual({
      code: 'already_claimed',
      status: 409,
      holder_handle: 'a_x',
      claimed: false,
    })
  })

  it('unknown throw → internal_error 500, no stack leak (mirrors problem.ts)', async () => {
    const boom = defineTool({
      name: 'u',
      description: 'u',
      input: z.object({}),
      run: async () => {
        throw new Error('inner detail that must not surface')
      },
    })
    const r = await runTool(boom, deps, ctx, {})
    expect(r.isError).toBe(true)
    expect(r.structuredContent).toEqual({ code: 'internal_error', status: 500 })
    expect(JSON.stringify(r)).not.toContain('inner detail')
  })

  it('McpEnvelopeError rides the shared adapter vocabulary (413, D-jj)', async () => {
    const big = defineTool({
      name: 'x',
      description: 'x',
      input: z.object({}),
      run: async () => {
        throw new McpEnvelopeError({ code: 'payload_too_large', status: 413 })
      },
    })
    expect((await runTool(big, deps, ctx, {})).structuredContent).toEqual({
      code: 'payload_too_large',
      status: 413,
    })
  })
})

describe('buildMcpServer over the in-memory pair', () => {
  it('lists and calls registered tools; input validation and unknown tools stay SDK-shaped', async () => {
    const server = buildMcpServer(deps, ctx, [echo])
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-harness', version: '1.0.0' })
    await Promise.all([client.connect(clientEnd), server.connect(serverEnd)])
    try {
      const listed = await client.listTools()
      expect(listed.tools.map((t) => t.name)).toEqual(['echo'])
      const ok = await client.callTool({ name: 'echo', arguments: { msg: 'hey' } })
      expect(ok.structuredContent).toEqual({ result: { msg: 'hey' } })
      const badArgs = await client.callTool({ name: 'echo', arguments: { msg: 42 } })
      expect(badArgs.isError).toBe(true) // SDK input-validation shape — declared scope (D-jj)
      // SDK v2 answers an unknown tool with a JSON-RPC REJECTION (ProtocolError),
      // not isError:true — the "rejected ⇄ rejected" SDK-level scope of D-jj.
      await expect(client.callTool({ name: 'nope', arguments: {} })).rejects.toThrow(/nope/)
    } finally {
      await client.close()
    }
  })
})
