// src/cli/cli.test.ts — the D-aaa exit ladder + machine strings, pinned against the real
// app (inject harness, zero sockets) and stub fetches for the transport legs.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCli, type CliIo } from '#root/cli/run'
import { makeInjectFetch } from '#root/testing/inject-fetch'
import { makeTestApp } from '#root/testing/test-app'

let CURRENT: Awaited<ReturnType<typeof makeTestApp>>
beforeEach(async () => {
  CURRENT = await makeTestApp()
})
afterEach(async () => {
  await CURRENT.close()
})

// the DI door (D-aaa): argv+env in, exit code + captured stdout/stderr out
const run = async (
  argv: string[],
  env: Record<string, string> = {},
  fetch: typeof globalThis.fetch = makeInjectFetch(() => CURRENT.app)
) => {
  const out: string[] = []
  const err: string[] = []
  const io: CliIo = {
    argv,
    env: { NS_URL: 'http://nightshift.test', NS_TOKEN: CURRENT.adminToken, ...env },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    fetch,
  }
  return { code: await runCli(io), out, err }
}
const stubFetch = (impl: (...args: never[]) => Promise<Response>): typeof globalThis.fetch =>
  impl as unknown as typeof globalThis.fetch
const createTask = async (title: string, extra: Record<string, unknown> = {}) => {
  const res = await CURRENT.app.inject({
    method: 'POST',
    url: '/tasks',
    headers: { authorization: `Bearer ${CURRENT.adminToken}`, 'content-type': 'application/json' },
    payload: { title, status: 'todo', ...extra },
  })
  return JSON.parse(res.payload) as { id: string }
}

describe('cli run-core (D-aaa)', () => {
  it('help exits 0 with the usage contract in both spellings', async () => {
    for (const argv of [['--help'], ['help']]) {
      const r = await run(argv)
      expect(r.code).toBe(0)
      expect(r.out).toEqual([])
      expect(r.err.join('\n')).toMatch(/nightshift next/)
      expect(r.err.join('\n')).toMatch(
        /exit: 0 ok · 1 transport_error · 2 usage\/config \(nothing sent\) · 3 API problem/
      )
    }
  })
  it('unknown command and bare argv are usage_error exit 2 (nothing sent)', async () => {
    expect((await run([])).err[0]).toBe("nightshift: usage_error unknown command ''")
    expect((await run([])).code).toBe(2)
    const r = await run(['wat'])
    expect(r.code).toBe(2)
    expect(r.err[0]).toBe("nightshift: usage_error unknown command 'wat'")
  })
  it('config errors exit 2, echo no secret VALUES', async () => {
    const badUrl = await run(['next'], { NS_URL: 'not-a-url', NS_TOKEN: 'sekret-token-9' })
    expect(badUrl.code).toBe(2)
    expect(badUrl.err[0]).toMatch(/^nightshift: config_error/)
    expect(badUrl.err.join('')).not.toMatch(/sekret-token-9/)
    expect((await run(['next'], { NS_TOKEN: '' })).code).toBe(2) // min(1) leg
    expect((await run(['next'], { NS_TIMEOUT_MS: '10' })).code).toBe(2) // min(100) leg
  })
  it('--limit mirrors the SERVER pin locally (1..100 int), fail-cheap exit 2', async () => {
    for (const bad of ['abc', '0', '101']) {
      const r = await run(['next', '--limit', bad])
      expect(r.code).toBe(2)
      expect(r.err[0]).toMatch(/^nightshift: config_error --limit/)
    }
    expect((await run(['next', '--limit', '2'])).code).toBe(0)
  })
  it('flag-shape errors: missing value, flag-as-value, unknown flag, stray positional', async () => {
    expect((await run(['next', '--label'])).err[0]).toBe(
      'nightshift: usage_error flag --label needs a value'
    )
    expect((await run(['next', '--label', '--limit', '2'])).code).toBe(2)
    expect((await run(['next', '--bogus', 'x'])).err[0]).toBe(
      "nightshift: usage_error unknown flag --bogus for 'next'"
    )
    expect((await run(['next', 't_stray'])).err[0]).toBe(
      "nightshift: usage_error 'next' takes no positional arguments"
    )
  })
  it('next prints the server DTOs as JSONL — empty output when nothing is ready', async () => {
    const empty = await run(['next'])
    expect(empty.code).toBe(0)
    expect(empty.out).toEqual([])
    const a = await createTask('ready a')
    const b = await createTask('ready b')
    const r = await run(['next'])
    expect(r.code).toBe(0)
    expect(r.out.length).toBe(2)
    expect(JSON.parse(r.out[0]).id).toBe(a.id) // server FIFO order preserved, no CLI reshaping
    expect(JSON.parse(r.out[1]).id).toBe(b.id)
    expect(JSON.parse(r.out[0]).status).toBe('todo')
  })
  it('next forwards --label and --limit to the server query', async () => {
    await createTask('labeled', { labels: ['front'] })
    await createTask('bare')
    const labeled = await run(['next', '--label', 'front'])
    expect(labeled.out.length).toBe(1)
    expect(JSON.parse(labeled.out[0]).title).toBe('labeled')
    expect((await run(['next', '--limit', '1'])).out.length).toBe(1)
  })
  it('an API problem exits 3: taxonomy code line 1, flat D-jj envelope line 2', async () => {
    const r = await run(['next'], { NS_TOKEN: 'wrong-token' })
    expect(r.code).toBe(3)
    expect(r.err[0]).toBe('nightshift: unauthenticated')
    expect(JSON.parse(r.err[1])).toMatchObject({ code: 'unauthenticated', status: 401 })
  })
  it('garbage responses are transport_error exit 1 — the ladder, not the library (P7)', async () => {
    const text502 = stubFetch(async () => new Response('not json at all', { status: 502 }))
    expect((await run(['next'], {}, text502)).err[0]).toBe('nightshift: transport_error')
    expect((await run(['next'], {}, text502)).code).toBe(1)
    const empty200 = stubFetch(async () => new Response('', { status: 200 }))
    expect((await run(['next'], {}, empty200)).code).toBe(1)
    const codedLess = stubFetch(
      async () =>
        new Response(JSON.stringify({ message: 'gateway shrug' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        })
    )
    expect((await run(['next'], {}, codedLess)).err[0]).toBe('nightshift: transport_error')
  })
  it('a dead socket, a thrown string and the NS_TIMEOUT_MS abort all exit 1', async () => {
    const boom = stubFetch(async () => {
      throw new Error('socket died')
    })
    const r = await run(['next'], {}, boom)
    expect(r.code).toBe(1)
    expect(r.err).toEqual(['nightshift: transport_error', 'Error: socket died'])
    const strung = stubFetch(async () => {
      throw 'plain-string-failure'
    })
    expect((await run(['next'], {}, strung)).err[1]).toBe('plain-string-failure')
    // the timeout seam: init.signal is the AbortSignal.timeout — honour it, never resolve
    const hang = stubFetch(
      (_input: never, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init?.signal?.reason))
        })
    )
    const t0 = Date.now()
    const timed = await run(['next'], { NS_TIMEOUT_MS: '100' }, hang)
    expect(timed.code).toBe(1)
    expect(timed.err[0]).toBe('nightshift: transport_error')
    expect(Date.now() - t0).toBeLessThan(5_000) // deterministic abort, not a hang
  })
})

