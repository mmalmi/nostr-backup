<script lang="ts">
  import type { XMatch } from '../x-identity.ts';
  import { notice, send } from '../ui.ts';
  import { app } from './page.svelte.ts';

  // People you follow on X who have a verified link to a Nostr profile, ready to follow there.
  let { handle, read = 0, unlocked = false }: { handle: string; read?: number; unlocked?: boolean } = $props();

  let finding = $state(false);
  let found = $state<{ matches: XMatch[]; unchecked: number; following: string[]; loading?: boolean }>();
  let chosen = $state<Record<string, boolean>>({});

  async function find() {
    finding = true;
    try {
      found = await send('findXFollows');
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
</script>

<p class="hint">
  {#if read}Found {read} {read === 1 ? 'account' : 'accounts'} you follow on X.{/if}
  Open <a href={'https://x.com/' + handle + '/following'} target="_blank" rel="noopener noreferrer">@{handle}’s following list</a>
  and scroll to {read ? 'find more' : 'load the accounts you follow'}.
</p>
<button class="secondary" id="findXFollows" disabled={finding || !read} onclick={find}
  >{finding ? 'Checking…' : 'Find matching Nostr profiles'}</button
>
{#if found}
  {#if found.matches.length}
    <ul class="xMatches">
      {#each found.matches as match (match.pubkey)}
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
    <p class="hint">None of them have a verified Nostr link yet.</p>
  {/if}
  {#if found.loading}
    <p class="hint">Still collecting verified Nostr links. Check again in a minute for more.</p>
  {/if}
  {#if found.unchecked}
    <p class="hint">X is limiting checks. Try again later to check {found.unchecked} more.</p>
  {/if}
{/if}
