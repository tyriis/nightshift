import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeTestApp } from '#root/testing/test-app'

// acceptance (spec §11.2 "webhook delivery + event cursor replay") — the Plan C story,
// on the REAL surface: real fastify, real sqlite, real node:http receiver. One receiver
// server serves BOTH runner callbacks; a per-path queue programs responses.

type Received = { body: string; sig?: string }

describe('acceptance — events & webhooks (spec §6.8/§11): a runner wakes on its work, not on history', () => {
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` })
  let receiver: ReturnType<typeof createServer>
  let inbox: Record<string, Received[]>
  let failOnce: Record<string, boolean>
  let base: string

  beforeAll(async () => {
    inbox = {}
    failOnce = {}
    receiver = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const path = req.url ?? ''
        const key = path.slice(1)
        const body = Buffer.concat(chunks).toString('utf8')
        ;(inbox[key] ??= []).push({
          body,
          sig: req.headers['x-nightshift-signature'] as string | undefined,
        })
        if (failOnce[key]) {
          failOnce[key] = false
          res.writeHead(503).end()
          return
        }
        res.writeHead(200).end()
      })
    })
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise((r) => receiver.close(r))
  })

  it('full story: register, tail, race, wake, retry', async () => {
    const t = await makeTestApp()
    const mkAgent = async (handle: string) => {
      const a = await t.app.inject({
        method: 'POST',
        url: '/admin/actors',
        headers: bearer(t.adminToken),
        payload: { kind: 'agent', handle, display_name: handle },
      })
      const tok = await t.app.inject({
        method: 'POST',
        url: `/admin/actors/${a.json().id}/tokens`,
        headers: bearer(t.adminToken),
        payload: { label: 'story' },
      })
      return { id: a.json().id as string, token: tok.json().raw_token as string }
    }

    // §6.8.1 human files work; a runner registers its wake path AFTER the backlog exists
    const todoTask = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: bearer(t.adminToken),
      payload: { title: 'wake-story task', status: 'todo' },
    })
    expect(todoTask.statusCode).toBe(201)
    const hermes = await mkAgent('hermes-evt')
    const wh = await t.app.inject({
      method: 'POST',
      url: '/admin/webhooks',
      headers: bearer(t.adminToken),
      payload: { agent_id: hermes.id, url: `${base}/hermes` },
    })
    expect(wh.statusCode).toBe(201)
    const hermesSecret = wh.json().secret as string
    const watermark = wh.json().delivered_cursor as number

    // §6.8.2 the cursor feed serves the backlog the webhook refused to replay
    const feed = (
      await t.app.inject({
        method: 'GET',
        url: `/events?cursor=0&limit=500`,
        headers: bearer(t.adminToken),
      })
    ).json()
    expect(feed.length).toBeGreaterThanOrEqual(2) // lower bound only (binding)
    expect(feed.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(['task_created', 'webhook_created'])
    )
    for (let i = 1; i < feed.length; i++) expect(feed[i].cursor).toBeGreaterThan(feed[i - 1].cursor)
    expect(feed[feed.length - 1].cursor).toBe(watermark) // the watermark IS the feed head

    // §6.8.3 a race: hermes wins, bilbo loses and gets the inbox copy (D-cc) — and the
    // loser's claim_conflict must NOT spam the webhook with undeliverable history
    const bilbo = await mkAgent('bilbo-evt')
    const claimed = await t.app.inject({
      method: 'POST',
      url: `/tasks/${todoTask.json().id}/claim`,
      headers: bearer(hermes.token),
    })
    expect(claimed.statusCode).toBe(200)
    const lost = await t.app.inject({
      method: 'POST',
      url: `/tasks/${todoTask.json().id}/claim`,
      headers: bearer(bilbo.token),
    })
    expect(lost.statusCode).toBe(409)
    expect(lost.json().code).toBe('already_claimed')
    const loserInbox = (
      await t.app.inject({ method: 'GET', url: '/inbox', headers: bearer(bilbo.token) })
    ).json()
    expect(loserInbox.map((i: { kind: string }) => i.kind)).toEqual(['claim_conflict']) // hermes-1 claim ⇒ bilbo's copy, grep-exact kind

    // §6.8.4 the loop wakes hermes for everything AFTER its registration anchor
    await t.deps.deliveryLoop.tick(1_000)
    const received = inbox['hermes'] ?? []
    const events = received.map(
      (r) => JSON.parse(r.body) as { event: string; task_id: string | null; cursor: number }
    )
    // all-events posture (D-bb): every audit-worthy row past the checkpoint wakes every
    // runner — bilbo's registration audits ride too; filtering is deferred
    expect(events.map((e) => e.event)).toEqual(['actor_created', 'token_created', 'claim_acquired'])
    const claimEvent = events.find((e) => e.event === 'claim_acquired')!
    expect(claimEvent.task_id).toBe(todoTask.json().id)
    expect(claimEvent.cursor).toBeGreaterThan(watermark)
    for (const r of received) {
      expect(r.sig).toBe(
        `sha256=${createHmac('sha256', hermesSecret).update(r.body).digest('hex')}`
      )
    }

    // §6.8.5 best-effort retry: a dead-first-try callback parks, then drains the SAME
    // event — at-least-once, in action
    failOnce['bob'] = true
    const bob = await mkAgent('bob-evt')
    const whBob = await t.app.inject({
      method: 'POST',
      url: '/admin/webhooks',
      headers: bearer(t.adminToken),
      payload: { agent_id: bob.id, url: `${base}/bob` },
    })
    const bobWatermark = whBob.json().delivered_cursor as number
    const bobId = whBob.json().id as string
    const bobTask = await t.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: bearer(bob.token),
      payload: { title: 'bobs own', status: 'todo' },
    })
    await t.deps.deliveryLoop.tick(2_000) // try + 503 ⇒ parked until 2_000 + 1_000·2^1
    expect((await t.deps.webhooksRoot.listDue(3_999)).map((w) => w.id)).not.toContain(bobId) // parked
    expect((await t.deps.webhooksRoot.listDue(4_000)).map((w) => w.id)).toContain(bobId) // due again at the park horizon
    await t.deps.deliveryLoop.tick(4_000) // retry ⇒ ACK
    const bobPosts = (inbox['bob'] ?? []).map(
      (r) => JSON.parse(r.body) as { event: string; task_id: string | null; cursor: number }
    )
    expect(bobPosts.map((e) => e.cursor)).toEqual([bobWatermark + 1, bobWatermark + 1]) // failed attempt + ACK share ONE cursor — the consumer dedupes on it
    expect(bobPosts[0].event).toBe('task_created')
    expect(bobPosts[0].task_id).toBe(bobTask.json().id)
    expect((await t.deps.webhooksRoot.find(bobId))?.delivered_cursor).toBe(bobWatermark + 1)

    // §6.8.6 tail-to-head: an agent caught up receives nothing more
    const head = (
      await t.app.inject({
        method: 'GET',
        url: `/events?cursor=0&limit=500`,
        headers: bearer(t.adminToken),
      })
    ).json()
    const tail = (
      await t.app.inject({
        method: 'GET',
        url: `/events?cursor=${head[head.length - 1].cursor}`,
        headers: bearer(t.adminToken),
      })
    ).json()
    expect(tail).toEqual([])
    await t.close()
  })
})
