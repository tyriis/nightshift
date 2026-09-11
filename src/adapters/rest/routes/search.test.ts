import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { makeTestApp, type TestApp } from '#root/testing/test-app'
import { hashToken } from '#root/infra/token-hash'

const bearer = (t: TestApp): Record<string, string> => ({ authorization: `Bearer ${t.adminToken}` })
const asBearer = (raw: string): Record<string, string> => ({ authorization: `Bearer ${raw}` })

// agent-token seeding rides the tasks.test.ts fixture idiom (insert actor+token rows)
const newAgent = async (t: TestApp, handle: string): Promise<string> => {
  const raw = randomBytes(32).toString('base64url')
  const now = new Date().toISOString()
  await t.deps.db
    .insertInto('actors')
    .values({
      id: `a_${handle}`,
      kind: 'agent',
      handle,
      display_name: handle,
      description: '',
      created_at: now,
    })
    .execute()
  await t.deps.db
    .insertInto('tokens')
    .values({
      id: `tok_${handle}`,
      actor_id: `a_${handle}`,
      token_hash: hashToken(raw),
      label: 'test',
      created_at: now,
      last_used_at: null,
      revoked_at: null,
    })
    .execute()
  return raw
}

// D-ppp: GET /search — the §12 slice over the D-gg FTS port. The FTS BEHAVIOR is the
// repo's own suite (search-repo.test.ts, byte-untouched); THIS file owns the contract
// surface: auth, validation, the malformed-MATCH 400 mapping, and the raw passthrough.
describe('GET /search (D-ppp)', () => {
  it('requires auth (search is not in PUBLIC_PATHS — §5 stays every-AUTHENTICATED-actor)', async () => {
    // A5: this arm is already GREEN at RED — the app-level onRequest hook 401s
    // before routing; it pins the HOOK surface, not the route's existence.
    const t = await makeTestApp()
    expect((await t.app.inject({ method: 'GET', url: '/search?q=alpha' })).statusCode).toBe(401)
    await t.close()
  })

  it('finds seeded work through the REAL insert path (triggers fire); raw hit passthrough', async () => {
    const t = await makeTestApp()
    const filed = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: bearer(t),
      payload: {
        title: 'Deploy the widget service',
        description: 'widget rollout notes',
        status: 'todo',
      },
    })
    expect(filed.statusCode).toBe(201)
    const id = filed.json().id as string
    const res = await t.app.inject({
      method: 'GET',
      url: '/search?q=widget&limit=10',
      headers: bearer(t),
    })
    expect(res.statusCode).toBe(200)
    const hits = res.json() as Array<Record<string, unknown>>
    expect(hits).toHaveLength(1)
    expect(hits[0]?.id).toBe(id)
    expect(hits[0]?.snippet).toMatch(/\[widget\]/i) // the [] wrapping is the port's (D-gg)
    expect(typeof hits[0]?.score).toBe('number') // bm25 flipped, server truth
    await t.close()
  })

  it('the absent limit rides the route default (20) — the ?? arm; nothing 400s', async () => {
    const t = await makeTestApp()
    for (let i = 0; i < 21; i++) {
      await t.app.inject({
        method: 'POST',
        url: '/tasks',
        headers: bearer(t),
        payload: { title: `default arm ${i}`, description: 'commonsearchterm', status: 'todo' },
      })
    }
    const res = await t.app.inject({
      method: 'GET',
      url: '/search?q=commonsearchterm',
      headers: bearer(t),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(20)
    await t.close()
  })

  it('missing q, blank q and out-of-band limits are 400 invalid_request problems', async () => {
    const t = await makeTestApp()
    for (const url of ['/search', '/search?q=', '/search?q=x&limit=0', '/search?q=x&limit=201']) {
      const res = await t.app.inject({ method: 'GET', url, headers: bearer(t) })
      expect(res.statusCode, url).toBe(400)
      expect(res.json().code, url).toBe('invalid_request')
    }
    await t.close()
  })

  it('a malformed MATCH string is the repo invalid_request over HTTP, not a 500 (D-gg map)', async () => {
    const t = await makeTestApp()
    const res = await t.app.inject({ method: 'GET', url: '/search?q=AND%20OR', headers: bearer(t) })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid_request')
    await t.close()
  })

  it('an agent bearer may search too — every authenticated actor reads everything (spec §5)', async () => {
    const t = await makeTestApp()
    const agent = await newAgent(t, 'hermes-search')
    await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: asBearer(agent),
      payload: { title: 'searchable agent work', status: 'todo' },
    })
    const res = await t.app.inject({
      method: 'GET',
      url: '/search?q=searchable',
      headers: asBearer(agent),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(1)
    await t.close()
  })
})
