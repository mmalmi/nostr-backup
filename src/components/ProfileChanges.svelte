<script lang="ts">
  import { compareProfileEvents } from '@iris/profile-events';
  import { readableFields } from '../profile-edit.ts';
  type Data = {content: string; tags: string[][]};
  let { before, after, selectable = false, selected = $bindable<string[]>([]), useTags = $bindable(false) }:
    { before: Data; after: Data; selectable?: boolean; selected?: string[]; useTags?: boolean } = $props();
  const valid = $derived(!!readableFields(before.content) && !!readableFields(after.content));
  const diff = $derived(valid ? compareProfileEvents(before, after) : undefined);
  function show(value: unknown) { return value === undefined ? 'Absent' : value === '' ? 'Empty text' : typeof value === 'string' ? value : JSON.stringify(value); }
  const labels = new Map(Object.entries({name:'Username', display_name:'Display name', about:'Bio', nip05:'Nostr address', lud16:'Lightning address',
    picture:'Picture', banner:'Banner', website:'Website'}));
  let limit = $state(30);
</script>
{#if diff}
  {#if diff.massRemoval}<p class="wipeWarning"><strong>Large profile removal</strong><br />This update cleared profile fields or removed event tags.</p>{/if}
  {#if !diff.fields.length && !diff.tagsAdded.length && !diff.tagsRemoved.length && !diff.tagsReordered}
    <p>The profile fields and tags are identical.</p>
  {/if}
  <dl class="changeList">
    {#each diff.fields.slice(0, limit) as change (change.key)}
      <div><dt>
        {#if selectable}<label class="check"><input type="checkbox" bind:group={selected} value={change.key} />{labels.get(change.key) ?? change.key}</label>
        {:else}{labels.get(change.key) ?? change.key}{/if}
      </dt><dd><span class="oldValue">Before</span> {show(change.before)}</dd><dd><span class="newValue">After</span> {show(change.after)}</dd></div>
    {/each}
  </dl>
  {#if diff.fields.length > limit}<button class="secondary" onclick={() => limit += 30}>Show more fields</button>{/if}
  {#if diff.tagsAdded.length || diff.tagsRemoved.length || diff.tagsReordered}
    <details><summary>Event tags · {diff.tagsAdded.length} added · {diff.tagsRemoved.length} removed{diff.tagsReordered ? ' · order changed' : ''}</summary>
      {#each diff.tagsRemoved as tag}<p class="tagValue">Removed · {JSON.stringify(tag)}</p>{/each}
      {#each diff.tagsAdded as tag}<p class="tagValue">Added · {JSON.stringify(tag)}</p>{/each}
    </details>
    {#if selectable}<label class="check"><input type="checkbox" bind:checked={useTags} />Restore earlier event tags</label>{/if}
  {/if}
{:else}
  <p>A saved profile contains unreadable JSON.</p>
  <details><summary>View saved content</summary><pre>{before.content}</pre><pre>{after.content}</pre></details>
{/if}
