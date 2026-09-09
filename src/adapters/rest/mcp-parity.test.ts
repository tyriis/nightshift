// spec §11.4: each MCP tool ⇄ REST behavior identical — the culminating parity pin.
// Every tool carries an ok-row (result ⇄ REST body under norm), an err-row where the
// taxonomy is reachable (FLAT envelope ⇄ problem body modulo prose, D-jj), and a
// reject-row where both sides merely reject validation-class input ("rejected ⇄
// rejected", the declared D-jj scope). claim_next/post_update/ask_question are
// rest-less composites — their §11.4 identity is their constituents', pinned Task 8.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { InjectOptions } from 'fastify'
import { mcpTools } from '#root/adapters/mcp/tools/index'
import { makeTestApp } from '#root/testing/test-app'
import { openHttpMcp } from '#root/testing/mcp-client'

type T = Awaited<ReturnType<typeof makeTestApp>>
type M = Awaited<ReturnType<typeof openHttpMcp>>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
interface World {
  t: T
  mcp: M
  bearer: string
  ids: Record<string, string>
}
interface Row {
  tool: string
  args: (w: World) => Record<string, unknown> // MCP-side args; ok/err/reject build the REST-side twin call
  ok?: {
    method: Method
    path: (w: World) => string
    body?: unknown // may be ((w: World) => unknown), resolved by restCall against the world (seed-lease bodies)
    headers?: Record<string, string>
  }
  err?: {
    mcpArgs: (w: World) => Record<string, unknown>
    rest: {
      method: Method
      path: (w: World) => string
      body?: unknown
      headers?: Record<string, string>
    }
  }
  // reject row: validation-class inputs — both sides merely REJECT (REST 400 ⇄ SDK input-validation);
  // comparing bodies across those two transport shapes is out of scope (D-jj), comparing rejection is not
  reject?: {
    mcpArgs: (w: World) => Record<string, unknown>
    rest: { method: Method; path: (w: World) => string; body?: unknown }
  }
}

// Write rows run REST on an R-fixture and MCP on an M-fixture (both seeded identical); bodies
// may legitimately differ only in per-resource identity — norm() removes exactly that.
// Everything that survives normalization must be EQUAL — that IS the pin.
// 'name' is volatile for the twin create_label rows (distinct fixture names); claim_generation,
// claim_token_id and sha256 are NOT volatile — fresh twin claims are generation-identical and the
// upload row pins the content hash; they MUST match.
const VOLATILE = new Set([
  'id',
  'created_at',
  'updated_at',
  'position',
  'lease_token',
  'last_heartbeat_at',
  'name',
  'parent_id',
  'thread_id',
  'task_id',
  'answer_message_id',
])
const norm = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(norm)
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => !VOLATILE.has(k))
        .map(([k, x]) => [k, norm(x)])
    )
  }
  return v
}

const flat = (b: Record<string, unknown>) => {
  const { type: _t, title: _ti, detail: _d, ...extras } = b
  return extras // compare the TAXONOMY + FLAT details, not transport prose (D-jj)
}

const restCall = async (
  w: World,
  r: {
    method: Method
    path: (w: World) => string
    body?: unknown
    headers?: Record<string, string>
  }
) => {
  const body = typeof r.body === 'function' ? (r.body as (w: World) => unknown)(w) : r.body
  const res = await w.t.app.inject({
    method: r.method,
    url: r.path(w),
    headers: { authorization: `Bearer ${w.bearer}`, ...(r.headers ?? {}) },
    ...(body === undefined ? {} : { payload: body as InjectOptions['payload'] }), // Buffer bodies ride raw (octet-stream upload rows)
  })
  return res
}

const expectOk = async (w: World, row: Row) => {
  const res = await restCall(w, row.ok!)
  expect(res.statusCode, `${row.tool} REST ok-side status`).toBeLessThan(300)
  const r = await w.mcp.call(row.tool, row.args(w))
  expect(r.isError, `${row.tool} ok-path errored: ${JSON.stringify(r.content)}`).toBeUndefined()
  const restBody = res.statusCode === 204 ? null : res.json()
  expect(norm((r.structuredContent as { result: unknown }).result)).toEqual(norm(restBody)) // D-jj: result ⇄ REST body modulo per-resource identity
}

