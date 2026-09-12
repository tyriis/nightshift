<script lang="ts">
  // Admin (§8-4). The SERVER is the gate (requireHuman+requireAdmin on every op);
  // this panel is the UI courtesy: /auth/me role !== 'admin' ⇒ honest not-admin
  // panel, NO data fetch. Raw token / webhook secret: shown exactly once (D-ff/§5)
  // with an acknowledge button — after acknowledge the value is dropped here too.
  import { api, ApiError, json } from '$lib/api'
  import type {
    ActorDto,
    ActorMe,
    AllowlistDto,
    AuditEntryDto,
    LabelDto,
    PolicyDto,
    TokenDto,
    WebhookDto,
    WebhookWithSecretDto,
  } from '$lib/types'

  let me = $state<ActorMe | null>(null)
  let err = $state('')

  function show(e: unknown): void {
    err = e instanceof ApiError ? `${e.code}: ${e.detail}` : String(e)
  }
  async function guard(p: Promise<unknown>): Promise<void> {
    try {
      await p
    } catch (e) {
      show(e)
    }
  }

  // ---- data ----
  let actors = $state<ActorDto[]>([])
  let labels = $state<LabelDto[]>([])
  let webhooks = $state<WebhookDto[]>([])
  let allowlist = $state<AllowlistDto[]>([])
  let audit = $state<AuditEntryDto[]>([])
  const policy = $state<Record<string, PolicyDto | null>>({}) // review_gate | oidc_provisioning

  async function reload(): Promise<void> {
    await guard(
      (async () => {
        actors = await api<ActorDto[]>('/admin/actors')
        labels = await api<LabelDto[]>('/labels')
        webhooks = await api<WebhookDto[]>('/admin/webhooks')
        allowlist = await api<AllowlistDto[]>('/admin/allowlist')
        policy['review_gate'] = await api<PolicyDto>('/admin/policy/review_gate')
        policy['oidc_provisioning'] = await api<PolicyDto>('/admin/policy/oidc_provisioning')
      })()
    )
  }

  $effect(() => {
    void (async () => {
      try {
        me = await api<ActorMe>('/auth/me') // 401 ⇒ api() bounces to login (plan posture)
        if (me.role === 'admin') await reload() // members/agents: no data fetch — the SERVER gates anyway
      } catch (e) {
        show(e)
      }
    })()
  })

  // ---- one-time secrets (token raw / webhook secret): shown until acknowledged ----
  let oneTime = $state<{ label: string; value: string } | null>(null)
  function acknowledge(): void {
    oneTime = null
  }

  // ---- actors + tokens (admin.ts: no token LIST route exists — freshly issued
  // tokens live here until acknowledged; revoking older ids happens at the server) ----
  let newKind = $state<'agent' | 'human'>('agent')
  let newHandle = $state('')
  let newDisplay = $state('')
  let newDescription = $state('')
  let newRole = $state<'member' | 'admin'>('member')
  async function createActor(): Promise<void> {
    if (!newHandle.trim() || !newDisplay.trim()) return
    const body: Record<string, unknown> = {
      kind: newKind,
      handle: newHandle.trim(),
      display_name: newDisplay.trim(),
      description: newDescription,
    }
    if (newKind === 'human') body['role'] = newRole
    await guard(
      (async () => {
        await api('/admin/actors', json('POST', body))
        newHandle = ''
        newDisplay = ''
        newDescription = ''
        await reload()
      })()
    )
  }
  // PATCH /admin/actors/:id — { role } only; server gates admin + last-admin demote
  async function setRole(actorId: string, role: 'admin' | 'member'): Promise<void> {
    await guard(
      (async () => {
        await api(`/admin/actors/${actorId}`, json('PATCH', { role }))
        await reload()
      })()
    )
  }
  const tokenLabels = $state<Record<string, string>>({})
  async function issueToken(actorId: string): Promise<void> {
    const label = (tokenLabels[actorId] ?? '').trim()
    if (!label) return
    await guard(
      (async () => {
        const issued = await api<TokenDto>(
          `/admin/actors/${actorId}/tokens`,
          json('POST', { label })
        )
        oneTime = { label: `token for ${actorId} (${label})`, value: issued.raw_token }
        tokenLabels[actorId] = ''
      })()
    )
  }
  async function revokeToken(tokenId: string): Promise<void> {
    await guard(api(`/admin/tokens/${tokenId}/revoke`, { method: 'POST' }))
  }

  // ---- labels (catalog create; ATTACH lives on the task detail view) ----
  let newLabelName = $state('')
  let newLabelColor = $state('')
  async function createLabel(): Promise<void> {
    if (!newLabelName.trim()) return
    await guard(
      (async () => {
        await api('/labels', json('POST', { name: newLabelName.trim(), color: newLabelColor }))
        newLabelName = ''
        newLabelColor = ''
        await reload()
      })()
    )
  }

  // ---- policy flags (PUT /admin/policy/:key; enum per key: review_gate on|off,
  // oidc_provisioning off|allowlist — the route enum carries all three values) ----
  async function setPolicy(key: string, value: string): Promise<void> {
    await guard(
      (async () => {
        policy[key] = await api<PolicyDto>(`/admin/policy/${key}`, json('PUT', { value }))
      })()
    )
  }

  // ---- webhooks (register/rotate secrets shown once) ----
  let hookAgent = $state('')
  let hookUrl = $state('')
  async function registerWebhook(): Promise<void> {
    if (!hookAgent.trim() || !hookUrl.trim()) return
    await guard(
      (async () => {
        const created = await api<WebhookWithSecretDto>(
          '/admin/webhooks',
          json('POST', { agent_id: hookAgent.trim(), url: hookUrl.trim() })
        )
        oneTime = { label: `webhook secret for ${created.actor_id}`, value: created.secret }
        hookAgent = ''
        hookUrl = ''
        await reload()
      })()
    )
  }
  async function rotateWebhook(id: string): Promise<void> {
    await guard(
      (async () => {
        const rotated = await api<WebhookWithSecretDto>(`/admin/webhooks/${id}/rotate-secret`, {
          method: 'POST',
        })
        oneTime = { label: `rotated webhook secret ${id}`, value: rotated.secret }
        await reload()
      })()
    )
  }
  async function deleteWebhook(id: string): Promise<void> {
    await guard(
      (async () => {
        await api(`/admin/webhooks/${id}`, { method: 'DELETE' })
        await reload()
      })()
    )
  }

  // ---- allow-list (D-tt) ----
  let allowEmail = $state('')
  async function addAllow(): Promise<void> {
    if (!allowEmail.trim()) return
    await guard(
      (async () => {
        await api('/admin/allowlist', json('POST', { email: allowEmail.trim() }))
        allowEmail = ''
        await reload()
      })()
    )
  }
  async function removeAllow(email: string): Promise<void> {
    await guard(
      (async () => {
        await api(`/admin/allowlist/${encodeURIComponent(email)}`, { method: 'DELETE' })
        await reload()
      })()
    )
  }

  // ---- audit search (GET /audit query — routes/audit.ts) ----
  let auditType = $state('')
  let auditId = $state('')
  async function searchAudit(): Promise<void> {
    const q = new URLSearchParams()
    if (auditType.trim()) q.set('entity_type', auditType.trim())
    if (auditId.trim()) q.set('entity_id', auditId.trim())
    await guard(
      (async () => {
        audit = await api<AuditEntryDto[]>(`/audit${q.size > 0 ? `?${q}` : ''}`)
      })()
    )
  }
