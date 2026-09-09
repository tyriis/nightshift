// Spec §7.1 composites (D-nn) — each is a SEQUENCE of the SAME use-case calls/repo
// reads its REST twin performs; no new domain logic, zero new codes (D-nn).
import { z } from 'zod'
import { defineTool } from '#root/adapters/mcp/bridge'
import { resolveActorHandle } from '#root/adapters/shared/resolve-handle'
import { toTaskDto } from '#root/adapters/rest/dto'
import { TASK_STATUSES } from '#root/domain/task'
import { DomainError } from '#root/domain/errors'

export const claimNext = defineTool({
  name: 'claim_next',
  description: 'Take the next ready task atomically (composite: next + claim, spec §7.1).',
  input: z.object({ label: z.string().optional() }),
  run: async (deps, ctx, { label }) => {
    const ready = await deps.useCases.getNext.run({ label, limit: 1 })
    if (ready.length === 0) return { claimed: false, task: null, claim: null } // empty is DATA (D-nn)
    const head = ready[0] // TaskWithCounts wrapper — the record lives under .task
    // lost race ⇒ ordinary already_claimed FLAT envelope + D-cc inbox copy rides from
    // claimTask.run itself — no new string, no new code, zero extra lines (D-nn)
    const claim = await deps.useCases.claimTask.run({ taskId: head.task.id, ...ctx })
    return {
      claimed: true,
      task: toTaskDto((await deps.tasksRoot.findWithCounts(head.task.id))!),
      claim,
    }
  },
})

export const postUpdate = defineTool({
  name: 'post_update',
  description:
    'Comment, optionally refresh the lease and move status — the §7.4 loop in one call (composite, spec §7.1).',
  input: z.object({
    task_id: z.string(),
    body: z.string().min(1).max(20000), // thread-body bounds per routes/threads.ts (D-mm duty)
    thread_id: z.string().optional(),
    lease_token: z.string().optional(),
    status: z.enum(TASK_STATUSES).optional(),
    reason: z.string().min(1).optional(),
  }),
  // Order: comment → heartbeat → status. NOT transactional (D-nn): each step is its
  // own use-case transaction; a propagating error leaves earlier steps booked.
  run: async (deps, ctx, a) => {
    let thread: unknown = null
    let message: unknown = null
    if (a.thread_id === undefined) {
      const created = await deps.useCases.createThread.run({
        taskId: a.task_id,
        kind: 'note',
        body: a.body,
        ...ctx,
      })
      thread = created.thread
      message = created.message
    } else {
      message = await deps.useCases.addMessage.run({ threadId: a.thread_id, body: a.body, ...ctx })
    }
    if (a.lease_token !== undefined) {
      await deps.useCases.heartbeat.run({ taskId: a.task_id, lease_token: a.lease_token, ...ctx })
    }
    if (a.status !== undefined) {
      if (a.reason === undefined) {
        throw new DomainError('invalid_request', 'status in post_update requires reason') // pinned test string — never reworded
      }
      await deps.useCases.updateStatus.run({
        taskId: a.task_id,
        to: a.status,
        reason: a.reason,
        // update-status invariant 3: a claimed task requires its current lease — the
        // §7.4 loop threads its lease into EVERY lease-gated step, exactly like REST's body
        lease_token: a.lease_token,
        ...ctx,
      })
    }
    return { thread, message, task: toTaskDto((await deps.tasksRoot.findWithCounts(a.task_id))!) }
  },
})

export const askQuestion = defineTool({
  name: 'ask_question',
  description:
    'Open a gate question for a human assignee (composite: handle + question thread, spec §7.1).',
  input: z.object({
    task_id: z.string(),
    text: z.string().min(1).max(20000), // thread-body bounds (routes/threads.ts:35)
    assignee: z.string().min(1).max(60), // assignee_handle bounds (routes/threads.ts:36)
  }),
  run: async (deps, ctx, { task_id, text, assignee }) => {
    const assigneeId = await resolveActorHandle(deps, assignee) // same resolver as REST (Task 2) — no grammar fork
    return deps.useCases.createThread.run({
      taskId: task_id,
      kind: 'question',
      body: text,
      assignee_id: assigneeId,
      ...ctx,
    })
  },
})

export const splitTask = defineTool({
  name: 'split_task',
  description: 'Atomically split a task into children (spec §7.1 name for POST /tasks/{id}/split).',
  input: z.object({
    task_id: z.string(),
    // SplitChildDraft keys verbatim (split-task.ts:11-16 carries description and
    // acceptance_criteria — mirrored per the Step 3 duty); child bounds transcribe
    // routes/tasks.ts:159-173 (title min1/max300, minItems 1).
    children: z
      .array(
        z.object({
          title: z.string().min(1).max(300),
          description: z.string().optional(),
          acceptance_criteria: z.string().optional(),
          status: z.enum(TASK_STATUSES).optional(),
        })
      )
      .min(1),
  }),
  run: async (deps, ctx, { task_id, children }) =>
    deps.useCases.splitTask.run({ taskId: task_id, children, ...ctx }),
})

export const COMPOSITE_TOOLS = [claimNext, postUpdate, askQuestion, splitTask]