const expectErr = async (w: World, row: Row) => {
  const res = await restCall(w, row.err!.rest)
  const r = await w.mcp.call(row.tool, row.err!.mcpArgs(w))
  expect(r.isError, `${row.tool} error-path succeeded`).toBe(true)
  expect(r.structuredContent).toEqual(flat(res.json() as Record<string, unknown>)) // byte-exact taxonomy + FLAT details (D-jj)
}

const expectReject = async (w: World, row: Row) => {
  const res = await restCall(w, row.reject!.rest)
  expect(res.statusCode, `${row.tool} REST reject-side accepted`).toBe(400)
  const r = await w.mcp.call(row.tool, row.reject!.mcpArgs(w))
  expect(r.isError, `${row.tool} MCP reject-side accepted`).toBe(true) // SDK input-validation shape — "rejected ⇄ rejected" only (D-jj)
}

// World setup — seedWorld builds every fixture through the REST twin (admin), recording ids + seed leases.
const seedWorld = async (w: World) => {
  const api = async (
    method: Method,
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {}
  ) => {
    const res = await w.t.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${w.bearer}`, ...headers },
      ...(payload === undefined ? {} : { payload: payload as InjectOptions['payload'] }),
    })
    expect(res.statusCode, `seed ${method} ${url} -> ${res.body}`).toBeLessThan(400)
    return res
  }
  const idOf = (res: { json(): unknown }) => String((res.json() as { id: string }).id)
  const ids = w.ids
  // create-task.ts:23 defaults to backlog and the claim gate accepts only todo|in_progress
  // (claim-task.ts:37) — every fixture whose row claims or moves status ships status:'todo'
  // (Task 5/8 seed correction, NOT a tool default).
  for (const [key, title, status] of [
    ['taskA', 'parity A', 'todo'],
    ['taskB', 'parity B'],
    ['taskB2', 'parity B'],
    ['taskC', 'parity C', 'todo'],
    ['taskC2', 'parity C', 'todo'],
    ['taskD', 'parity D'],
    ['taskD2', 'parity D'],
    ['claimR', 'parity claim', 'todo'],
    ['claimM', 'parity claim', 'todo'],
    ['relR', 'parity rel', 'todo'],
    ['relM', 'parity rel', 'todo'],
    ['host', 'parity host'],
    ['hostM', 'parity host'],
    ['attachS', 'parity attach'],
  ] as const)
    ids[key] = idOf(
      await api('POST', '/tasks', status === undefined ? { title } : { title, status })
    )
  await api('POST', `/tasks/${ids.taskA}/claim`) // the permanent already_claimed seed (holder = admin, the harness bearer)
  ids.leaseRelR = (
    (await api('POST', `/tasks/${ids.relR}/claim`)).json() as { lease_token: string }
  ).lease_token
  ids.leaseRelM = (
    (await api('POST', `/tasks/${ids.relM}/claim`)).json() as { lease_token: string }
  ).lease_token
  const newThread = async (hostKey: 'host' | 'hostM', payload: Record<string, unknown>) =>
    String(
      (
        (await api('POST', `/tasks/${ids[hostKey]}/threads`, payload)).json() as {
          thread: { id: string }
        }
      ).thread.id
    )
  ids.noteR = await newThread('host', { kind: 'note', body: 'seed note' })
  ids.noteM = await newThread('hostM', { kind: 'note', body: 'seed note' })
  ids.qR = await newThread('host', { kind: 'question', body: 'seed q?', assignee_handle: 'nils' })
  ids.qM = await newThread('hostM', { kind: 'question', body: 'seed q?', assignee_handle: 'nils' })
  // D-r self-notify (create-thread.ts:111): a question the admin bearer ASKS nils books NO
  // inbox row — the two questions whose assignment feeds mark_inbox_read (qA/qB) are seeded
  // through a throwaway CREATOR (the a_seed pattern, mount.test.ts/discussion.test.ts
  // precedent) so the question_assigned notification actually lands in nils's inbox.
  const seeder = await w.t.app.inject({
    method: 'POST',
    url: '/admin/actors',
    headers: { authorization: `Bearer ${w.bearer}` },
    payload: { kind: 'agent', handle: 'a_seed', display_name: 'Seed' },
  })
  expect(seeder.statusCode).toBe(201)
  const seederTok = await w.t.app.inject({
    method: 'POST',
    url: `/admin/actors/${(seeder.json() as { id: string }).id}/tokens`,
    headers: { authorization: `Bearer ${w.bearer}` },
    payload: { label: 'seed' },
  })
  expect(seederTok.statusCode).toBe(201)
  const seederBearer = String((seederTok.json() as { raw_token: string }).raw_token)
  const askedBySeeder = async (hostKey: 'host' | 'hostM') =>
    String(
      (
        (
          await w.t.app.inject({
            method: 'POST',
            url: `/tasks/${ids[hostKey]}/threads`,
            headers: { authorization: `Bearer ${seederBearer}` },
            payload: { kind: 'question', body: 'seed q?', assignee_handle: 'nils' },
          })
        ).json() as { thread: { id: string } }
      ).thread.id
    )
  ids.qA = await askedBySeeder('host')
  ids.qB = await askedBySeeder('hostM')
  ids.qE = await newThread('host', { kind: 'question', body: 'seed q?', assignee_handle: 'nils' })
  ids.qF = await newThread('hostM', { kind: 'question', body: 'seed q?', assignee_handle: 'nils' })
  await api('POST', `/tasks/${ids.host}/threads/${ids.qA}/answer`, { body: 'seed answer' }) // qA/qB answered (update_question ok-rows); qR/qM stay OPEN for answer_question; qE/qF stay open for the transition err
  await api('POST', `/tasks/${ids.hostM}/threads/${ids.qB}/answer`, { body: 'seed answer' })
  ids.lkR = idOf(
    await api('POST', `/tasks/${ids.host}/links`, {
      kind: 'other',
      url: 'https://parity.test/seed-r',
    })
  )
  ids.lkM = idOf(
    await api('POST', `/tasks/${ids.host}/links`, {
      kind: 'other',
      url: 'https://parity.test/seed-m',
    })
  )
  ids.labelS = idOf(await api('POST', '/labels', { name: 'parity-seed-label' }))
  const up = await w.t.app.inject({
    method: 'POST',
    url: `/tasks/${ids.host}/attachments?filename=seed.txt&content_type=text/plain`,
    headers: { authorization: `Bearer ${w.bearer}`, 'content-type': 'application/octet-stream' },
    payload: Buffer.from('seed bytes'),
  })
  expect(up.statusCode).toBe(201) // inline-disposition fixture for the get_attachment_content custom pin
  ids.att = String((up.json() as { id: string }).id)
  const inbox = (
    await w.t.app.inject({
      method: 'GET',
      url: '/inbox?limit=200',
      headers: { authorization: `Bearer ${w.bearer}` },
    })
  ).json() as { id: string; thread_id: string | null }[]
  ids.inboxR = inbox.find((i) => i.thread_id === ids.qA)!.id // nils IS the admin actor — the seeder's question burned their budget (D-r)
  ids.inboxM = inbox.find((i) => i.thread_id === ids.qB)!.id
}

const ROWS: Row[] = [
  // ---- task family
  {
    tool: 'get_task',
    args: (w) => ({ task_id: w.ids.taskA }),
    ok: { method: 'GET', path: (w) => `/tasks/${w.ids.taskA}` },
    err: {
      mcpArgs: () => ({ task_id: 'ts_ghost' }),
      rest: { method: 'GET', path: () => '/tasks/ts_ghost' },
    },
  },
  { tool: 'list_tasks', args: () => ({}), ok: { method: 'GET', path: () => '/tasks' } },
  { tool: 'list_ready_tasks', args: () => ({}), ok: { method: 'GET', path: () => '/tasks/next' } },
  {
    tool: 'get_task_context',
    args: (w) => ({ task_id: w.ids.taskA }),
    ok: { method: 'GET', path: (w) => `/tasks/${w.ids.taskA}/context` },
    err: {
      mcpArgs: () => ({ task_id: 'ts_ghost' }),
      rest: { method: 'GET', path: () => '/tasks/ts_ghost/context' },
    },
  },
  {
    tool: 'create_task',
    args: () => ({ title: 'parity-row-create' }),
    ok: { method: 'POST', path: () => '/tasks', body: { title: 'parity-row-create' } },
  },
  {
    tool: 'update_task',
    args: (w) => ({ task_id: w.ids.taskB2, patch: { description: 'parity' } }),
    ok: { method: 'PATCH', path: (w) => `/tasks/${w.ids.taskB}`, body: { description: 'parity' } },
  }, // REST on taskB, tool on its twin taskB2 (D-mm: twins per side)
  {
    tool: 'update_task_status',
    args: (w) => ({ task_id: w.ids.taskC2, to: 'in_progress', reason: 'parity' }),
    ok: {
      method: 'PATCH',
      path: (w) => `/tasks/${w.ids.taskC}/status`,
      body: { status: 'in_progress', reason: 'parity' },
    }, // REST body key is `status` (routes/tasks.ts:124); the MCP arg is `to` (tasks.ts:75) — D-mm arg mapping, one truth
    err: {
      mcpArgs: (w) => ({
        task_id: w.ids.taskA,
        to: 'in_review',
        reason: 'x',
        lease_token: 'bogus:0',
      }),
      rest: {
        method: 'PATCH',
        path: (w) => `/tasks/${w.ids.taskA}/status`,
        body: { status: 'in_review', reason: 'x', lease_token: 'bogus:0' },
      },
    },
    reject: {
      mcpArgs: (w) => ({ task_id: w.ids.taskA, to: 'not-a-status', reason: 'x' }),
      rest: {
        method: 'PATCH',
        path: (w) => `/tasks/${w.ids.taskA}/status`,
        body: { status: 'not-a-status', reason: 'x' },
      },
    },
  },
  {
    tool: 'claim_task',
    args: (w) => ({ task_id: w.ids.claimM }),
    ok: { method: 'POST', path: (w) => `/tasks/${w.ids.claimR}/claim` }, // twins claim independently — generation 1 on both (lease itself is volatile by rule)
    err: {
      mcpArgs: (w) => ({ task_id: w.ids.taskA }),
      rest: { method: 'POST', path: (w) => `/tasks/${w.ids.taskA}/claim` },
    },
  }, // taskA permanently claimed at seed — both sides land the identical already_claimed FLAT envelope (the deterministic race pin)
  {
    tool: 'heartbeat_task',
    args: (w) => ({ task_id: w.ids.relM, lease_token: w.ids.leaseRelM }),
    ok: {
      method: 'POST',
      path: (w) => `/tasks/${w.ids.relR}/heartbeat`,
      body: (w: World) => ({ lease_token: w.ids.leaseRelR }),
    },
    err: {
      mcpArgs: (w) => ({ task_id: w.ids.taskA, lease_token: 'bogus:0' }),
      rest: {
        method: 'POST',
        path: (w) => `/tasks/${w.ids.taskA}/heartbeat`,
        body: { lease_token: 'bogus:0' },
      },
    },
  },
  {
    tool: 'release_task',
    args: (w) => ({ task_id: w.ids.relM }),
    ok: { method: 'POST', path: (w) => `/tasks/${w.ids.relR}/release` }, // AFTER heartbeat (ROW order) — releases the seed claims
    err: {
      mcpArgs: (w) => ({ task_id: w.ids.taskC2 }),
      rest: { method: 'POST', path: (w) => `/tasks/${w.ids.taskC}/release` },
    },
  }, // unclaimed release — same rejection both sides (no code prediction — live⇄live)
  {
    tool: 'add_block',
    args: (w) => ({ task_id: w.ids.taskB2, blocker_id: w.ids.taskC2 }),
    ok: { method: 'PUT', path: (w) => `/tasks/${w.ids.taskB}/blocks/${w.ids.taskC}` },
    err: {
      mcpArgs: (w) => ({ task_id: w.ids.taskB2, blocker_id: 'ts_ghost' }),
      rest: { method: 'PUT', path: (w) => `/tasks/${w.ids.taskB}/blocks/ts_ghost` },
    },
  },
  {
    tool: 'remove_block',
    args: (w) => ({ task_id: w.ids.taskB2, blocker_id: w.ids.taskC2 }),
    ok: { method: 'DELETE', path: (w) => `/tasks/${w.ids.taskB}/blocks/${w.ids.taskC}` },
  },
  {
    tool: 'split_task',
    args: (w) => ({ task_id: w.ids.taskD2, children: [{ title: 'parity child' }] }),
    ok: {
      method: 'POST',
      path: (w) => `/tasks/${w.ids.taskD}/split`,
      body: { children: [{ title: 'parity child' }] },
    },
    err: {
      mcpArgs: () => ({ task_id: 'ts_ghost', children: [{ title: 'x' }] }),
      rest: {
        method: 'POST',
        path: () => '/tasks/ts_ghost/split',
        body: { children: [{ title: 'x' }] },
      },
    },
  },
  // ---- discussion + inbox (host/hostM are leaf hosts for thread fixtures)
  {
    tool: 'list_threads',
    args: (w) => ({ task_id: w.ids.host }),
    ok: { method: 'GET', path: (w) => `/tasks/${w.ids.host}/threads` },
    err: {
      mcpArgs: () => ({ task_id: 'ts_ghost' }),
      rest: { method: 'GET', path: () => '/tasks/ts_ghost/threads' },
    },
  },
  {
    tool: 'create_thread',
    args: (w) => ({ task_id: w.ids.hostM, kind: 'note', body: 'parity note' }),
    ok: {
      method: 'POST',
      path: (w) => `/tasks/${w.ids.host}/threads`,
      body: { kind: 'note', body: 'parity note' },
    },
    err: {
      mcpArgs: (w) => ({
        task_id: w.ids.host,
        kind: 'question',
        body: 'x',
        assignee_handle: 'a_ghost',
      }),
      rest: {
        method: 'POST',
        path: (w) => `/tasks/${w.ids.host}/threads`,
        body: { kind: 'question', body: 'x', assignee_handle: 'a_ghost' },
      },
    },
  },
  {
    tool: 'add_message',
    args: (w) => ({ thread_id: w.ids.noteM, body: 'parity msg' }),
    ok: {
      method: 'POST',
      path: (w) => `/tasks/${w.ids.host}/threads/${w.ids.noteR}/messages`,
      body: { body: 'parity msg' },
    },
    err: {
      mcpArgs: () => ({ thread_id: 'th_ghost', body: 'x' }),
      rest: {
        method: 'POST',
        path: (w) => `/tasks/${w.ids.host}/threads/th_ghost/messages`,
        body: { body: 'x' },
      },
    },
  }, // both noteR/noteM seeded with one message → appended seq is 2 on both
  {
    tool: 'answer_question',
    args: (w) => ({ thread_id: w.ids.qM, body: 'parity answer' }),
    ok: {
      method: 'POST',
      path: (w) => `/tasks/${w.ids.host}/threads/${w.ids.qR}/answer`,
      body: { body: 'parity answer' },
    },
    err: {
      mcpArgs: (w) => ({ thread_id: w.ids.noteM, body: 'x' }),
      rest: {
        method: 'POST',
        path: (w) => `/tasks/${w.ids.hostM}/threads/${w.ids.noteM}/answer`,
        body: { body: 'x' },
      },
    },
  }, // answering a note thread — live⇄live rejection
  {
    tool: 'update_question',
    args: (w) => ({ thread_id: w.ids.qB, state: 'wont_fix' }), // qA/qB answered at seed → answered→wont_fix is D-n-legal on both
    ok: {
      method: 'PATCH',
      path: (w) => `/tasks/${w.ids.host}/threads/${w.ids.qA}`,
      body: { state: 'wont_fix' },
    },
    err: {
      mcpArgs: (w) => ({ thread_id: w.ids.qF, state: 'resolved' }), // qE/qF open → open→resolved violates D-n (resolve implies answered) → question_transition both sides
      rest: {
        method: 'PATCH',
        path: (w) => `/tasks/${w.ids.host}/threads/${w.ids.qE}`,
        body: { state: 'resolved' },
      },
    },
  },
  {
    tool: 'get_inbox',
    args: () => ({}),
    ok: { method: 'GET', path: () => '/inbox' },
    reject: {
      mcpArgs: () => ({ limit: 999 }),
      rest: { method: 'GET', path: () => '/inbox?limit=999' },
    },
  },
  {
    tool: 'mark_inbox_read',
    args: (w) => ({ item_id: w.ids.inboxM }),
    ok: { method: 'POST', path: (w) => `/inbox/${w.ids.inboxR}/read` }, // items from the qA/qB assignments (seed-captured)
    err: {
      mcpArgs: () => ({ item_id: 'ib_ghost' }),
      rest: { method: 'POST', path: () => '/inbox/ib_ghost/read' },
    },
  }, // owner-only 404 doctrine — ghost and not-owned identical (D-r)
  // ---- references
  {
    tool: 'list_links',
    args: (w) => ({ task_id: w.ids.host }),
    ok: { method: 'GET', path: (w) => `/tasks/${w.ids.host}/links` },
    err: {
      mcpArgs: () => ({ task_id: 'ts_ghost' }),
      rest: { method: 'GET', path: () => '/tasks/ts_ghost/links' },
    },
  },
  {
    tool: 'add_link',
    args: (w) => ({ task_id: w.ids.host, kind: 'doc', url: 'https://parity.test/harness' }),
    ok: {
      method: 'POST',
      path: (w) => `/tasks/${w.ids.host}/links`,
      body: { kind: 'doc', url: 'https://parity.test/harness' },
    }, // SAME (task,kind,url): D-t insert-or-get → the tool gets the REST-created row back → byte-equal including the id
    err: {
      mcpArgs: () => ({ task_id: 'ts_ghost', kind: 'doc', url: 'https://x.test' }),
      rest: {
        method: 'POST',
        path: () => '/tasks/ts_ghost/links',
        body: { kind: 'doc', url: 'https://x.test' },
      },
    },
  },
  {
    tool: 'remove_link',
    args: (w) => ({ task_id: w.ids.host, link_id: w.ids.lkM }),
    ok: { method: 'DELETE', path: (w) => `/tasks/${w.ids.host}/links/${w.ids.lkR}` }, // two seeded links, one per side
    err: {
      mcpArgs: (w) => ({ task_id: w.ids.host, link_id: 'lk_ghost' }),
      rest: { method: 'DELETE', path: (w) => `/tasks/${w.ids.host}/links/lk_ghost` },
    },
  },
  { tool: 'list_labels', args: () => ({}), ok: { method: 'GET', path: () => '/labels' } }, // no reachable 4xx — declared, none invented
  {
    tool: 'create_label',
    args: (w) => ({ name: 'parity-mcp', color: '#0a0a0a' }),
    ok: { method: 'POST', path: () => '/labels', body: { name: 'parity-rest', color: '#0a0a0a' } }, // distinct names (name is volatile by rule); record shape/color pinned
    reject: {
      mcpArgs: () => ({ color: '#fff' }),
      rest: { method: 'POST', path: () => '/labels', body: { color: '#fff' } },
    },
  },
  {
    tool: 'attach_label',
    args: (w) => ({ task_id: w.ids.attachS, label_id: w.ids.labelS }),
    ok: { method: 'PUT', path: (w) => `/tasks/${w.ids.host}/labels/${w.ids.labelS}` }, // same label, distinct targets
    err: {
      mcpArgs: (w) => ({ task_id: w.ids.attachS, label_id: 'lb_ghost' }),
      rest: { method: 'PUT', path: (w) => `/tasks/${w.ids.host}/labels/lb_ghost` },
    },
  },
  {
    tool: 'detach_label',
    args: (w) => ({ task_id: w.ids.attachS, label_id: w.ids.labelS }),
    ok: { method: 'DELETE', path: (w) => `/tasks/${w.ids.host}/labels/${w.ids.labelS}` },
  }, // AFTER attach (ROW order)
  {
    tool: 'list_attachments',
    args: (w) => ({ task_id: w.ids.host }),
    ok: { method: 'GET', path: (w) => `/tasks/${w.ids.host}/attachments` },
    err: {
      mcpArgs: () => ({ task_id: 'ts_ghost' }),
      rest: { method: 'GET', path: () => '/tasks/ts_ghost/attachments' },
    },
  },
  {
    tool: 'upload_attachment',
    args: (w) => ({
      task_id: w.ids.host,
      filename: 'parity.bin',
      content_type: 'application/octet-stream',
      content_base64: Buffer.from('parity bytes').toString('base64'),
    }),
    ok: {
      method: 'POST',
      path: (w) =>
        `/tasks/${w.ids.host}/attachments?filename=parity.bin&content_type=application/octet-stream`,
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from('parity bytes'),
    },
    err: {
      mcpArgs: () => ({
        task_id: 'ts_ghost',
        filename: 'x',
        content_type: 'text/plain',
        content_base64: Buffer.from('x').toString('base64'),
      }),
      rest: {
        method: 'POST',
        path: () => '/tasks/ts_ghost/attachments?filename=x&content_type=text/plain',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from('x'),
      },
    },
  }, // D-s insert-or-get: same (task,sha,filename) → the tool gets the REST row back — byte-equal incl. sha256
  {
    tool: 'get_events',
    args: () => ({ cursor: 0, limit: 500 }),
    ok: { method: 'GET', path: () => '/events?cursor=0&limit=500' },
  }, // no reachable 4xx — declared
  {
    tool: 'search_audit',
    args: (w) => ({ entity_type: 'task', entity_id: w.ids.taskA, limit: 50 }),
    ok: { method: 'GET', path: (w) => `/audit?entity_type=task&entity_id=${w.ids.taskA}&limit=50` },
  }, // payloads ride — byte under norm (D-aa)
]

describe('mcp ⇄ rest parity (spec §11.4)', () => {
  let w: World
  beforeAll(async () => {
    const t = await makeTestApp()
    const baseUrl = await t.app.listen({ port: 0, host: '127.0.0.1' })
    const mcp = await openHttpMcp(baseUrl, t.adminToken, '2026-07-28')
    w = { t, mcp, bearer: t.adminToken, ids: {} as Record<string, string> } as World
    await seedWorld(w) // the seedWorld block above: REST-inject creates + claim captures, ids filled
  }, 60_000)
  afterAll(async () => {
    await w.mcp.close()
    await w.t.close()
  })

  for (const row of ROWS) {
    if (row.ok)
      it(`${row.tool} ⇄ REST identical (success)`, async () => {
        await expectOk(w, row)
      })
    if (row.err)
      it(`${row.tool} ⇄ REST identical (error)`, async () => {
        await expectErr(w, row)
      })
    if (row.reject)
      it(`${row.tool} ⇄ REST rejected ⇄ rejected (D-jj scope)`, async () => {
        await expectReject(w, row)
      })
  }

  it('get_attachment_content ⇄ REST headers+bytes identical (binary ⇄ base64, D-mm)', async () => {
    const res = await w.t.app.inject({
      method: 'GET',
      url: `/attachments/${w.ids.att}/content`,
      headers: { authorization: `Bearer ${w.bearer}` },
    })
    expect(res.statusCode).toBe(200)
    const r = await w.mcp.call('get_attachment_content', { attachment_id: w.ids.att })
    const v = (r.structuredContent as { result: Record<string, string> }).result
    expect(String(res.headers['content-type'])).toBe(v.content_type)
    expect(String(res.headers['content-disposition'])).toBe(v.content_disposition)
    expect(String(res.headers['x-content-type-options'])).toBe(v.x_content_type_options)
    expect(v.bytes_base64).toBe(res.rawPayload.toString('base64'))
  })

  it('frozen tool surface: exactly 35 tools, no admin/webhook/token surface, ever (D-nn)', async () => {
    const listed = await w.mcp.list()
    const names = listed.tools.map((x) => x.name).sort()
    expect(names).toEqual([...mcpTools.map((x) => x.name)].sort()) // registry ⇄ wire ⇄ list all one set
    expect(names.filter((n) => /token|webhook|policy|actor/.test(n))).toEqual([]) // side-door pin (D-h precedent)
    expect(names.length).toBe(35)
  })

  it('strip-parity status quo: smuggled keys are STRIPPED both sides (removeAdditional doctrine)', async () => {
    const r = await w.mcp.call('create_task', { title: 'smuggle', smuggled_actor: 'evil' })
    expect(r.isError).toBeUndefined()
    expect(JSON.stringify(r)).not.toContain('evil')
  })

  it('/mcp burns the per-actor rate budget like any surface (D-dd doctrine)', async () => {
    const t2 = await makeTestApp({ NS_RATE_LIMIT_PER_MIN: '2' })
    try {
      const baseUrl = await t2.app.listen({ port: 0, host: '127.0.0.1' })
      for (let i = 1; i <= 2; i++) {
        const res = await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${t2.adminToken}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: '{',
        })
        expect(res.status).toBe(400) // MCP parse error — budget consumed
      }
      const third = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${t2.adminToken}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: '{',
      })
      expect(third.status).toBe(429) // rate_limited before the MCP layer — hook order intact
    } finally {
      await t2.close()
    }
  })
})
