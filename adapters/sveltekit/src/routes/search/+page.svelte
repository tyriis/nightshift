<script lang="ts">
  import { api } from '$lib/api'
  import type { SearchHit } from '$lib/types'

  // D-qqq: the §12 search surface over the D-gg/D-ppp read port — one form, the
  // server's FTS truth untouched: snippet brackets, bm25 order, invalid_request shown
  // as an error line (never swallowed into an empty list — an empty list means the
  // server found NOTHING, not that the query was nonsense).
  let q = $state('')
  let hits = $state<SearchHit[] | null>(null)
  let err = $state('')
  async function search(): Promise<void> {
    err = ''
    if (!q.trim()) return
    try {
      hits = await api<SearchHit[]>(`/search?q=${encodeURIComponent(q.trim())}&limit=20`)
    } catch (e) {
      hits = null
      err = e instanceof Error ? e.message : String(e)
    }
  }
</script>

<form onsubmit={(e) => (e.preventDefault(), void search())}>
  <input placeholder="FTS5 query — words, phrases…" bind:value={q} />
  <button type="submit">Search</button>
</form>
{#if err}<p class="error">{err}</p>{/if}
{#if hits !== null}
  <p class="hits-count">{hits.length} hit(s)</p>
  <ul class="hits">
    {#each hits as h (h.id)}
      <li>
        <a href="/ui/tasks/{h.id}">{h.title}</a>
        <div class="snippet">{h.snippet}</div>
      </li>
    {/each}
  </ul>
{/if}
