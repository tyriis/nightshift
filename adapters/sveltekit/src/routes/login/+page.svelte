<script lang="ts">
  // Login (§8-5): NO registration — the OIDC button is the only door. The L3
  // returnTo collapse is SERVER-side (routes/auth.ts:55 — non-/ui/ paths collapse
  // to /ui/); this view just passes returnTo through. Error query display per plan.
  import { page } from '$app/state'

  const error = $derived(page.url.searchParams.get('error'))
  const returnTo = $derived(page.url.searchParams.get('returnTo') ?? '/ui/')
</script>

<h1>sign in</h1>
{#if error === 'pending'}
  <p class="error">not allow-listed yet — ask an admin</p>
{:else if error === 'idp'}
  <p class="error">the identity provider rejected the sign-in — try again</p>
{/if}
<p>
  <a href="/auth/login?returnTo={encodeURIComponent(returnTo)}">Sign in with your account</a>
</p>
<p class="note">No account creation here — access is issued by an administrator.</p>
