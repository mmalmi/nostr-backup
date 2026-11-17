<script lang="ts">
  import type { XMatch } from '../x-identity.ts';
  import { notice, send } from '../ui.ts';
  import { app } from './page.svelte.ts';

  // People you follow on X who have a verified link to a Nostr profile, ready to follow there.
  let { handle, read = 0, total, unlocked = false }: { handle: string; read?: number; total?: number; unlocked?: boolean } = $props();

  let finding = $state(false);
  let found = $state<{ matches: XMatch[]; unchecked: number; following: string[]; loading?: boolean }>();
  let chosen = $state<Record<string, boolean>>({});

  async function find() {
    finding = true;
    try {
      found = await send('findXFollows', { refresh: true });
      chosen = Object.fromEntries(found.matches.map((m) => [m.pubkey, !found!.following.includes(m.pubkey)]));
    } catch (e) {
      notice((e as Error).message);
    } finally {
      finding = false;
    }
  }
  const selected = $derived(Object.keys(chosen).filter((key) => chosen[key]));
  async function follow() {
    try {
      const count = await send('followOnNostr', { pubkeys: selected });
      notice('Following ' + count + ' on Nostr.');
      found = { ...found!, following: [...new Set([...found!.following, ...selected])] };
      chosen = {};
      await app.refresh();
    } catch (e) {
      notice((e as Error).message);
    }
  }
  const short = (key: string) => key.slice(0, 8) + '…';
  const followingURL = $derived('https://x.com/' + handle + '/following');
  const knownTotal = $derived(total !== undefined && total >= read ? total : undefined);
</script>

{#if read}
  <p class="hint">
    {read.toLocaleString()}{#if knownTotal !== undefined} of {knownTotal.toLocaleString()}{/if}
    {read === 1 && (knownTotal === undefined || knownTotal === 1) ? 'account' : 'accounts'} loaded from your X following list.
    {#if knownTotal === undefined || read < knownTotal}
      Scroll further in <a href={followingURL} target="_blank" rel="noopener noreferrer">your following list</a> to include more.
    {/if}
  </p>
  <button class="secondary" id="findXFollows" disabled={finding} onclick={find}
    >{finding ? 'Checking…' : found ? 'Refresh Nostr matches' : 'Find my X follows on Nostr'}</button>
{:else}
  <p class="hint">Open @{handle}’s following list on X, then come back here to find those people on Nostr.
    You can start with the first people shown or scroll on X to include more.</p>
  <a class="button secondary" href={followingURL} target="_blank" rel="noopener noreferrer">Open my X following list</a>
{/if}
{#if found}
  {#if found.matches.length}
    <ul class="xMatches">
      {#each found.matches as match (match.pubkey + ':' + match.handle)}
        <li>
          <label class="check"
            ><input type="checkbox" bind:checked={chosen[match.pubkey]} disabled={found.following.includes(match.pubkey)} />
            {match.name ?? '@' + match.handle} <small>@{match.handle} · {short(match.pubkey)}</small>
            {#if found.following.includes(match.pubkey)}<small>· following</small>{/if}</label
          >
        </li>
      {/each}
    </ul>
    <button id="followOnNostr" disabled={!selected.length || !unlocked} onclick={follow}>Follow {selected.length} on Nostr</button>
  {:else}
    <p class="hint">No confirmed Nostr matches found.</p>
  {/if}
  {#if found.loading}
    <p class="hint">Updating the Nostr directory in the background. Refresh in a minute for more matches.</p>
  {/if}
  {#if found.unchecked}
    <p class="hint">{found.unchecked} account links could not be confirmed. Refresh to try again.</p>
  {/if}
{/if}
