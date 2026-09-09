import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'
import { actorCtx, requireHuman, requireAdmin } from '#root/adapters/rest/auth'
import { ACTOR_KINDS, type ActorKind, type HumanRole } from '#root/domain/task'

// human-only guard: requireHuman is async (auth.ts) — a sync-throwing preHandler would
// deadlock fastify's hook iterator (R4); fixed at the source, so routes wire it directly.

export const registerAdminRoutes = (app: FastifyInstance, deps: AppDeps): void => {
  app.get('/admin/actors', { preHandler: [requireHuman, requireAdmin] }, async () =>
    deps.actorsRoot.list()
  )

  // plan block embedded the async handler in the options object (non-compiling) and sent
  // createActor.run's promise un-awaited — fastify 5 has no thenable branch in
  // Reply.prototype.send, a raw Promise payload JSON-serializes to {}. Shipped as the
  // 3-arg registration with the awaited row returned, matching labels.ts POST /labels
  // (Task 15 sync precedent); schema and preHandler kept verbatim.
  app.post(
    '/admin/actors',
    {
      preHandler: [requireHuman, requireAdmin],
      schema: {
        body: {
          type: 'object',
          required: ['kind', 'handle', 'display_name'],
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ACTOR_KINDS },
            handle: { type: 'string', minLength: 1, maxLength: 60 },
            display_name: { type: 'string', minLength: 1, maxLength: 120 },
            description: { type: 'string' },
            // D-ss: role is humans-only at the edge; the use-case drops it for agents
            // (never an error), default member lives in CreateActor.
            role: {
              type: 'string',
              enum: ['admin', 'member'],
              description: 'humans only; default member',
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        kind: ActorKind
        handle: string
        display_name: string
        description?: string
        role?: HumanRole
      }
      // trusted auth context spread LAST, after the schema-validated body
      // (Task 14 review defense; the plan block spread it first)
      const actor = await deps.useCases.createActor.run({ ...body, ...actorCtx(request) })
      return reply.code(201).send(actor)
    }
  )

  // 3-arg repair as above; handler body unchanged (already awaited in the plan)
  app.post(
    '/admin/actors/:id/tokens',
    {
      preHandler: [requireHuman, requireAdmin],
      schema: {
        body: {
          type: 'object',
          required: ['label'],
          additionalProperties: false,
          properties: { label: { type: 'string', minLength: 1, maxLength: 60 } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const { label } = request.body as { label: string }
      const issued = await deps.useCases.createToken.run({
        ...actorCtx(request),
        actor_id: id,
        label,
      })
      // raw_token shown exactly once (spec §5); never derivable from storage afterwards.
      // The projection picks fields explicitly: TokenRow.token_hash never enters a response.
      return reply.code(201).send({
        token_id: issued.token.id,
        actor_id: issued.token.actor_id,
        label: issued.token.label,
        created_at: issued.token.created_at,
        raw_token: issued.raw_token,
      })
    }
  )

  app.post(
    '/admin/tokens/:id/revoke',
    { preHandler: [requireHuman, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      await deps.useCases.revokeToken.run({ ...actorCtx(request), token_id: id })
      return reply.code(204).send()
    }
  )

  app.get('/admin/policy/:key', { preHandler: [requireHuman, requireAdmin] }, async (request) => {
    // read; no audit attribution needed
    const { key } = request.params as { key: string }
    return { key, value: await deps.useCases.getPolicy.run({ key }) }
  })

  // 3-arg repair as above. The body enum fences bad values at the edge (400
  // invalid_request via problem.ts's validation branch); SetPolicy's allowlist stays
  // the real gatekeeper for every caller.
  // D-tt (review R2/B10): the transport enum WIDENS for oidc_provisioning's 'allowlist' —
  // POLICY_ALLOWLIST remains the per-key semantic gate (review_gate + 'allowlist' 400, pinned).
  app.put(
    '/admin/policy/:key',
    {
      preHandler: [requireHuman, requireAdmin],
      schema: {
        body: {
          type: 'object',
          required: ['value'],
          additionalProperties: false,
          properties: { value: { type: 'string', enum: ['on', 'off', 'allowlist'] } },
        },
      },
    },
    async (request) => {
      const { key } = request.params as { key: string }
      const { value } = request.body as { value: string }
      await deps.useCases.setPolicy.run({ ...actorCtx(request), key, value })
      return { key, value }
    }
  )

  // D-tt allow-list surface: the three ops join the admin gate (D-ss "ten ops + 3").
  app.get('/admin/allowlist', { preHandler: [requireHuman, requireAdmin] }, async (request) =>
    deps.useCases.listAllowlist.run({ ...actorCtx(request) })
  )

  app.post(
    '/admin/allowlist',
    {
      preHandler: [requireHuman, requireAdmin],
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          additionalProperties: false,
          properties: {
            // D-tt email rule DECLARED at the edge; the use-case re-validates this
            // same language and owns the lowercase normalization (pinned both sides).
            email: {
              type: 'string',
              minLength: 3,
              maxLength: 254,
              pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { email } = request.body as { email: string }
      const res = await deps.useCases.addAllowlist.run({ email, ...actorCtx(request) })
      // duplicate POST is idempotent: 200 with the existing row, 201 only on create
      return reply.code(res.created ? 201 : 200).send(res.row)
    }
  )

  app.delete(
    '/admin/allowlist/:email',
    { preHandler: [requireHuman, requireAdmin] },
    async (request, reply) => {
      // fastify delivers the path param URL-decoded; the lowercase rule applies
      // before lookup in the use-case (pinned via ALICE%40EXAMPLE.com)
      const { email } = request.params as { email: string }
      await deps.useCases.removeAllowlist.run({ email, ...actorCtx(request) })
      return reply.code(204).send()
    }
  )
}
