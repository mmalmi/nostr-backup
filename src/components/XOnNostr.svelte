<script lang="ts">
  import { paymentConsent } from '../tip-consent.ts';
  import { notice, send } from '../ui.ts';
  import { app } from './page.svelte.ts';
  import type { SourcesView } from './views.ts';
  import XLinkPost from './XLinkPost.svelte';
  import XFollowMatches from './XFollowMatches.svelte';

  // Two optional things: link your X account to this Nostr profile, and follow people you follow on X.
  // Tip buttons are a saved switch; `onchange` saves it with the other Sources settings.
  let {
    view,
    tipButtons = $bindable(false),
    onchange,
  }: { view?: SourcesView; tipButtons?: boolean; onchange: () => void } = $props();

  const handle = $derived(view?.conf.handle ?? '');
  const pubkey = $derived(view?.conf.pubkey ?? '');

  async function toggleTips(event: Event) {
    const field = event.currentTarget as HTMLInputElement;
    const enabled = field.checked;
    try {
      tipButtons = enabled && await paymentConsent(true);
      onchange();
    } catch (e) { tipButtons = false; notice((e as Error).message); }
    field.checked = tipButtons;
  }

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
  <h4>Tips</h4>
  <label class="check"
    ><input type="checkbox" id="tipButtons" checked={tipButtons} onchange={toggleTips} /> Show tip buttons on X</label
  >
  <p class="hint">
    X handles are matched on this device. Click ⚡ to verify the link and check the current Lightning address. Choosing an amount sends the recipient and amount to their payment provider.
    {#if view && !view.lightning}Add a lightning address to your Nostr profile to receive tips yourself.{/if}
  </p>
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
