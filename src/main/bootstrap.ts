import type { AppDeps } from '#root/main/deps'
import { hashToken } from '#root/infra/token-hash'

/** Creates the first human + bearer token from env so an admin can log in and manage actors (spec D-h). Bootstrap init is not audited. */
export const ensureBootstrapAdmin = async (deps: AppDeps): Promise<void> => {
  const raw = deps.config.bootstrapToken
  if (!raw) return
  const now = deps.clock.now().toISOString()
  const hash = hashToken(raw)
  // fresh-process fast path: an ACTIVE token already matches the env
  if (await deps.actorsRoot.findActiveTokenByHash(hash)) return
  if (!(await deps.actorsRoot.findById('a_bootstrap'))) {
    await deps.actorsRoot.create({
      id: 'a_bootstrap',
      kind: 'human',
      handle: 'bootstrap',
      display_name: 'Bootstrap Admin',
      description: 'created from NS_BOOTSTRAP_TOKEN',
      created_at: now,
    })
  }
  // env-as-truth: NS_BOOTSTRAP_TOKEN defines the active bootstrap token on EVERY boot,
  // so UPSERT the row onto it (a plain insert crashes boot on tokens.id/tokens.token_hash
  // after RevokeToken or after rotating the env). Revoking the bootstrap token is
  // therefore only durable across restarts by ALSO removing NS_BOOTSTRAP_TOKEN from env.
  await deps.db
    .insertInto('tokens')
    .values({
      id: 'tok_bootstrap',
      actor_id: 'a_bootstrap',
      token_hash: hash,
      label: 'bootstrap',
      created_at: now,
    })
    .onConflict((oc) =>
      oc.column('id').doUpdateSet({ token_hash: hash, created_at: now, revoked_at: null })
    )
    .execute()
}
