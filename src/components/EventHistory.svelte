<script lang="ts">
  import type { Event } from 'nostr-tools/pure';
  import { npubEncode } from 'nostr-tools/nip19';
  import { compareFollowEvents, diffRawProfileFields, buildRawProfileDraft } from '@iris/profile-events';
  import { readableFields } from '../profile-edit.ts';
  import ProfileChanges from './ProfileChanges.svelte';

  let { versions, kind, unlocked, recoverProfile, recoverFollows }: {
    versions: Event[]; kind: 0 | 3; unlocked: boolean;
    recoverProfile: (content: string, tagsFrom?: Event, repairFrom?: Event) => void;
    recoverFollows: (saved: Event, keys: string[]) => void;
  } = $props();
  let earlierId = $state(''), laterId = $state('');
  const earlier = $derived(versions.find(e => e.id === earlierId) ?? versions[1]);
  const later = $derived(versions.find(e => e.id === laterId) ?? versions[0]);
  const canRestore = $derived(unlocked && later?.id === versions[0]?.id && earlier?.id !== later?.id);
  const follows = $derived(kind === 3 && earlier && later ? compareFollowEvents(earlier, later) : undefined);
  const date = (e: Event) => new Date(e.created_at * 1000).toLocaleString();
  let keys = $state<string[]>([]), tags = $state(false), limit = $state(30);
  $effect(() => { void earlier; void later; keys = []; tags = false; limit = 30; });
  function names(event: Event | undefined) {
    return new Map(event?.tags.filter(t => t[0] === 'p' && t[3]).map(t => [t[1], t[3]]));
  }
  const oldNames = $derived(names(earlier)), newNames = $derived(names(later));
  function contact(key: string, labels: Map<string,string>) {
    const name = labels.get(key);
    const npub = npubEncode(key);
    return (name ? name + ' · ' : '') + npub.slice(0, 13) + '…' + npub.slice(-6);
  }
  function restoreFields() {
    const old = readableFields(earlier.content);
    const current = readableFields(later.content);
    if (!old) return;
    if (!current) return recoverProfile(earlier.content, earlier, earlier);
    const delta = diffRawProfileFields(current, old);
    const edits = Object.fromEntries(keys.map(key => [key, delta[key]]));
    recoverProfile(buildRawProfileDraft(later, edits).content, tags ? earlier : undefined);
  }
</script>
{#if versions.length < 2}
  <p>{versions.length ? 'One version saved. The next change will appear here.' : 'No versions saved on this device yet.'}</p>
{:else}
  <div class="profileFields">
    <label>Earlier version<select aria-label="Earlier version" value={earlier.id} onchange={e => earlierId = e.currentTarget.value}>
      {#each versions.slice(versions.indexOf(later) + 1) as v}<option value={v.id}>{date(v)}</option>{/each}
    </select></label>
    <label>Compare with<select aria-label="Compare with" value={later.id} onchange={e => { laterId = e.currentTarget.value; earlierId = versions[versions.findIndex(v => v.id === laterId) + 1].id; }}>
      {#each versions.slice(0, -1) as v, i}<option value={v.id}>{i === 0 ? 'Current · ' : ''}{date(v)}</option>{/each}
    </select></label>
  </div>
  {#if kind === 0}
    {#if canRestore && readableFields(earlier.content) && readableFields(later.content)}<p class="hint">Select fields to bring back their earlier values.</p>{/if}
    <ProfileChanges before={earlier} after={later} selectable={canRestore} bind:selected={keys} bind:useTags={tags} />
    {#if canRestore && readableFields(earlier.content)}
      <button class="secondary" disabled={!keys.length && !tags && !!readableFields(later.content)} onclick={restoreFields}>Review profile recovery</button>
    {/if}
  {:else if follows}
    <p><strong>{follows.added.length} added · {follows.removed.length} removed</strong>{follows.changed.length ? ' · ' + follows.changed.length + ' updated' : ''}</p>
    {#if follows.massRemoval}<p class="wipeWarning"><strong>Large follow removal</strong><br />This update removed {follows.removed.length} follows. You can recover missing people from the earlier list.</p>{/if}
    {#if follows.removed.length}
      <h4>Removed follows</h4>
      {#if canRestore}<label class="check"><input type="checkbox" checked={keys.length === follows.removed.length}
        onchange={e => keys = e.currentTarget.checked ? [...(follows?.removed ?? [])] : []} />Select all {follows.removed.length} to recover</label>{/if}
      {#each follows.removed.slice(0, limit) as key}<div class="contactRow" title={npubEncode(key)}>
        {#if canRestore}<label class="check"><input type="checkbox" value={key} bind:group={keys} />{contact(key, oldNames)}</label>{:else}{contact(key, oldNames)}{/if}
      </div>{/each}
    {/if}
    {#if follows.added.length}<h4>Added follows</h4>{#each follows.added.slice(0, limit) as key}<div class="contactRow" title={npubEncode(key)}>{contact(key, newNames)}</div>{/each}{/if}
    {#if follows.changes.length}<details><summary>Changed follow details ({follows.changes.length})</summary>
      {#each follows.changes.slice(0, limit) as change}<p>{contact(change.pubkey, newNames)}</p><div class="tagValue">Before · {JSON.stringify(change.before)}</div><div class="tagValue">After · {JSON.stringify(change.after)}</div>{/each}
    </details>{/if}
    {#if Math.max(follows.removed.length, follows.added.length, follows.changes.length) > limit}<button class="secondary" onclick={() => limit += 30}>Show more people</button>{/if}
    {#if follows.contentChanged || follows.tagsReordered || follows.tagsAdded.length || follows.tagsRemoved.length}
      <details><summary>Other event changes</summary>
        {#if follows.tagsReordered}<p>Tag order changed.</p>{/if}
        {#if follows.contentChanged}<div class="tagValue">Before · {earlier.content || '(empty)'}</div><div class="tagValue">After · {later.content || '(empty)'}</div>{/if}
        {#each follows.tagsAdded as tag}<div class="tagValue">Added · {JSON.stringify(tag)}</div>{/each}
        {#each follows.tagsRemoved as tag}<div class="tagValue">Removed · {JSON.stringify(tag)}</div>{/each}
      </details>
    {/if}
    {#if canRestore && follows.removed.length}<button disabled={!keys.length} onclick={() => recoverFollows(earlier, [...keys])}>Review follow recovery{keys.length ? ' (' + keys.length + ')' : ''}</button>{/if}
  {/if}
{/if}
