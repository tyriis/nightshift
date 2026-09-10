<script lang="ts">
  // Inbox (§8-3): GET /inbox is the caller's own view (per-actor, routes/inbox.ts:22);
  // the mark-read button transcribes POST /inbox/{id}/read (204); jump-to-task links.
  import { api, ApiError } from '$lib/api'
  import type { InboxItemDto } from '$lib/types'

  let items = $state<InboxItemDto[]>([])
  let err = $state('')
  let unreadOnly = $state(false)

  async function load(): Promise<void> {
    try {
      items = await api<InboxItemDto[]>(`/inbox${unreadOnly ? '?unread_only=true' : ''}`)
      err = ''
    } catch (e) {
      err = e instanceof ApiError ? `${e.code}: ${e.detail}` : String(e)
    }
  }
  $effect(() => void load()) // unreadOnly flips reload; 401 bounces per api()

  async function markRead(id: string): Promise<void> {
    try {
      await api(`/inbox/${id}/read`, { method: 'POST' }) // 204 — no body
      await load()
    } catch (e) {
      err = e instanceof ApiError ? `${e.code}: ${e.detail}` : String(e)
    }
  }
</script>

<h1>inbox</h1>
{#if err}<p class="error">{err}</p>{/if}
<label class="chips"><input type="checkbox" bind:checked={unreadOnly} /> unread only</label>
<ul class="inbox">
  {#each items as item (item.id)}
    <li class:unread={!item.read}>
      {#if !item.read}●{/if}
      <span class="pill">{item.kind}</span>
      <a href="/ui/tasks/{item.task_id}">{item.task_id}</a>
      {#if item.thread_id}<span class="pill">thread</span>{/if}
      <span>{item.created_at}</span>
      {#if !item.read}
        <button onclick={() => void markRead(item.id)}>mark read</button>
      {/if}
    </li>
  {/each}
</ul>
