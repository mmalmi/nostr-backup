<script lang="ts">
  import type { XMatch } from '../x-identity.ts';
  import { npubEncode } from 'nostr-tools/nip19';
  import { notice, send } from '../ui.ts';
  import { app } from './page.svelte.ts';

  // People you follow on X who have a verified link to a Nostr profile, ready to follow there.
  let { handle, read = 0, total, unlocked = false }: { handle: string; read?: number; total?: number; unlocked?: boolean } = $props();

  let finding = $state(false);
  let found = $state<{ matches: XMatch[]; unchecked: number; following: string[]; loading?: boolean }>();
  let chosen = $state<Record<string, boolean>>({});
  let query = $state('');
  let showFollowing = $state(false);
  let page = $state(0);
  let following = $state(false);
  let source = '';
  let generation = 0;
  const pageSize = 10;
  $effect(() => {
    if (source === handle) return;
    source = handle;
    generation++;
    found = undefined;
    chosen = {};
    query = '';
    page = 0;
    finding = following = false;
  });

  async function find() {
    const active = generation;
    finding = true;
    try {
      const next = await send('findXFollows', { refresh: true });
      if (active !== generation) return;
      found = next;
      chosen = Object.fromEntries(next.matches.map((m) => [m.pubkey, !next.following.includes(m.pubkey) && (chosen[m.pubkey] ?? true)]));
    } catch (e) {
      if (active === generation) notice((e as Error).message);
    } finally {
      if (active === generation) finding = false;
    }
  }
  const matches = $derived([...new Map((found?.matches ?? []).map(m => [m.pubkey, m])).values()]);
  const followed = $derived(new Set(found?.following ?? []));
  const alreadyFollowing = $derived(matches.filter(m => followed.has(m.pubkey)).length);
  const filtered = $derived(matches.filter(m => (showFollowing || !followed.has(m.pubkey)) &&
    ((m.name ?? '') + ' @' + m.handle).toLowerCase().includes(query.trim().toLowerCase())));
  const available = $derived(filtered.filter(m => !followed.has(m.pubkey)));
  const selected = $derived(available.filter(m => chosen[m.pubkey]).map(m => m.pubkey));
  const pages = $derived(Math.max(1, Math.ceil(filtered.length / pageSize)));
  const currentPage = $derived(Math.min(page, pages - 1));
  const shown = $derived(filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize));
  function selectAll(value: boolean) {
    chosen = { ...chosen, ...Object.fromEntries(available.map(m => [m.pubkey, value])) };
  }
  async function follow() {
    if (following || !selected.length) return;
    const pubkeys = selected, active = generation;
    following = true;
    try {
      const count = await send('followOnNostr', { pubkeys });
      if (active !== generation) return;
      notice('Following ' + count + ' on Nostr.');
      found = { ...found!, following: [...new Set([...found!.following, ...pubkeys])] };
      await app.refresh();
    } catch (e) {
      if (active === generation) notice((e as Error).message);
    } finally {
      if (active === generation) following = false;
    }
  }
  const followingURL = $derived('https://x.com/' + handle + '/following');
  const knownTotal = $derived(total !== undefined && total >= read ? total : undefined);
</script>

{#if read}
  <p class="hint">
    {`${read.toLocaleString()}${knownTotal !== undefined ? ' of ' + knownTotal.toLocaleString() : ''} ${read === 1 && (knownTotal === undefined || knownTotal === 1) ? 'account' : 'accounts'} loaded from your X following list.`}
    {#if knownTotal === undefined || read < knownTotal}
      Scroll further in <a href={followingURL} target="_blank" rel="noopener noreferrer">your following list</a> to include more.
    {/if}
  </p>
  <button class="secondary" id="findXFollows" disabled={finding || following} onclick={find}
    >{finding ? 'Checking…' : found ? 'Refresh Nostr matches' : 'Find my X follows on Nostr'}</button>
{:else}
  <p class="hint">Open @{handle}’s following list on X, then come back here to find those people on Nostr.
    You can start with the first people shown or scroll on X to include more.</p>
  <a class="button secondary" href={followingURL} target="_blank" rel="noopener noreferrer">Open my X following list</a>
{/if}
{#if found}
  {#if matches.length}
    <div class="matchResults">
      <p class="hint">{`${matches.length.toLocaleString()} on Nostr${alreadyFollowing ? ' · ' + alreadyFollowing.toLocaleString() + ' already following' : ''}`}</p>
      <input type="search" aria-label="Search Nostr matches" placeholder="Search names or X handles" bind:value={query} oninput={() => (page = 0)} />
      {#if alreadyFollowing}
        <label class="check"><input type="checkbox" bind:checked={showFollowing} onchange={() => (page = 0)} />Show already following</label>
      {/if}
      <div class="matchActions">
        <div class="actions">
          <button class="secondary" disabled={!available.length || selected.length === available.length || following} onclick={() => selectAll(true)}>Select all{query.trim() ? ' results' : ''}</button>
          <button class="secondary" disabled={!selected.length || following} onclick={() => selectAll(false)}>Clear selection</button>
        </div>
        <button id="followOnNostr" disabled={!selected.length || !unlocked || finding || following} onclick={follow}>{following ? 'Following…' : 'Follow ' + selected.length.toLocaleString() + ' on Nostr'}</button>
      </div>
      <ul class="xMatches" aria-label="Nostr matches">
        {#each shown as match (match.pubkey)}
          <li>
            <input type="checkbox" aria-label={'Select @' + match.handle} bind:checked={chosen[match.pubkey]} disabled={followed.has(match.pubkey) || following} />
            <a href={'https://iris.to/' + npubEncode(match.pubkey)} target="_blank" rel="noopener noreferrer" title="View Nostr profile">
              <span>{match.name || match.handle}</span><small>@{match.handle}</small>
            </a>
            {#if followed.has(match.pubkey)}<small class="matchFollowing">Following</small>{/if}
          </li>
        {/each}
      </ul>
      {#if !filtered.length}
        <p class="hint">{query.trim() ? 'No matches for this search.' : 'You already follow all these people on Nostr.'}</p>
      {:else if pages > 1}
        <nav class="matchPages" aria-label="Nostr match pages">
          <button class="secondary" disabled={currentPage === 0} onclick={() => (page = currentPage - 1)}>Previous</button>
          <span class="hint">{currentPage * pageSize + 1}–{Math.min((currentPage + 1) * pageSize, filtered.length)} of {filtered.length.toLocaleString()}</span>
          <button class="secondary" disabled={currentPage + 1 === pages} onclick={() => (page = currentPage + 1)}>Next</button>
        </nav>
      {/if}
    </div>
  {:else}
    <p class="hint">No confirmed Nostr matches found.</p>
  {/if}
  {#if found.loading}
    <p class="hint">Updating the Nostr directory in the background. Refresh in a minute for more matches.</p>
  {/if}
  {#if found.unchecked}
    <p class="hint">{found.unchecked} {found.unchecked === 1 ? 'account link' : 'account links'} could not be confirmed. Refresh to try again.</p>
  {/if}
{/if}
