<script lang="ts">
  import { onMount } from 'svelte';
  import type { Event } from 'nostr-tools/pure';
  import { compareRawProfileEvents, compareFollowEvents, diffRawProfileFields, conflictingRawProfileFields, buildRawProfileDraft, readRawProfileFields, readProfileFields } from '@iris/profile-events';
  import { editProfileDraft, emptyProfile, readableFields } from '../profile-edit.ts';
  import { paymentConsent } from '../tip-consent.ts';
  import { send } from '../ui.ts';
  import { app } from './page.svelte.ts';
  import ProfileFields from './ProfileFields.svelte';
  import ProfileChanges from './ProfileChanges.svelte';
  import EventHistory from './EventHistory.svelte';

  let { account, unlocked }: { account: string; unlocked: boolean } = $props();
  let profiles = $state.raw<Event[]>([]), follows = $state.raw<Event[]>([]);
  let section = $state<'edit' | 'profiles' | 'follows'>('edit');
  let busy = $state(false), loaded = $state(false), message = $state(''), error = $state('');
  let generation = $state(0);
  let fieldsForm = $state<ReturnType<typeof ProfileFields>>();
  let editorSeed = $state<string>();
  type Review = {kind: 0; content: string; tagsFrom?: Event; repairFrom?: Event} | {kind: 3; saved: Event; keys: string[]};
  let review = $state.raw<Review>();
  const profile = $derived(profiles[0]);
  const base = $derived(profile ?? emptyProfile);
  const before = $derived(readableFields(base.content));
  const draft = $derived(review?.kind === 0 ? editProfileDraft(profile, profile, review.content, review.tagsFrom, review.repairFrom) : undefined);
  const profileWipe = $derived(profiles[1] && before && readableFields(profiles[1].content) && compareRawProfileEvents(profiles[1], profile).massRemoval);
  const followLoss = $derived(follows[1] && compareFollowEvents(follows[1], follows[0]));
  async function load(remote = false) {
    busy = true; error = '';
    try {
      const old = before;
      const unsaved = remote && old && (review?.kind === 0 ? review.content : fieldsForm?.draftContent());
      const [a,b] = await Promise.all(([0,3] as const).map(kind => send('eventVersions', { account, kind, refresh: remote })));
      editorSeed = undefined;
      if (remote) message = 'History refreshed.';
      const nextFields = readableFields(a[0]?.content ?? '{}');
      if (unsaved && old && nextFields) {
        const edits = diffRawProfileFields(old, readRawProfileFields(unsaved));
        if (Object.keys(edits).length) {
          const conflicts = conflictingRawProfileFields(old, nextFields, edits);
          editorSeed = buildRawProfileDraft(a[0] ?? null, edits).content;
          section = 'edit';
          message = conflicts.length ? 'Also changed in another client: ' + conflicts.join(', ') + '. Review your draft against the latest values before publishing.' : 'History refreshed. Your draft edits are kept.';
        }
      }
      profiles = a; follows = b; loaded = true; generation++; review = undefined;
    } catch (e) { error = (e as Error).message; } finally { busy = false; }
  }
  onMount(() => { void load(); });
  function preview(content: string, tagsFrom?: Event, repairFrom?: Event) {
    error = ''; message = '';
    try {
      const candidate = editProfileDraft(profile, profile, content, tagsFrom, repairFrom);
      if (before) {
        const diff = compareRawProfileEvents(base, candidate);
        if (!diff.fields.length && JSON.stringify(base.tags) === JSON.stringify(candidate.tags)) {
          message = 'No changes to publish.'; return;
        }
      }
      review = {kind: 0, content, tagsFrom, repairFrom};
    } catch (e) { error = (e as Error).message; }
  }
  async function publish() {
    if (!review || busy) return;
    const request = review;
    busy = true; error = '';
    try {
      if (request.kind === 0 && draft) {
        const fields = readProfileFields(draft.content);
        const previous = readProfileFields((request.repairFrom ? emptyProfile : base).content);
        if (['lud16','lud06'].some(key => fields[key] && fields[key] !== previous[key]) && !await paymentConsent(true))
          throw Error('Allow payment data to publish a Lightning address.');
        await send('editProfile', { account, baseId: profile?.id ?? null, content: request.content,
          tagsFrom: request.tagsFrom?.id, repairFrom: request.repairFrom?.id, confirmedRemoval: !!before && compareRawProfileEvents(base, draft).massRemoval });
      } else if (request.kind === 3) {
        await send('recoverFollows', { account, baseId: follows[0].id, fromId: request.saved.id, pubkeys: request.keys });
      }
      review = undefined;
      await load();
      message = 'Saved on this device and queued for your relays.';
      await app.refresh();
    } catch (e) { error = (e as Error).message; } finally { busy = false; }
  }
