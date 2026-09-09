import { McpServer } from '@modelcontextprotocol/server'
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import type { ActorContext } from '#root/application/ports'
import { runTool } from '#root/adapters/mcp/bridge'
import type { McpTool } from '#root/adapters/mcp/bridge'
import type { AppDeps } from '#root/main/deps'

// The ONLY place an MCP server is constructed (D-hh: fresh McpServer per request,
// identity closed over by the mount). NO outputSchema anywhere (D-jj).
export const buildMcpServer = (deps: AppDeps, ctx: ActorContext, tools: McpTool[]): McpServer => {
  const server = new McpServer(
    { name: 'nightshift-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  )
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      // Cast at the erased registry edge: satisfies the StandardSchemaWithJSON
      // generic (SDK v2 registerTool infers cb: never from an `as never` schema);
      // the runtime schema is the real zod object (probe-verified).
      {
        description: tool.description,
        inputSchema: tool.input as unknown as StandardSchemaWithJSON,
      },
      (args) => runTool(tool, deps, ctx, args)
    )
  }
  return server
}