</script>

{#if err}<p class="error">{err}</p>{/if}
{#if me && me.role !== 'admin'}
  <!-- honest not-admin panel (§8-4): no data fetched — the SERVER is the gate -->
  <h1>admin</h1>
  <p>admins only — signed in as {me.display_name} ({me.role ?? 'no role'}).</p>
{:else if me}
  <h1>admin</h1>

  {#if oneTime}
    <section class="one-time">
      <h3>{oneTime.label} — shown ONCE</h3>
      <pre class="secret">{oneTime.value}</pre>
      <button onclick={acknowledge}>I have saved it — dismiss</button>
    </section>
  {/if}

  <section>
    <h3>actors</h3>
    <ul>
      {#each actors as a (a.id)}
        <li>
          <span class="pill">{a.kind}</span>
          {#if a.role}<span class="pill">{a.role}</span>{/if}
          <a href="/ui/inbox">{a.handle}</a> ({a.display_name})
          {#if a.kind === 'human'}
            <button onclick={() => void setRole(a.id, a.role === 'admin' ? 'member' : 'admin')}>
              {a.role === 'admin' ? 'Demote to member' : 'Promote to admin'}
            </button>
          {/if}
          <form
            class="file-task"
            onsubmit={(e) => {
              e.preventDefault()
              void issueToken(a.id)
            }}
          >
            <input placeholder="token label" bind:value={tokenLabels[a.id]} />
            <button type="submit">issue token</button>
          </form>
        </li>
      {/each}
    </ul>
    <form
      class="file-task"
      onsubmit={(e) => {
        e.preventDefault()
        void createActor()
      }}
    >
      <select bind:value={newKind}>
        <option value="agent">agent</option>
        <option value="human">human</option>
      </select>
      <input placeholder="handle" bind:value={newHandle} />
      <input placeholder="display name" bind:value={newDisplay} />
      <input placeholder="description" bind:value={newDescription} />
      {#if newKind === 'human'}
        <select bind:value={newRole}>
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
      {/if}
      <button type="submit">create actor</button>
    </form>
  </section>

  <section>
    <h3>policy flags</h3>
    <div class="chips">
      review_gate:
      {#each ['on', 'off'] as v (v)}
        <button
          class="pill"
          aria-pressed={policy['review_gate']?.value === v}
          onclick={() => void setPolicy('review_gate', v)}>{v}</button
        >
      {/each}
    </div>
    <div class="chips">
      oidc_provisioning:
      {#each ['off', 'allowlist'] as v (v)}
        <button
          class="pill"
          aria-pressed={policy['oidc_provisioning']?.value === v}
          onclick={() => void setPolicy('oidc_provisioning', v)}>{v}</button
        >
      {/each}
    </div>
  </section>

  <section>
    <h3>labels</h3>
    <ul>
      {#each labels as l (l.id)}
        <li><span class="chip">{l.name}</span> {l.color}</li>
      {/each}
    </ul>
    <form
      class="file-task"
      onsubmit={(e) => {
        e.preventDefault()
        void createLabel()
      }}
    >
      <input placeholder="name" bind:value={newLabelName} />
      <input placeholder="color (#hex)" bind:value={newLabelColor} />
      <button type="submit">create label (attach on the task view)</button>
    </form>
  </section>

  <section>
    <h3>webhooks</h3>
    <ul>
      {#each webhooks as w (w.id)}
        <li>
          {w.actor_id} → {w.url} <span class="pill">cursor {w.delivered_cursor}</span>
          <button onclick={() => void rotateWebhook(w.id)}>rotate secret</button>
          <button onclick={() => void deleteWebhook(w.id)}>delete</button>
        </li>
      {/each}
    </ul>
    <form
      class="file-task"
      onsubmit={(e) => {
        e.preventDefault()
        void registerWebhook()
      }}
    >
      <input placeholder="agent actor id" bind:value={hookAgent} />
      <input placeholder="https://…" bind:value={hookUrl} />
      <button type="submit">register (secret shown once)</button>
    </form>
  </section>

  <section>
    <h3>allow-list</h3>
    <ul>
      {#each allowlist as a (a.email)}
        <li>
          {a.email} (by {a.added_by})
          <button onclick={() => void removeAllow(a.email)}>remove</button>
        </li>
      {/each}
    </ul>
    <form
      class="file-task"
      onsubmit={(e) => {
        e.preventDefault()
        void addAllow()
      }}
    >
      <input placeholder="email@company.example" bind:value={allowEmail} />
      <button type="submit">add email</button>
    </form>
  </section>

  <section>
    <h3>audit search</h3>
    <form
      class="file-task"
      onsubmit={(e) => {
        e.preventDefault()
        void searchAudit()
      }}
    >
      <input placeholder="entity_type (e.g. task)" bind:value={auditType} />
      <input placeholder="entity_id" bind:value={auditId} />
      <button type="submit">search</button>
    </form>
    <ul class="activity">
      {#each audit as a (a.id)}
        <li>
          {a.created_at} <strong>{a.action}</strong>
          {a.entity_type}#{a.entity_id}
          {#if a.reason}— {a.reason}{/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}
