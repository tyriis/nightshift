import type { CallToolResult } from '@modelcontextprotocol/server'
import type { z } from 'zod'
import type { ActorContext } from '#root/application/ports'
import { isDomainError } from '#root/domain/errors'
import type { AppDeps } from '#root/main/deps'

// A tool is a pure function of (deps, ActorContext): the exact REST twin's call
// sequence, transcribed (D-mm). `args: never` makes the erased registry list
// contravariant-safe; the ONLY legal caller is runTool, immediately after zod
// validation at the registration edge in server.ts.
export interface McpTool {
  name: string
  description: string
  input: z.ZodType
  run: (deps: AppDeps, ctx: ActorContext, args: never) => Promise<unknown>
}

export interface ToolDef<S extends z.ZodType> {
  name: string
  description: string
  input: S
  run: (deps: AppDeps, ctx: ActorContext, args: z.infer<S>) => Promise<unknown>
}

// Registry-edge erasure; run() stays schema-bound by construction.
export const defineTool = <S extends z.ZodType>(def: ToolDef<S>): McpTool =>
  def as unknown as McpTool

// Non-DomainError MCP-surface rejection sharing the REST ADAPTER code vocabulary
// (only payload_too_large is reachable — D-jj/D-mm). Domain conditions always
// throw DomainError, exactly like the REST twins.
export class McpEnvelopeError extends Error {
  constructor(readonly envelope: Record<string, unknown>) {
    // string-typed by the ADAPTER vocabulary (every code is a string literal);
    // non-string degrades to internal_error, mirroring the ?? fallback intent
    super(typeof envelope.code === 'string' ? envelope.code : 'internal_error')
  }
}

export const okResult = (payload: unknown): CallToolResult => {
  const body = { result: payload ?? null }
  return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body }
}

export const errorResult = (envelope: Record<string, unknown>): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify(envelope) }],
  structuredContent: envelope,
})

export const runTool = async (
  tool: McpTool,
  deps: AppDeps,
  ctx: ActorContext,
  args: unknown
): Promise<CallToolResult> => {
  try {
    return okResult(await tool.run(deps, ctx, args as never))
  } catch (error) {
    if (isDomainError(error)) {
      return errorResult({ code: error.code, status: error.status, ...(error.details ?? {}) })
    }
    if (error instanceof McpEnvelopeError) return errorResult(error.envelope)
    return errorResult({ code: 'internal_error', status: 500 })
  }
}
