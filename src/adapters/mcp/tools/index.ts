// src/adapters/mcp/tools/index.ts — the frozen surface, grown Tasks 4–8
import type { McpTool } from '#root/adapters/mcp/bridge'
import { COMPOSITE_TOOLS } from '#root/adapters/mcp/tools/composites'
import { DISCUSSION_TOOLS } from '#root/adapters/mcp/tools/discussion'
import { REFERENCE_TOOLS } from '#root/adapters/mcp/tools/references'
import { TASK_TOOLS } from '#root/adapters/mcp/tools/tasks'

export const mcpTools: McpTool[] = [
  ...TASK_TOOLS,
  ...DISCUSSION_TOOLS,
  ...REFERENCE_TOOLS,
  ...COMPOSITE_TOOLS,
]
