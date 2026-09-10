// ui.ts — D-vv: the SvelteKit static SPA mount. Its own encapsulated scope;
// wildcard:true registers exactly `GET /ui/*` INSIDE the scope, so the scope's
// setNotFoundHandler answers SPA deep-links while the ROOT notFound stays
// problem+json byte-untouched. Same cwd-relative asset story as /openapi.yaml
// (Docker asset-shipping stays F — stated).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '#root/main/deps'

const BUILD_DIR = join(process.cwd(), 'adapters', 'sveltekit', 'build')
export const uiBuildPresent = (): boolean => existsSync(join(BUILD_DIR, 'index.html'))

// the 2-arg signature is buildApp symmetry; deps exists ONLY for the skip-path
// story (preflight P7/fix11 deleted the dead deliveryLoop line — measured here:
// eslint's after-used rule flags the unused tail param, the plan sanctions this
// one-line disable on the signature)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const mountUi = (app: FastifyInstance, deps: AppDeps): void => {
  if (!uiBuildPresent()) {
    // dev/test without a build: the mount skips, /ui/* 404s as problem+json, boot
    // NEVER crashes — the Playwright smoke builds first (D-xx).
    app.log.warn(
      'UI build absent (adapters/sveltekit/build) — /ui mount skipped; run pnpm ui:build'
    )
    return
  }
  // (fix11, preflight P7) the scope registers WITH { prefix: '/ui' } — the prefix-less
  // shape collided with the repo root's own setNotFoundHandler at boot: 'Not found handler
  // already set for Fastify instance with prefix: /'. Static now mounts at '/' INSIDE the
  // /ui scope; every runtime arm (shell/deep-link/asset cache/br/POST/404s) re-verified green.
  void app.register(
    async (scope) => {
      await scope.register(fastifyStatic, {
        root: BUILD_DIR,
        prefix: '/',
        wildcard: true,
        index: ['index.html'],
        // hashed assets (vite emits content-hashed names) are immutable forever;
        // the shell (and the fallback) is always no-cache — setHeaders below.
        immutable: true,
        maxAge: '30d',
        preCompressed: true, // pairs adapter-static precompress:true
        setHeaders(reply, path) {
          if (path.endsWith('.html')) reply.header('cache-control', 'no-cache')
        },
      })
      scope.setNotFoundHandler((request, reply) => {
        // SPA fallback: scope-local ONLY — deep-links answer the shell; the root
        // handler (problem+json) owns everything outside /ui.
        if (request.method === 'GET' || request.method === 'HEAD') {
          // html arm: no-cache via setHeaders is route-path-based; the explicit
          // header wins for the fallback (sendFile ships the 30d plugin default)
          return reply.code(200).header('cache-control', 'no-cache').sendFile('index.html')
        }
        // non-GET deep-links fall to the root problem+json 404 — the root notFound
        // does NOT fire for in-scope misses; re-shape the problem HERE (the body
        // matches problem.ts's envelope byte-for-byte; ui.test.ts U6c pins the
        // byte-equality against a live root 404 — problem() stays private, the
        // pinned-untouched rule for problem.ts stands):
        return reply.code(404).type('application/problem+json').send({
          type: 'https://nightshift.local/errors/not_found',
          title: 'not found',
          status: 404,
          code: 'not_found',
          detail: 'route not found',
        })
      })
    },
    { prefix: '/ui' }
  )
}
