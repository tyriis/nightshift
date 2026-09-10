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
