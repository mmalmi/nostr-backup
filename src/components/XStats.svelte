<script lang="ts">
  import type { Status } from '../types.ts';

  let { x, localX }: { x?: Status['x']; localX?: number } = $props();
  const count = (n: number) => n.toLocaleString();
</script>

<div class="stats" aria-label="X backup statistics">
  <div><strong id="xCaptured">{count(x?.captured ?? 0)}</strong>Posts found</div>
  <div><strong id="xSigned">{count(x?.signed ?? 0)}</strong>New copies</div>
  <div><strong id="xMatched">{count(x?.matched ?? 0)}</strong>Already on Nostr</div>
  <div><strong id="xDrafts">{count(x?.drafts ?? 0)}</strong>Preparing</div>
</div>
<p id="localXCount" class="hint" hidden={!localX}>{count(localX ?? 0)} local only</p>
<p id="xImageState" class="hint" hidden={!x?.media}>
  {#if x?.media}
    {count(x.media)} {x.media === 1 ? 'post' : 'posts'} waiting for images{x.mediaError ? ' · ' + x.mediaError : ''}
  {/if}
</p>
