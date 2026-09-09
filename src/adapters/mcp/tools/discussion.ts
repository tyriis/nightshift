// src/adapters/mcp/tools/discussion.ts — Task 4 seeds get_inbox; Task 6 completes — sync = shipped form
// (enum sets via the domain constants, body max 20000, update_question minProperties:1
// refine; see Task 6 Amendment)
import { z } from 'zod'
import { defineTool } from '#root/adapters/mcp/bridge'
import { resolveActorHandle } from '#root/adapters/shared/resolve-handle'
import { QUESTION_STATES, THREAD_KINDS } from '#root/domain/discussion'
import { DomainError } from '#root/domain/errors'

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

// Transcription duty (D-mm): input bounds mirror routes/threads.ts + routes/inbox.ts
// fastify schemas — body min1/max20000, assignee_handle min1/max60, kind/state are the
// domain enum sets (one source, no literal fork); zod STRIPS unknown keys (status quo).

export const listThreads = defineTool({
  name: 'list_threads',
  description: 'Task discussion as [{ thread, messages[] }] (mirrors GET /tasks/{id}/threads).',
  input: z.object({ task_id: z.string() }),
  run: async (deps, _ctx, { task_id }) => {
    const task = await deps.tasksRoot.findById(task_id)
    if (!task) throw new DomainError('not_found', `task ${task_id} not found`) // existence first — "no discussion" is not acceptable for a typo'd id
    return deps.threadsRoot.listForTask(task_id)
  },
})

export const createThread = defineTool({
  name: 'create_thread',
  description: 'Open a note or question thread (mirrors POST /tasks/{id}/threads).',
  input: z.object({
    task_id: z.string(),
    kind: z.enum(THREAD_KINDS),
    body: z.string().min(1).max(20000),
    assignee_handle: z.string().min(1).max(60).optional(),
    meta_note: z.boolean().optional(),
  }),
  // handle→id via the SHARED resolver — the REST route uses the same function (D-nn: no grammar fork)
  run: async (deps, ctx, { task_id, kind, body, assignee_handle, meta_note }) => {
    const assigneeId =
      assignee_handle === undefined ? undefined : await resolveActorHandle(deps, assignee_handle)
    return deps.useCases.createThread.run({
      taskId: task_id,
      kind,
      body,
      assignee_id: assigneeId,
      metaNote: meta_note,
      ...ctx,
    })
  },
})

export const addMessage = defineTool({
  name: 'add_message',
  description: 'Append a message to a thread (mirrors POST /tasks/{id}/threads/{tid}/messages).',
  input: z.object({ thread_id: z.string(), body: z.string().min(1).max(20000) }),
  run: async (deps, ctx, { thread_id, body }) =>
    deps.useCases.addMessage.run({ threadId: thread_id, body, ...ctx }),
})

export const answerQuestion = defineTool({
  name: 'answer_question',
  description:
    'Answer a question thread atomically (mirrors POST /tasks/{id}/threads/{tid}/answer).',
  input: z.object({ thread_id: z.string(), body: z.string().min(1).max(20000) }),
  run: async (deps, ctx, { thread_id, body }) =>
    deps.useCases.answerQuestion.run({ threadId: thread_id, body, ...ctx }),
})

export const updateQuestion = defineTool({
  name: 'update_question',
  description: 'Transition / reassign a question (mirrors PATCH /tasks/{id}/threads/{tid}).',
  input: z
    .object({
      thread_id: z.string(),
      state: z.enum(QUESTION_STATES).optional(),
      assignee_handle: z.string().min(1).max(60).optional(),
    })
    // REST body minProperties: 1 (routes/threads.ts:109) — an empty patch is a
    // rejection there, never a silent no-op here (Task 5 refine precedent)
    .refine((a) => a.state !== undefined || a.assignee_handle !== undefined, {
      message: 'requires state or assignee_handle',
    }),
  run: async (deps, ctx, { thread_id, state, assignee_handle }) => {
    const assigneeId =
      assignee_handle === undefined ? undefined : await resolveActorHandle(deps, assignee_handle)
    return deps.useCases.updateQuestion.run({
      threadId: thread_id,
      state,
      assignee_id: assigneeId,
      ...ctx,
    })
  },
})

export const markInboxRead = defineTool({
  name: 'mark_inbox_read',
  description: 'Mark one inbox item read (mirrors POST /inbox/{id}/read; owner-only 404 doctrine).',
  input: z.object({ item_id: z.string() }),
  run: async (deps, ctx, { item_id }) => {
    await deps.useCases.markInboxRead.run({ itemId: item_id, ...ctx })
  },
})

export const DISCUSSION_TOOLS = [
  getInbox,
  listThreads,
  createThread,
  addMessage,
  answerQuestion,
  updateQuestion,
  markInboxRead,
]
