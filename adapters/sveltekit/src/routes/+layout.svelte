<script>
  import '../app.css'
  import { base } from '$app/paths'
</script>

<nav>
  <a href="{base}/">board</a>
  <a href="{base}/inbox">inbox</a>
  <a href="{base}/admin">admin</a>
  <a href="{base}/login">login</a>
</nav>

<main>
  {@render children()}
</main>
