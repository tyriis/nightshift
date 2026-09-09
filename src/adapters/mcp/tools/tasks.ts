// src/adapters/mcp/tools/tasks.ts — Task 4 seeds; Task 5 completes the family
import { z } from 'zod'
import { defineTool } from '#root/adapters/mcp/bridge'
import { toTaskDto } from '#root/adapters/rest/dto'
import { DomainError } from '#root/domain/errors'
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

export const TASK_TOOLS = [getTask, listTasks]
