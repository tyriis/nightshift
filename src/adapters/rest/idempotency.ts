import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import { DomainError } from '#root/domain/errors'

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])

export const registerIdempotency = (app: FastifyInstance, deps: AppDeps): void => {
  app.addHook('onRequest', async (request, reply) => {
    // registers AFTER registerAuth: reservation is per-actor and needs the resolved actor
    if (!MUTATING.has(request.method) || !request.actorRef) return
    const key = request.headers['idempotency-key']
    if (typeof key !== 'string' || key.length === 0 || key.length > 200) return

    const outcome = await deps.idemRoot.reserve({
      actor_id: request.actorRef.id,
      idem_key: key,
      request_method: request.method,
      request_path: request.url.split('?')[0],
      created_at: deps.clock.now().toISOString(),
    })
    if (outcome.state === 'complete') {
      // replay the stored response verbatim; content-type pinned so the string
      // payload is not downgraded to text/plain by content sniffing
      return reply
        .code(outcome.status)
        .header('content-type', 'application/json')
        .send(outcome.body)
    }
    if (outcome.state === 'in_flight') {
      throw new DomainError(
        'idempotency_in_flight',
        'a request with this Idempotency-Key is in flight'
      )
    }
    request.idemKey = key
  })

  app.addHook('onSend', async (request, reply, payload) => {
    if (!request.idemKey || !request.actorRef) return payload
    const actor = request.actorRef.id
    const key = request.idemKey
    if (reply.statusCode >= 500) {
      await deps.idemRoot.remove(actor, key) // 5xx must be retryable (D-j)
    } else {
      // A 204 reaches onSend with a null/undefined payload; it must still COMPLETE,
      // never strand the key in flight (D-j review pin). No route streams today;
      // a non-string payload is stored as '' rather than stranding the key.
      const body =
        typeof payload === 'string'
          ? payload
          : Buffer.isBuffer(payload)
            ? payload.toString('utf8')
            : ''
      await deps.idemRoot.complete(actor, key, reply.statusCode, body)
    }
    return payload
  })
}