// appended to src/cli/cli.test.ts — the §14 claim race through the CLI (P8 pin)
const agentToken = async (handle: string): Promise<string> => {
  const actor = await CURRENT.app.inject({
    method: 'POST',
    url: '/admin/actors',
    headers: { authorization: `Bearer ${CURRENT.adminToken}`, 'content-type': 'application/json' },
    payload: { kind: 'agent', handle, display_name: handle },
  })
  const tok = await CURRENT.app.inject({
    method: 'POST',
    url: `/admin/actors/${(JSON.parse(actor.payload) as { id: string }).id}/tokens`,
    headers: { authorization: `Bearer ${CURRENT.adminToken}`, 'content-type': 'application/json' },
    payload: { label: 'cli-test' },
  })
  return (JSON.parse(tok.payload) as { raw_token: string }).raw_token
}

describe('cli claim (D-aaa)', () => {
  it('claim prints {task_id, lease_token, generation, keepalive} — the lease NEVER touches argv', async () => {
    const t = await createTask('claimable')
    const r = await run(['claim', t.id])
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.out[0]) as Record<string, unknown>
    expect(parsed.task_id).toBe(t.id)
    expect(typeof parsed.lease_token).toBe('string')
    expect(typeof parsed.generation).toBe('number')
    // D-nnn: the test twin boots dormant (no NS_KEEPALIVE_* overrides) — the echo is
    // the dormant pair verbatim
    expect(parsed.keepalive).toEqual({ interval_ms: 0, timeout_s: 0 })
  })
  it('the race loser exits 3 with `nightshift: already_claimed` + flat holder fields (P8)', async () => {
    const t = await createTask('contested')
    const winner = await run(['claim', t.id], { NS_TOKEN: await agentToken('a_winner') })
    expect(winner.code).toBe(0)
    const loser = await run(['claim', t.id], { NS_TOKEN: await agentToken('a_loser') })
    expect(loser.code).toBe(3)
    expect(loser.err[0]).toBe('nightshift: already_claimed')
    expect(JSON.parse(loser.err[1])).toMatchObject({
      code: 'already_claimed',
      status: 409,
      holder_handle: 'a_winner',
    })
  })
  it('ghost task → exit 3 not_found; claim arity is exact', async () => {
    expect((await run(['claim', 't_ghost'])).err[0]).toBe('nightshift: not_found')
    expect((await run(['claim'])).err[0]).toBe(
      "nightshift: usage_error 'claim' takes exactly one <task-id>"
    )
    expect((await run(['claim', 'a', 'b'])).code).toBe(2)
  })
  it('unknown flags die per-command: --label is a next-only flag', async () => {
    expect((await run(['claim', 't_x', '--label', 'nope'])).err[0]).toBe(
      "nightshift: usage_error unknown flag --label for 'claim'"
    )
  })
})

