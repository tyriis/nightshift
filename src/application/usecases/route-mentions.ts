import { extractMentions } from '#root/domain/mentions'
import type { IdGen, Repos } from '#root/application/ports'

export interface MentionContext {
  actorId: string
  taskId: string
  threadId: string
  at: string
}

/**
 * D-q: route @mention inbox entries for a posted body. Unknown handles are dropped
 * (no actor to notify); the author is never notified of their own mention.
 */
export async function routeMentions(
  repos: Repos,
  ids: IdGen,
  body: string,
  ctx: MentionContext
): Promise<void> {
  for (const handle of extractMentions(body)) {
    const target = await repos.actors.findByHandle(handle)
    if (!target || target.id === ctx.actorId) continue
    await repos.inbox.add({
      id: ids.newId('ib'),
      actor_id: target.id,
      kind: 'mentioned',
      task_id: ctx.taskId,
      thread_id: ctx.threadId,
      created_at: ctx.at,
    })
  }
}
