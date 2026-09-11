<script lang="ts">
  import '../app.css'
  import { base } from '$app/paths'
  import { csrfToken } from '$lib/api'
  import type { ActorMe } from '$lib/types'

  let { children } = $props()

  // Task 9's sign-out affordance (Task 8's shell). The identity read is a plain
  // fetch, NOT api(): api() bounces 401→login, and the nav must stay usable on
  // the login page itself (an api()-based nav identity would ping-pong there).
  let me = $state<ActorMe | null>(null)
  async function whoami(): Promise<void> {
    try {
      const res = await fetch('/auth/me', {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      me = res.ok ? ((await res.json()) as ActorMe) : null
    } catch {
      me = null // nav courtesy only — the per-view api() calls own the real 401 posture
    }
  }
  async function signOut(): Promise<void> {
    const headers: Record<string, string> = { accept: 'application/json' }
    const token = csrfToken() // D-rr: logout is state-changing → mirror the companion
    if (token) headers['x-csrf-token'] = token
    try {
      await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin', headers })
    } finally {
      location.assign(`${base}/login`) // cookie pair is cleared server-side (D-qq)
    }
  }
  void whoami()
</script>

<nav>
  <a href="{base}/">board</a>
  <a href="{base}/inbox">inbox</a>
  <a href="{base}/search">search</a>
  <a href="{base}/admin">admin</a>
  {#if me}
    <span class="who">
      {me.display_name}{#if me.role}
        ({me.role}){/if}
      <button class="signout" onclick={() => void signOut()}>sign out</button>
    </span>
  {:else}
    <a href="{base}/login">login</a>
  {/if}
</nav>

<main>
  {@render children()}
</main>
