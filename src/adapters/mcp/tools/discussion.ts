// src/adapters/mcp/tools/discussion.ts — Task 4 seeds get_inbox; Task 6 completes
import { z } from 'zod'
import { defineTool } from '#root/adapters/mcp/bridge'

export const getInbox = defineTool({
  name: 'get_inbox',
  description: 'The acting actor inbox, newest first (mirrors GET /inbox).',
  input: z.object({
    unread_only: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  // handler-side default 50 lives HERE because the REST handler owns it (D-mm)
  run: async (deps, ctx, q) =>
    deps.inboxRoot.listForActor(ctx.actor.id, {
      unreadOnly: q.unread_only ?? false,
      limit: q.limit ?? 50,
    }),
})

export const DISCUSSION_TOOLS = [getInbox]
