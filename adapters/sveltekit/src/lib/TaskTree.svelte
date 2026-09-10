<script lang="ts">
  // TaskTree.svelte — one node of the §8-2 children tree, rendered NESTED
  // (review note (g)/8: the children tab prints the subtree as a TREE, reusing
  // the board's walk/group pattern: children are computed by the caller from
  // GET /tasks rows, never assumed from a server field).
  import type { TaskDto } from './types'

  let { task, childrenOf }: { task: TaskDto; childrenOf: (id: string) => TaskDto[] } = $props()
</script>

<li>
  <a href="/ui/tasks/{task.id}">{task.title}</a>
  <span class="pill">{task.status}</span>
  {#if task.blocked_flag}⚑{/if}
  {#if childrenOf(task.id).length > 0}
    <ul>
      {#each childrenOf(task.id) as child (child.id)}
        <svelte:self task={child} {childrenOf} />
      {/each}
    </ul>
  {/if}
</li>
