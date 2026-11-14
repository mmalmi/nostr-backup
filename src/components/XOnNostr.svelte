<script lang="ts">
  import type { XMatch } from '../x-identity.ts';
  import { proofTweet } from '../x-identity.ts';
  import { notice, send } from '../ui.ts';
  import { app } from './page.svelte.ts';
  import type { SourcesView } from './views.ts';

  // Two optional things: link your X account to this Nostr profile, and follow people you follow on X.
  // Tip buttons are a saved switch; `onchange` saves it with the other Sources settings.
  let {
    view,
    tipButtons = $bindable(true),
    onchange,
  }: { view?: SourcesView; tipButtons?: boolean; onchange: () => void } = $props();

  const handle = $derived(view?.conf.handle ?? '');
  const pubkey = $derived(view?.conf.pubkey ?? '');
  const postURL = $derived(pubkey ? 'https://x.com/intent/post?text=' + encodeURIComponent(proofTweet(pubkey)) : '');

  let finding = $state(false);
  let found = $state<{ matches: XMatch[]; unchecked: number; following: string[] }>();
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
  async function unlink() {
    try {
      await send('unlinkX');
      await app.refresh();
      notice('Unlinked. Delete the verification post on X to invalidate its proof.');
    } catch (e) { notice((e as Error).message); }
  }
  const short = (key: string) => key.slice(0, 8) + '…';
</script>

<details class="xNostr">
  <summary>On Nostr</summary>
  <h4>Tips</h4>
  <label class="check"
    ><input type="checkbox" id="tipButtons" bind:checked={tipButtons} {onchange} /> Show tip buttons on X</label
  >
  <p class="hint">
    X handles are matched on this device. Click ⚡ to verify the link and check the current Lightning address.
    {#if view && !view.lightning}Add a lightning address to your Nostr profile to receive tips yourself.{/if}
  </p>
  {#if !handle}
    <p class="hint">Save your X username first.</p>
  {:else}
    <h4>Your X account</h4>
    {#if view?.xLink}
      <p class="hint">
        Linked to this Nostr profile ·
        <a href={'https://x.com/' + view.xLink.handle + '/status/' + view.xLink.proof} target="_blank" rel="noopener noreferrer"
          >proof post</a
        >
      </p>
      <button class="secondary" disabled={!view.unlocked} onclick={unlink}>Unlink X account</button>
      <p class="hint">Lost your Nostr key? Delete the proof post on X. To switch keys, post a new proof for your new profile.</p>
    {:else}
      <p class="hint">
        Optional. Post a short verification on X so people can find you here. It links once the post is backed up.
      </p>
      <a class="button secondary" id="linkX" href={postURL} target="_blank" rel="noopener noreferrer">Post verification on X</a>
    {/if}

    <h4>People you follow on X</h4>
    <p class="hint">
      {view?.xFollows ?? 0} read so far. Open
      <a href={'https://x.com/' + handle + '/following'} target="_blank" rel="noopener noreferrer">your following list</a> and
      scroll to add more.
    </p>
    <button class="secondary" id="findXFollows" disabled={finding || !view?.xFollows} onclick={find}
      >{finding ? 'Checking…' : 'Find them on Nostr'}</button
    >
    {#if found}
      {#if found.matches.length}
        <ul class="xMatches">
          {#each found.matches as match (match.pubkey)}
            <li>
              <label class="check"
                ><input
                  type="checkbox"
                  bind:checked={chosen[match.pubkey]}
                  disabled={found.following.includes(match.pubkey)}
                />
                {match.name ?? '@' + match.handle} <small>@{match.handle} · {short(match.pubkey)}</small>
                {#if found.following.includes(match.pubkey)}<small>· following</small>{/if}</label
              >
            </li>
          {/each}
        </ul>
        <button id="followOnNostr" disabled={!selected.length || !view?.unlocked} onclick={follow}
          >Follow {selected.length} on Nostr</button
        >
      {:else}
        <p class="hint">No verified matches in your local directory yet.</p>
      {/if}
      {#if found.unchecked}
        <p class="hint">X is limiting checks. Try again later to check {found.unchecked} more.</p>
      {/if}
    {/if}
  {/if}
</details>
