import type { AppDeps } from '#root/main/deps'
import { hashToken } from '#root/infra/token-hash'

/** Creates the first human + bearer token from env so an admin can log in and manage actors (spec D-h). Bootstrap init is not audited. */
export const ensureBootstrapAdmin = async (deps: AppDeps): Promise<void> => {
  const raw = deps.config.bootstrapToken
  if (!raw) return
  const now = deps.clock.now().toISOString()
  if (await deps.actorsRoot.findActiveTokenByHash(hashToken(raw))) return
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
  await deps.actorsRoot.insertToken({
    id: 'tok_bootstrap',
    actor_id: 'a_bootstrap',
    token_hash: hashToken(raw),
    label: 'bootstrap',
    created_at: now,
  })
}
