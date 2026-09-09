// MOVED VERBATIM from routes/threads.ts @ 328dea8 (`handleToId`) — the error
// messages are REST-pinned; the MCP `ask_question` composite shares this single
// resolver so no handle grammar forks (Task 2 / D-nn).
// REST speaks handles (public actor vocabulary); use-cases speak ids (ports.ts).
// The route resolves handle → id; an unknown handle 404s here, in the ROUTE layer.
import type { AppDeps } from '#root/main/deps'
import { DomainError } from '#root/domain/errors'

export const resolveActorHandle = async (deps: AppDeps, handle: string): Promise<string> => {
  const hit = await deps.actorsRoot.findByHandle(handle)
  if (!hit) throw new DomainError('not_found', `actor '@${handle}' not found`)
  return hit.id
}
