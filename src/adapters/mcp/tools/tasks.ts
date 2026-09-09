// src/adapters/mcp/tools/tasks.ts — Task 4 seeds; Task 5 completes the family
import { z } from 'zod'
import { defineTool } from '#root/adapters/mcp/bridge'
import { toTaskDto } from '#root/adapters/rest/dto'
import { DomainError } from '#root/domain/errors'
import { TASK_STATUSES } from '#root/domain/task'
import type { AppDeps } from '#root/main/deps'
import type { ActorContext } from '#root/application/ports'

export const getTask = defineTool({
  name: 'get_task',
  description: 'Fetch one task as public JSON (mirrors GET /tasks/{id}).',
  input: z.object({ task_id: z.string() }),
  run: async (deps: AppDeps, _ctx: ActorContext, { task_id }) => {
    const row = await deps.tasksRoot.findWithCounts(task_id)
    if (!row) throw new DomainError('not_found', `task ${task_id} not found`) // ghost-404 verbatim
    return toTaskDto(row)
  },
})

export const listTasks = defineTool({
  name: 'list_tasks',
  description: 'All tasks as public JSON, position-ordered (mirrors GET /tasks).',
  input: z.object({}),
  run: async (deps) => (await deps.tasksRoot.listAllWithCounts()).map(toTaskDto),
})

// Transcription duty (D-mm): input bounds mirror routes/tasks.ts fastify schemas —
// title min1/max300, labels items minLength 1, status enum, reason minLength 1,
// limit integer 1..100; zod STRIPS unknown keys (removeAdditional status quo).

export const createTask = defineTool({
  name: 'create_task',
  description: 'Create a task (mirrors POST /tasks; re-fetched TaskDto).',
  input: z.object({
    title: z.string().min(1).max(300),
    description: z.string().optional(),
    acceptance_criteria: z.string().optional(),
    parent_id: z.string().optional(),
    status: z.enum(TASK_STATUSES).optional(),
    labels: z.array(z.string().min(1)).optional(),
  }),
  run: async (deps, ctx, body) => {
    const task = await deps.useCases.createTask.run({ ...body, ...ctx })
    return toTaskDto((await deps.tasksRoot.findWithCounts(task.id))!) // REST re-fetch site
  },
})

export const updateTask = defineTool({
  name: 'update_task',
  description: 'Patch task fields (mirrors PATCH /tasks/{id}; uc return discarded per REST).',
  input: z.object({
    task_id: z.string(),
    patch: z
      .object({
        title: z.string().min(1).max(300).optional(),
        description: z.string().optional(),
        acceptance_criteria: z.string().optional(),
        assignee_id: z.string().nullable().optional(),
        blocked_flag: z.boolean().optional(),
      })
      .refine((p) => Object.keys(p).length > 0, 'patch requires at least one property'), // minProperties: 1
  }),
  run: async (deps, ctx, { task_id, patch }) => {
    await deps.useCases.updateTask.run({ taskId: task_id, patch, ...ctx })
    return toTaskDto((await deps.tasksRoot.findWithCounts(task_id))!)
  },
})

export const updateTaskStatus = defineTool({
  name: 'update_task_status',
  description: 'Move a task along the board (mirrors PATCH /tasks/{id}/status).',
  input: z.object({
    task_id: z.string(),
    to: z.enum(TASK_STATUSES),
    reason: z.string().min(1),
    lease_token: z.string().optional(),
  }),
  run: async (deps, ctx, { task_id, to, reason, lease_token }) => {
    const task = await deps.useCases.updateStatus.run({
      taskId: task_id,
      to,
      reason,
      lease_token,
      ...ctx,
    })
    return toTaskDto((await deps.tasksRoot.findWithCounts(task.id))!)
  },
})

export const claimTask = defineTool({
  name: 'claim_task',
  description:
    'Atomically claim a ready task, receiving its lease (mirrors POST /tasks/{id}/claim).',
  input: z.object({ task_id: z.string() }),
  run: async (deps, ctx, { task_id }) => deps.useCases.claimTask.run({ taskId: task_id, ...ctx }),
})

export const releaseTask = defineTool({
  name: 'release_task',
  description: 'Release your claim (mirrors POST /tasks/{id}/release).',
  input: z.object({ task_id: z.string() }),
  run: async (deps, ctx, { task_id }) => {
    const task = await deps.useCases.releaseClaim.run({ taskId: task_id, ...ctx })
    return toTaskDto((await deps.tasksRoot.findWithCounts(task.id))!)
  },
})

export const heartbeatTask = defineTool({
  name: 'heartbeat_task',
  description: 'Refresh a claim lease (mirrors POST /tasks/{id}/heartbeat).',
  input: z.object({ task_id: z.string(), lease_token: z.string() }),
  run: async (deps, ctx, { task_id, lease_token }) => {
    const task = await deps.useCases.heartbeat.run({ taskId: task_id, lease_token, ...ctx })
    return toTaskDto((await deps.tasksRoot.findWithCounts(task.id))!)
  },
})

export const listReadyTasks = defineTool({
  name: 'list_ready_tasks',
  description: 'Ready work — leaf, todo, unblocked, unclaimed (mirrors GET /tasks/next).',
  input: z.object({
    label: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(), // default 10 via the use-case clamp (D-mm)
  }),
  run: async (deps, _ctx, { label, limit }) =>
    (await deps.useCases.getNext.run({ label, limit })).map(toTaskDto),
})

export const getTaskContext = defineTool({
  name: 'get_task_context',
  description:
    'The one-call bundle for working a task (mirrors GET /tasks/{id}/context; spec-fixed shape).',
  input: z.object({ task_id: z.string() }),
  run: async (deps, _ctx, { task_id }) => deps.useCases.getContext.run({ taskId: task_id }),
})

export const addBlock = defineTool({
  name: 'add_block',
  description: 'Blocker edge task blocked-by blocker (mirrors PUT /tasks/{id}/blocks/{blockerId}).',
  input: z.object({ task_id: z.string(), blocker_id: z.string() }),
  run: async (deps, ctx, { task_id, blocker_id }) => {
    await deps.useCases.addBlock.run({ taskId: task_id, blocker_id, ...ctx })
  },
})

export const removeBlock = defineTool({
  name: 'remove_block',
  description: 'Remove a blocker edge (mirrors DELETE /tasks/{id}/blocks/{blockerId}).',
  input: z.object({ task_id: z.string(), blocker_id: z.string() }),
  run: async (deps, ctx, { task_id, blocker_id }) => {
    await deps.useCases.removeBlock.run({ taskId: task_id, blocker_id, ...ctx })
  },
})

export const TASK_TOOLS = [
  getTask,
  listTasks,
  createTask,
  updateTask,
  updateTaskStatus,
  claimTask,
  releaseTask,
  heartbeatTask,
  listReadyTasks,
  getTaskContext,
  addBlock,
  removeBlock,
]