// appended to src/cli/cli.test.ts — the report arms incl. the honest partial-state pin
// B1/S1 fix: the server serves ThreadWithMessages = { thread: {...}, messages: [...] }
// (ports.ts:288-291) — `kind` lives UNDER thread, `messages` is top-level.
const threads = async (
  id: string
): Promise<{ thread: { kind: string }; messages: { body: string }[] }[]> => {
  const res = await CURRENT.app.inject({
    method: 'GET',
    url: `/tasks/${id}/threads`,
    headers: { authorization: `Bearer ${CURRENT.adminToken}` },
  })
  return JSON.parse(res.payload) as { thread: { kind: string }; messages: { body: string }[] }[]
}
const claimAs = async (id: string, token: string): Promise<string> => {
  const r = await run(['claim', id], { NS_TOKEN: token })
  expect(r.code).toBe(0)
  return (JSON.parse(r.out[0]) as { lease_token: string }).lease_token
}

describe('cli report (D-aaa)', () => {
  it('--message posts a NOTE thread and prints {task_id, message_id}', async () => {
    const t = await createTask('reportable')
    const r = await run(['report', t.id, '--message', 'progress: wired the door'])
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.out[0]) as Record<string, unknown>
    expect(parsed.task_id).toBe(t.id)
    expect(typeof parsed.message_id).toBe('string')
    const list = await threads(t.id)
    expect(list[0]).toMatchObject({
      thread: { kind: 'note' },
      messages: [{ body: 'progress: wired the door' }],
    })
  })
  it('--status moves status under the env lease and prints the server Task DTO', async () => {
    const agent = await agentToken('a_reporter')
    const t = await createTask('movable')
    const lease = await claimAs(t.id, agent)
    const r = await run(['report', t.id, '--status', 'in_progress', '--reason', 'starting work'], {
      NS_TOKEN: agent,
      NS_LEASE_TOKEN: lease,
    })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out[0])).toMatchObject({ id: t.id, status: 'in_progress' })
  })
  it('an unclaimed task moves WITHOUT a lease (claim → release → move) — the lease-less arm (P9)', async () => {
    const agent = await agentToken('a_releaser')
    const t = await createTask('releasable')
    await claimAs(t.id, agent)
    const rel = await CURRENT.app.inject({
      method: 'POST',
      url: `/tasks/${t.id}/release`,
      headers: { authorization: `Bearer ${agent}` },
    })
    expect(rel.statusCode).toBe(200)
    const r = await run(['report', t.id, '--status', 'in_progress', '--reason', 'fresh start'], {
      NS_TOKEN: agent,
    })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out[0]).status).toBe('in_progress')
  })
  it('HONEST PARTIAL (D-aaa): the note lands, a wrong lease still exits 3 stale_lease', async () => {
    const agent = await agentToken('a_partial')
    const t = await createTask('partial')
    await claimAs(t.id, agent)
    const r = await run(
      [
        'report',
        t.id,
        '--message',
        'this note WILL land',
        '--status',
        'in_progress',
        '--reason',
        'x',
      ],
      { NS_TOKEN: agent, NS_LEASE_TOKEN: 'wrong-lease' }
    )
    expect(r.code).toBe(3)
    expect(r.err[0]).toBe('nightshift: stale_lease')
    const list = await threads(t.id) // the note is there — no cross-request transaction, honestly
    expect(list[0].messages[0].body).toBe('this note WILL land')
  })
  it('a note that 404s exits 3 and prints nothing — the note-leg failFrom arm (never-lower P10)', async () => {
    // the note POST is the FIRST report request; its failure returns on the note leg —
    // before the status move and before the message-only tail (the `return nf` arm the
    // block's tests never reached; Plan D T6/T7 "prove it, not document it" precedent).
    const r = await run(['report', 't_ghost', '--message', 'to a ghost'])
    expect(r.code).toBe(3)
    expect(r.err[0]).toBe('nightshift: not_found')
    expect(r.out).toEqual([]) // nothing printed — returned on the note leg, no message_id tail
  })
  it('an agent may not close: --status done answers exit 3 agent_close_forbidden', async () => {
    const agent = await agentToken('a_closer')
    const t = await createTask('closable')
    const lease = await claimAs(t.id, agent)
    const r = await run(['report', t.id, '--status', 'done', '--reason', 'shipped'], {
      NS_TOKEN: agent,
      NS_LEASE_TOKEN: lease,
    })
    expect(r.code).toBe(3)
    expect(r.err[0]).toBe('nightshift: agent_close_forbidden')
  })
  it('local gates: needs message-or-status, status needs reason, status is the DOMAIN enum', async () => {
    expect((await run(['report', 't_x'])).err[0]).toBe(
      "nightshift: usage_error 'report' needs --message and/or --status"
    )
    expect((await run(['report', 't_x', '--status', 'in_progress'])).err[0]).toBe(
      'nightshift: usage_error --status requires --reason (the server invariant)'
    )
    const bad = await run(['report', 't_x', '--status', 'shipped', '--reason', 'x'])
    expect(bad.code).toBe(2)
    expect(bad.err[0]).toMatch(
      /^nightshift: config_error --status must be one of backlog\|todo\|in_progress\|in_review\|done\|canceled/
    )
    expect((await run(['report', 't_x', '--message'])).err[0]).toBe(
      'nightshift: usage_error flag --message needs a value'
    )
  })
})

