// src/adapters/mcp/tools/index.ts — the frozen surface, grown Tasks 4–8
import type { McpTool } from '#root/adapters/mcp/bridge'
import { DISCUSSION_TOOLS } from '#root/adapters/mcp/tools/discussion'
import { TASK_TOOLS } from '#root/adapters/mcp/tools/tasks'

export const mcpTools: McpTool[] = [...TASK_TOOLS, ...DISCUSSION_TOOLS]
