<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { api, json } from '$lib/api'
  import { pollFeed } from '$lib/events'
  import type { FeedEvent, TaskDto } from '$lib/types'

  const COLUMNS = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled'] as const
  let tasks = $state<TaskDto[]>([])
  let byId = $derived(new Map(tasks.map((t) => [t.id, t])))
  const roots = $derived(tasks.filter((t) => !t.parent_id))
  // swimlane rollup: leaves of the root's subtree (root-with-children is never a
  // leaf — spec D6): done-leaves / total-leaves
  const leavesOf = (rootId: string): TaskDto[] => {
    const out: TaskDto[] = []
    const kids = (id: string) => tasks.filter((t) => t.parent_id === id)
    const walk = (id: string): void => {
      const ks = kids(id)
      if (ks.length === 0) out.push(byId.get(id)!)
      else ks.forEach((k) => walk(k.id))
    }
    if (kids(rootId).length === 0) out.push(byId.get(rootId)!)
    else kids(rootId).forEach((k) => walk(k.id))
    return out
  }
  // filters (chips; ready-only reads the SERVER's ready() facts OFF THE DTO —
  // unmet_blockers/claim_token_id ride it (review note (g)); full dependency
  // resolution stays the SERVER's claim gate's job, stated honestly in the UI note)
  let fAssignee = $state('')
  let fLabel = $state('')
  let fBlocked = $state(false)
  let fReadyOnly = $state(false)
  // select options built from the loaded data (plan Step 3 note: the DTO is the only source)
  const assignees = $derived(
    Array.from(new Set(tasks.map((t) => t.assignee_id).filter((a): a is string => a !== null)))
  )
  const labelNames = $derived(Array.from(new Set(tasks.flatMap((t) => t.labels))))
  const visible = (t: TaskDto): boolean =>
    (!fAssignee || t.assignee_id === fAssignee) &&
    (!fLabel || t.labels.includes(fLabel)) &&
    (!fBlocked || t.blocked_flag === true) &&
    (!fReadyOnly ||
      (t.status === 'todo' &&
        !t.assignee_id &&
        !t.blocked_flag &&
        t.unmet_blockers === 0 &&
        t.claim_token_id === null &&
        !tasks.some((c) => c.parent_id === t.id)))
  const cell = (rootId: string, status: string): TaskDto[] =>
    leavesOf(rootId).filter((t) => t.status === status && visible(t))
  const rollup = (rootId: string): string => {
    const ls = leavesOf(rootId)
    return `${ls.filter((t) => t.status === 'done').length}/${ls.length}`
  }
  // D-ooo: claim liveness on the card — last_heartbeat_at is public on every Task DTO
  // (E shipped it, types.ts transcribes it). An in_progress card whose holder is silent
  // shows its AGE; NO threshold judgment — the expiry budget is server config (dormant
  // by default), so the card reports age and the operator's config supplies meaning.
  // The claim itself is the first liveness (D-hhh), so a pre-heartbeat claim anchors on
  // updated_at exactly like the sweeper's coalesce — same truth, same UI.
  // Cadence: recomputes on each feed-driven refresh — heartbeats land in the feed, so
  // a live holder tracks within one poll cycle; between events, as-of-last-refresh.
  const livenessAge = (t: TaskDto): string | null => {
    if (t.status !== 'in_progress' || t.claim_token_id === null) return null
    const anchor = Date.parse(t.last_heartbeat_at ?? t.updated_at)
    const mins = Math.max(0, Math.round((Date.now() - anchor) / 60_000))
    return mins < 60 ? `${mins}m` : `${Math.round(mins / 60)}h`
  }
  // new-task form (humans file work — §14-2)
  let newTitle = $state('')
  async function fileTask(): Promise<void> {
    if (!newTitle.trim()) return
    await api('/tasks', json('POST', { title: newTitle.trim(), status: 'todo' }))
    newTitle = ''
    await refresh()
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  async function refresh(): Promise<void> {
    tasks = await api<TaskDto[]>('/tasks')
  }
  onMount(() => {
    void (async () => {
      await refresh()
      await pollFeed(
        (cursor) => api<FeedEvent[]>(`/events?cursor=${cursor}`),
        () => void refresh(),
        () => !stopped,
        (fn, ms) => (timer = setTimeout(fn, ms))
      )
    })()
  })
  onDestroy(() => {
    stopped = true
    if (timer) clearTimeout(timer)
  })
</script>

<form class="file-task" onsubmit={(e) => (e.preventDefault(), fileTask())}>
  <input placeholder="File a task…" bind:value={newTitle} />
  <button type="submit">File</button>
</form>
<div class="chips">
  <select bind:value={fAssignee}>
    <option value="">assignee: all</option>
    {#each assignees as a (a)}
      <option value={a}>{a}</option>
    {/each}
  </select>
  <select bind:value={fLabel}>
    <option value="">label: all</option>
    {#each labelNames as l (l)}
      <option value={l}>{l}</option>
    {/each}
  </select>
  <label><input type="checkbox" bind:checked={fBlocked} /> blocked</label>
  <label><input type="checkbox" bind:checked={fReadyOnly} /> ready-only</label>
</div>
{#each roots as root (root.id)}
  <section class="swimlane">
    <h2>
      <a href="/ui/tasks/{root.id}">{root.title}</a>
      <span class="rollup" title="done / total leaves">{rollup(root.id)}</span>
    </h2>
    <div class="columns">
      {#each COLUMNS as col (col)}
        <div class="column">
          <h3>{col}</h3>
          {#each cell(root.id, col) as t (t.id)}
            <a class="card" href="/ui/tasks/{t.id}"
              >{t.title}{t.blocked_flag ? ' ⚑' : ''}{t.labels
                .map((l) => ` #${l}`)
                .join('')}{#if livenessAge(t)}
                <span
                  class="liveness"
                  title="claim liveness — the heartbeat (or the claim itself) saw the holder this long ago"
                  >♥ {livenessAge(t)}</span
                >{/if}</a
            >
          {/each}
        </div>
      {/each}
    </div>
  </section>
{/each}
