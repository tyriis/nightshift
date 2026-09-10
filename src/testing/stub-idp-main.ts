// D-xx e2e-only runner: boots the SHIPPED stub-Idp factory (buildStubIdp from
// ./stub-idp — same code the vitest suites inject against) as a REAL-SOCKET
// server on 127.0.0.1:3310 so the Playwright browser can reach it. This is the
// ONE stated exception to the zero-sockets doctrine: a browser is a network
// actor by definition. The served code is the IN-REPO stub — never a real IdP —
// and it binds loopback ONLY.
// Users per the §11.5 script: alice's email rides the Task-7 allow-list seed
// (alice@example.com — global-setup adds it via the bootstrap-admin API).
import { buildStubIdp } from '#root/testing/stub-idp'

const ISSUER = 'http://127.0.0.1:3310'

const idp = buildStubIdp({
  issuer: ISSUER,
  clientId: 'nightshift-e2e',
  clientSecret: 'e2e-secret-not-a-real-one-0001',
  redirectUris: ['http://127.0.0.1:3311/auth/callback'],
  users: {
    alice: { sub: 'e2e-sub-alice', email: 'alice@example.com', preferred_username: 'alice' },
    bob: { sub: 'e2e-sub-bob', email: 'bob@example.com', preferred_username: 'bob' },
  },
})

// webServer readiness leg: the shipped factory registers no health route and
// stub-idp.ts is not this task's surface to grow — the runner that owns the
// socket owns its ping.
void idp.app.get('/ping', () => 'pong')

await idp.app.listen({ host: '127.0.0.1', port: 3310 })
console.warn(`stub-idp (e2e only, D-xx) listening on ${ISSUER} — in-repo stub, loopback only`)
