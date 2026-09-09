import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import type { CallToolResult, ListToolsResult } from '@modelcontextprotocol/client'
import { buildMcpServer } from '#root/adapters/mcp/server'
import type { McpTool } from '#root/adapters/mcp/bridge'
import type { ActorContext } from '#root/application/ports'
import type { AppDeps } from '#root/main/deps'
import { hashToken } from '#root/infra/token-hash'
// ^ `rg "export const hashToken" src/` — the function's ACTUAL home module (D-jj
// discovery pin; the plan block guessed application/token-hash — amended).

// Shared handle of both open helpers (explicit by lint: exported arrows need
// return types; declaration emit requires the name exported).
export interface McpHarness {
  call(tool: string, args?: Record<string, unknown>): Promise<CallToolResult>
  list(): Promise<ListToolsResult>
  close(): Promise<void>
}

export const actorContextFor = async (deps: AppDeps, rawToken: string): Promise<ActorContext> => {
  const lookup = await deps.actorsRoot.findActiveTokenByHash(hashToken(rawToken))
  if (!lookup) throw new Error('test harness: unknown token')
  return { actor: lookup.actor, tokenId: lookup.token.id }
}

export const openInMemoryPair = async (
  deps: AppDeps,
  ctx: ActorContext,
  tools: McpTool[]
): Promise<McpHarness> => {
  const server = buildMcpServer(deps, ctx, tools)
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-harness', version: '1.0.0' })
  await Promise.all([client.connect(clientEnd), server.connect(serverEnd)])
  return {
    call: (tool: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name: tool, arguments: args }),
    list: () => client.listTools(),
    close: () => client.close(),
  }
}

// pin='2026-07-28' forces the modern era; pin=undefined keeps the default legacy handshake.
export const openHttpMcp = async (
  baseUrl: string,
  bearer: string,
  pin?: '2026-07-28'
): Promise<McpHarness> => {
  const client = new Client(
    { name: 'test-harness', version: '1.0.0' },
    pin === undefined ? undefined : { versionNegotiation: { mode: { pin } } }
  )
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
    })
  )
  return {
    call: (tool: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name: tool, arguments: args }),
    list: () => client.listTools(),
    close: () => client.close(),
  }
}
