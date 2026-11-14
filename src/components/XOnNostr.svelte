<script lang="ts">
  import { notice, send } from '../ui.ts';
  import { app } from './page.svelte.ts';
  import type { SourcesView } from './views.ts';
  import XLinkPost from './XLinkPost.svelte';
  import XFollowMatches from './XFollowMatches.svelte';

  // Two optional things: link your X account to this Nostr profile, and follow people you follow on X.
  let { view }: { view?: SourcesView } = $props();

  const handle = $derived(view?.conf.handle ?? '');
  const pubkey = $derived(view?.conf.pubkey ?? '');


  async function unlink() {
    try {
      await send('unlinkX');
      await app.refresh();
      notice('Unlinked. Delete the verification post on X to invalidate its proof.');
    } catch (e) { notice((e as Error).message); }
  }
</script>

<details class="xNostr">
  <summary>On Nostr</summary>
  {#if !handle}
    <p class="hint">Save your X username first.</p>
  {:else}
    <h4>Your X account</h4>
    <XLinkPost {pubkey} xLink={view?.xLink} />
    {#if view?.xLink}
      <button class="secondary" disabled={!view.unlocked} onclick={unlink}>Unlink X account</button>
      <p class="hint">Lost your Nostr key? Delete the proof post on X. To switch keys, post a new proof for your new profile.</p>
    {/if}

    <h4>People you follow on X</h4>
    <XFollowMatches {handle} read={view?.xFollows} unlocked={view?.unlocked} />
  {/if}
</details>
