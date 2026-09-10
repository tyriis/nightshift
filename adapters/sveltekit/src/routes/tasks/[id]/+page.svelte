<script lang="ts">
  // Task detail (§8-2): header controls + the SIX tabs — conversation, children,
  // dependencies, attachments+links, activity, context. Every call rides api();
  // every field shown is transcribed from a shipped route (contract-transcription
  // duty) — where a read route is absent, this view shows LESS, stated in place.
  import { page } from '$app/state'
  import { api, ApiError, json } from '$lib/api'
  import TaskTree from '$lib/TaskTree.svelte'
  import type {
    AttachmentDto,
    AuditEntryDto,
    ContextBundleDto,
    LabelDto,
    LinkDto,
    TaskDto,
    ThreadWithMessagesDto,
  } from '$lib/types'

  const STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled'] as const
  const TABS = [
    'conversation',
    'children',
    'dependencies',
    'attachments+links',
    'activity',
    'context',
  ] as const
  type Tab = (typeof TABS)[number]

  let task = $state<TaskDto | null>(null)
  let allTasks = $state<TaskDto[]>([])
  let tab = $state<Tab>('conversation')
  let err = $state('')

  // tab data (loaded per activation; the header loads with the id)
  let threads = $state<ThreadWithMessagesDto[]>([])
  let context = $state<ContextBundleDto | null>(null)
  let links = $state<LinkDto[]>([])
  let attachments = $state<AttachmentDto[]>([])
  let audit = $state<AuditEntryDto[]>([])
  let labels = $state<LabelDto[]>([])

  const id = () => page.params.id ?? ''

  function show(e: unknown): void {
    err = e instanceof ApiError ? `${e.code}: ${e.detail}` : String(e)
  }

  const childrenOf = (parentId: string): TaskDto[] =>
    allTasks.filter((t) => t.parent_id === parentId)

  async function loadHeader(): Promise<void> {
    task = await api<TaskDto>(`/tasks/${id()}`)
  }
  async function loadTab(t: Tab): Promise<void> {
    if (t === 'conversation') threads = await api<ThreadWithMessagesDto[]>(`/tasks/${id()}/threads`)
    if (t === 'children') allTasks = await api<TaskDto[]>('/tasks') // tree built client-side
    if (t === 'dependencies' || t === 'context')
      context = await api<ContextBundleDto>(`/tasks/${id()}/context`)
    if (t === 'attachments+links') {
      links = await api<LinkDto[]>(`/tasks/${id()}/links`)
      attachments = await api<AttachmentDto[]>(`/tasks/${id()}/attachments`)
    }
    if (t === 'activity')
      audit = await api<AuditEntryDto[]>(
        `/audit?entity_type=task&entity_id=${encodeURIComponent(id())}`
      )
  }

  // one effect on (id, tab): SPA navigations between tasks reuse this component —
  // param changes reload, never a stale view
  $effect(() => {
    const tid = page.params.id
    const t = tab
    if (!tid) return
    err = ''
    void (async () => {
      try {
        await loadHeader()
        await loadTab(t)
      } catch (e) {
        show(e)
      }
    })()
  })

  async function mutate(init: RequestInit, path = `/tasks/${id()}`): Promise<void> {
    try {
      await api<TaskDto>(path, init) // mutations answer the fresh flat task DTO
      await loadHeader()
      await loadTab(tab)
    } catch (e) {
      show(e)
    }
  }

  // ---- header controls (PATCH /tasks/{id}/status — reason REQUIRED per route schema)
  let reason = $state('')
  let leaseToken = $state('')
  async function setStatus(status: string): Promise<void> {
    const body: Record<string, unknown> = { status, reason: reason.trim() }
    if (leaseToken.trim()) body.lease_token = leaseToken.trim()
    await mutate(json('PATCH', body), `/tasks/${id()}/status`)
  }
  async function toggleBlocked(): Promise<void> {
    if (task) await mutate(json('PATCH', { blocked_flag: !task.blocked_flag }))
  }
  // assignee is an actor id: the contract has NO general actor-read route for members
  // (GET /admin/actors is admin-role-gated), so the field is typed, not picked.
  let assigneeInput = $state('')
  async function setAssignee(): Promise<void> {
    await mutate(json('PATCH', { assignee_id: assigneeInput.trim() || null }))
  }

  // ---- labels (PUT/DELETE /tasks/{id}/labels/{labelId}; /labels lists the catalog)
  async function loadLabels(): Promise<void> {
    try {
      labels = await api<LabelDto[]>('/labels')
    } catch (e) {
      show(e)
    }
  }
  $effect(() => void loadLabels())
  const labelIdFor = (name: string): string | undefined => labels.find((l) => l.name === name)?.id
  let attachLabelId = $state('')
  async function attachLabel(): Promise<void> {
    if (!attachLabelId) return
    await mutate({ method: 'PUT' }, `/tasks/${id()}/labels/${attachLabelId}`)
    attachLabelId = ''
  }
  async function detachLabel(name: string): Promise<void> {
    const lid = labelIdFor(name)
    if (lid) await mutate({ method: 'DELETE' }, `/tasks/${id()}/labels/${lid}`)
  }

  // ---- conversation (§8-2): note/question threads, messages, question answers
  let newThreadKind = $state<'note' | 'question'>('note')
  let newThreadBody = $state('')
  let comment = $state('')
  const replyDrafts = $state<Record<string, string>>({})
  const answerDrafts = $state<Record<string, string>>({})
  async function createThread(): Promise<void> {
    if (!newThreadBody.trim()) return
    try {
      await api(
        `/tasks/${id()}/threads`,
        json('POST', { kind: newThreadKind, body: newThreadBody.trim() })
      )
      newThreadBody = ''
      await loadTab('conversation')
    } catch (e) {
      show(e)
    }
  }
  // comment box = note-thread creation (§8-2 / Task 9 Step 4)
  async function commentAsNote(): Promise<void> {
    if (!comment.trim()) return
    newThreadKind = 'note'
    newThreadBody = comment.trim()
    comment = ''
    await createThread()
  }
  async function reply(tid: string): Promise<void> {
    const body = (replyDrafts[tid] ?? '').trim()
    if (!body) return
    try {
      await api(`/tasks/${id()}/threads/${tid}/messages`, json('POST', { body }))
      replyDrafts[tid] = ''
      await loadTab('conversation')
    } catch (e) {
      show(e)
    }
  }
  async function answer(tid: string): Promise<void> {
    const body = (answerDrafts[tid] ?? '').trim()
    if (!body) return
    try {
      await api(`/tasks/${id()}/threads/${tid}/answer`, json('POST', { body }))
      answerDrafts[tid] = ''
      await loadTab('conversation')
    } catch (e) {
      show(e)
    }
  }

  // ---- dependencies (add/remove shipped; the READ is the context bundle's
  // `blockers` — UNMET blockers blocking THIS task only. There is no route for the
  // reverse edge ("blocked by me") nor for met blockers: the view shows less — stated.)
  let blockerInput = $state('')
  async function addBlocker(): Promise<void> {
    if (!blockerInput.trim()) return
    await mutate(
      { method: 'PUT' },
      `/tasks/${id()}/blocks/${encodeURIComponent(blockerInput.trim())}`
    )
    blockerInput = ''
  }
  async function removeBlocker(blockerId: string): Promise<void> {
    await mutate({ method: 'DELETE' }, `/tasks/${id()}/blocks/${encodeURIComponent(blockerId)}`)
  }

  // ---- attachments + links (upload is RAW octet-stream, ?filename= required — routes/attachments.ts)
  let uploadFiles: FileList | null = $state(null)
  async function upload(): Promise<void> {
    const f = uploadFiles?.[0]
    if (!f) return
    try {
      await api(
        `/tasks/${id()}/attachments?filename=${encodeURIComponent(f.name)}&content_type=${encodeURIComponent(f.type || 'application/octet-stream')}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: await f.arrayBuffer(),
        }
      )
      uploadFiles = null
      await loadTab('attachments+links')
    } catch (e) {
      show(e)
    }
  }
  let linkKind = $state<'pr' | 'commit' | 'doc' | 'other'>('pr')
  let linkUrl = $state('')
  async function addLink(): Promise<void> {
    if (!linkUrl.trim()) return
    await mutate(json('POST', { kind: linkKind, url: linkUrl.trim() }), `/tasks/${id()}/links`)
    linkUrl = ''
  }
  async function removeLink(linkId: string): Promise<void> {
    await mutate({ method: 'DELETE' }, `/tasks/${id()}/links/${linkId}`)
  }
</script>

{#if err}<p class="error">{err}</p>{/if}

{#if task}
  <header>
    <h1>{task.title}</h1>
    <p>
      <span class="pill">{task.status}</span>
      {#if task.blocked_flag}<span class="pill">blocked ⚑</span>{/if}
      {#each task.labels as l (l)}
        <span class="chip">{l}<button onclick={() => void detachLabel(l)}>×</button></span>
      {/each}
    </p>
    <div class="chips">
      <input placeholder="reason (required by the status route)" bind:value={reason} />
      <input placeholder="lease_token (agents only)" bind:value={leaseToken} />
      {#each STATUSES as s (s)}
        <button class="pill" onclick={() => void setStatus(s)}>{s}</button>
      {/each}
      <button class="pill" onclick={() => void toggleBlocked()}>
        {task.blocked_flag ? 'unblock' : 'block'}
      </button>
    </div>
    <div class="chips">
      <input placeholder="assignee actor id" bind:value={assigneeInput} />
      <button onclick={() => void setAssignee()}>set assignee (empty clears)</button>
      <select bind:value={attachLabelId}>
        <option value="">attach label…</option>
        {#each labels as l (l.id)}
          {@const attached = task.labels.includes(l.name)}
          {#if !attached}
            <option value={l.id}>{l.name}</option>
          {/if}
        {/each}
      </select>
      <button onclick={() => void attachLabel()}>attach</button>
    </div>
    {#if task.description}<p class="description">{task.description}</p>{/if}
    {#if task.acceptance_criteria}<p class="description">AC: {task.acceptance_criteria}</p>{/if}
  </header>

  <div class="tabs">
    {#each TABS as t (t)}
      <button
        class="tab"
        aria-pressed={tab === t}
        onclick={() => {
          tab = t
        }}>{t}</button
      >
    {/each}
  </div>

  {#if tab === 'conversation'}
    <section>
      <form
        class="file-task"
        onsubmit={(e) => {
          e.preventDefault()
          void createThread()
        }}
      >
        <select bind:value={newThreadKind}>
          <option value="note">note</option>
          <option value="question">question</option>
        </select>
        <input placeholder="start a thread…" bind:value={newThreadBody} />
        <button type="submit">Post</button>
      </form>
      {#each threads as twm (twm.thread.id)}
        <article class="thread">
          <h3>
            <span class="pill">{twm.thread.kind}</span>
            {#if twm.thread.kind === 'question'}
              <span class="pill">{twm.thread.state}</span>
            {/if}
          </h3>
          <ul>
            {#each twm.messages as m (m.id)}
              <li>
                <strong>{m.author_id}</strong>
                <span> {m.created_at}</span>
                <p>{m.body}</p>
              </li>
            {/each}
          </ul>
          <div class="chips">
            <input placeholder="comment…" bind:value={replyDrafts[twm.thread.id]} />
            <button onclick={() => void reply(twm.thread.id)}>Reply</button>
            {#if twm.thread.kind === 'question' && twm.thread.state === 'open'}
              <input placeholder="answer…" bind:value={answerDrafts[twm.thread.id]} />
              <button onclick={() => void answer(twm.thread.id)}>Answer</button>
            {/if}
          </div>
        </article>
      {/each}
      <form
        class="file-task"
        onsubmit={(e) => {
          e.preventDefault()
          void commentAsNote()
        }}
      >
        <!-- comment box = note-thread creation (§8-2 / Task 9 Step 4) -->
        <input placeholder="comment (becomes a note thread)…" bind:value={comment} />
        <button type="submit">Comment</button>
      </form>
    </section>
  {:else if tab === 'children'}
    <!-- NESTED per §8-2 (review note (g)/8): the subtree as a TREE via TaskTree -->
    <ul class="tree">
      <TaskTree {task} {childrenOf} />
    </ul>
    <p class="note">
      Split forms are an agent/API surface (POST /tasks/{'{id}'}/split) — not filed here.
    </p>
  {:else if tab === 'dependencies'}
    <section>
      <h3>blockers (unmet — from the context bundle)</h3>
      <ul>
        {#each context?.blockers ?? [] as b (b.id)}
          <li>
            <a href="/ui/tasks/{b.id}">{b.title}</a> <span class="pill">{b.status}</span>
            <button onclick={() => void removeBlocker(b.id)}>remove</button>
          </li>
        {/each}
      </ul>
      <form
        class="file-task"
        onsubmit={(e) => {
          e.preventDefault()
          void addBlocker()
        }}
      >
        <input placeholder="blocker task id" bind:value={blockerInput} />
        <button type="submit">blocker blocks this task</button>
      </form>
      <p class="note">
        unmet_blockers: {context?.unmet_blockers ?? '—'}. The contract carries no read route for
        already-met blockers or for the tasks THIS task blocks — this view shows less, honestly; the
        server's claim gate resolves the full graph.
      </p>
    </section>
  {:else if tab === 'attachments+links'}
    <section>
      <h3>attachments</h3>
      <ul>
        {#each attachments as a (a.id)}
          <li>
            <a href="/attachments/{a.id}/content">{a.filename}</a> ({a.bytes} B,
            {a.content_type})
          </li>
        {/each}
      </ul>
      <form
        class="file-task"
        onsubmit={(e) => {
          e.preventDefault()
          void upload()
        }}
      >
        <input type="file" oninput={(e) => (uploadFiles = e.currentTarget.files)} />
        <button type="submit">Upload</button>
      </form>
      <h3>links</h3>
      <ul>
        {#each links as l (l.id)}
          <li>
            <span class="pill">{l.kind}</span>
            <a href={l.url}>{l.url}</a>
            <button onclick={() => void removeLink(l.id)}>remove</button>
          </li>
        {/each}
      </ul>
      <form
        class="file-task"
        onsubmit={(e) => {
          e.preventDefault()
          void addLink()
        }}
      >
        <select bind:value={linkKind}>
          <option value="pr">pr</option>
          <option value="commit">commit</option>
          <option value="doc">doc</option>
          <option value="other">other</option>
        </select>
        <input placeholder="https://…" bind:value={linkUrl} />
        <button type="submit">Add link</button>
      </form>
    </section>
  {:else if tab === 'activity'}
    <ul class="activity">
      {#each audit as a (a.id)}
        <li>
          {a.created_at} <strong>{a.action}</strong>
          {a.entity_type}#{a.entity_id}
          {#if a.actor_id}(by {a.actor_id}){/if}
          {#if a.reason}— {a.reason}{/if}
        </li>
      {/each}
    </ul>
  {:else if tab === 'context'}
    <!-- GET /tasks/{id}/context rendered VERBATIM (§8-2) -->
    <pre class="context">{JSON.stringify(context, null, 2)}</pre>
  {/if}
{/if}