// D-jjj — the heartbeat leg: the CLI's keepalive voice for the sweeper (D-iii).
// The lease is a capability: absent NS_LEASE_TOKEN is LOCAL (exit 2, nothing
// sent, the D-aaa ladder); on the wire it rides the EXISTING heartbeat op.
describe('cli heartbeat (D-jjj)', () => {
  it('keeps the claim alive and prints the server Task DTO (last_heartbeat_at fresh)', async () => {
    const agent = await agentToken('a_beater')
    const t = await createTask('beatable')
    const lease = await claimAs(t.id, agent)
    const r = await run(['heartbeat', t.id], { NS_TOKEN: agent, NS_LEASE_TOKEN: lease })
    expect(r.code).toBe(0)
    const dto = JSON.parse(r.out[0]) as Record<string, unknown>
    expect(dto).toMatchObject({ id: t.id, status: 'in_progress' })
    expect(dto.last_heartbeat_at).not.toBeNull()
  })
  it('absent NS_LEASE_TOKEN is a local config_error — exit 2, NOTHING sent', async () => {
    const r = await run(
      ['heartbeat', 't_x'],
      {},
      stubFetch(() => Promise.reject(new Error('must not send')))
    )
    expect(r.code).toBe(2)
    expect(r.err[0]).toBe('nightshift: config_error heartbeat requires NS_LEASE_TOKEN (from claim)')
  })
  it('local gates: exact arity, no foreign flags', async () => {
    expect((await run(['heartbeat'])).err[0]).toBe(
      "nightshift: usage_error 'heartbeat' takes exactly one <task-id>"
    )
    expect((await run(['heartbeat', 'a', 'b'])).code).toBe(2)
    expect(
      (await run(['heartbeat', 't_x', '--label', 'nope'], { NS_LEASE_TOKEN: 'l' })).err[0]
    ).toBe("nightshift: usage_error unknown flag --label for 'heartbeat'")
  })
  it('a dead lease exits 3 stale_lease (release bumped the generation)', async () => {
    const agent = await agentToken('a_dead')
    const t = await createTask('dead-lease')
    const lease = await claimAs(t.id, agent)
    await CURRENT.app.inject({
      method: 'POST',
      url: `/tasks/${t.id}/release`,
      headers: { authorization: `Bearer ${agent}` },
    })
    const r = await run(['heartbeat', t.id], { NS_TOKEN: agent, NS_LEASE_TOKEN: lease })
    expect(r.code).toBe(3)
    expect(r.err[0]).toBe('nightshift: stale_lease')
  })
})