</script>
<h2>Profile</h2>
<div class="profileModes" aria-label="Profile views">
  {#each [['edit','Edit profile'],['profiles','Profile history'],['follows','Follow history']] as [id,label]}
    <button class="secondary" aria-pressed={section === id} disabled={busy || !!review} onclick={() => { section = id as typeof section; message = ''; error = ''; }}>{label}</button>
  {/each}
</div>
{#if !unlocked}<p class="hint">Read-only. <a href="#account">Unlock your profile</a> to publish changes.</p>{/if}
{#if busy}<p role="status">{review ? 'Checking the latest version…' : 'Loading versions…'}</p>{/if}
{#if review}
  <section aria-label="Review before publishing">
    <h3>{review.kind === 0 ? 'Review profile changes' : 'Review follow recovery'}</h3>
    {#if review.kind === 0 && draft}<ProfileChanges before={base} after={draft} />
    {:else if review.kind === 3}<p>Add back <strong>{review.keys.length} {review.keys.length === 1 ? 'follow' : 'follows'}</strong> from {new Date(review.saved.created_at * 1000).toLocaleString()}. Your current follows and their details are kept.</p>
    {/if}
    <p class="hint">Publishing shares this update on your selected Nostr relays.</p>
    <div class="actions"><button disabled={busy || !unlocked} onclick={publish}>{review.kind === 0 ? 'Publish profile' : 'Publish follow list'}</button>
      <button class="secondary" disabled={busy} onclick={() => { review = undefined; error = ''; }}>Back</button></div>
  </section>
{/if}
{#if loaded}
  <div hidden={!!review || section !== 'edit'}>
    {#if profileWipe || followLoss?.massRemoval}<div class="wipeWarning">
      {#if profileWipe}<p><strong>Your latest profile update cleared profile details.</strong> <button class="textButton" onclick={() => section = 'profiles'}>Review profile history</button></p>{/if}
      {#if followLoss?.massRemoval}<p><strong>Your latest follow list removed {followLoss.removed.length} people.</strong> <button class="textButton" onclick={() => section = 'follows'}>Review follow history</button></p>{/if}
    </div>{/if}
    <section><h3>Public profile</h3>
      {#if !profile}<p class="hint">No profile is saved here yet. Refresh history to look for an existing profile.</p>{/if}
      {#if before}{#key generation}<ProfileFields bind:this={fieldsForm} content={editorSeed ?? base.content} review={preview} disabled={!unlocked || busy} />{/key}
      {:else}<p>This profile contains unreadable JSON. Open Profile history to recover a saved version.</p>{/if}
    </section>
    {#if profile?.tags.length}<section><details><summary>Event tags ({profile.tags.length})</summary>
      {#each profile.tags as tag}<p class="tagValue"><strong>{tag[0] === 'imeta' ? 'Image details' : tag[0] === 'i' ? 'External identity claim' : tag[0]}</strong><br />{JSON.stringify(tag)}</p>{/each}
    </details></section>{/if}
  </div>
  {#if !review && section !== 'edit'}
    <section><h3>{section === 'profiles' ? 'Profile history' : 'Follow history'}</h3>
      {#key section + generation}<EventHistory versions={section === 'profiles' ? profiles : follows} kind={section === 'profiles' ? 0 : 3} {unlocked}
        recoverProfile={preview} recoverFollows={(saved, keys) => { review = {kind: 3, saved, keys}; error = ''; message = ''; }} />{/key}
    </section>
    <p class="hint">This device keeps up to 10 earlier profiles and 3 earlier follow lists within a shared 2 MiB limit.</p>
  {/if}
{/if}
{#if error}<p role="alert" class="wipeWarning">{error}</p>{/if}
{#if message}<p role="status">{message}</p>{/if}
{#if !review || error}<button class="secondary" disabled={busy} onclick={() => load(true)}>Refresh history</button>{/if}
