<script lang="ts">
  import Avatar from '@iris/svelte-ui/Avatar.svelte';
  import { npubEncode } from 'nostr-tools/nip19';
  import type { NostrCard } from '../types.ts';
  import { notice, send } from '../ui.ts';

  // The verified Nostr profile of the X account in the current tab.
  let { card, canFollow }: { card: NostrCard; canFollow: boolean } = $props();
  let following = $state(false);
  let pending = $state(false);
  $effect(() => {
    following = card.following;
  });

  const href = $derived('https://iris.to/' + npubEncode(card.pubkey));
  const name = $derived(card.profile?.displayName || '@' + card.handle);

  async function follow() {
    pending = true;
    try {
      await send('followOnNostr', { pubkeys: [card.pubkey] });
      following = true;
    } catch (e) {
      notice((e as Error).message);
    } finally {
      pending = false;
    }
  }
</script>

<section id="nostrCard" aria-label={'@' + card.handle + ' on Nostr'}>
  <div class="nostrCardTop">
    <a class="profile" {href} target="_blank" rel="noopener noreferrer" title="Open on Iris">
      <span class="avatar"><Avatar pubkey={card.pubkey} picture={card.profile?.picture} {name} size={42} imgProxy={false} /></span>
      <span class="profileText"><strong>{name}</strong><small>@{card.handle} on Nostr</small></span>
    </a>
    {#if canFollow}
      <button type="button" class="follow" disabled={following || pending} onclick={follow}
        >{following ? 'Following' : 'Follow'}</button
      >
    {/if}
  </div>
  {#if card.profile?.about}<p class="about">{card.profile.about}</p>{/if}
  <p class="nostrCardMeta">
    {#if card.followers}{card.followers.toLocaleString()} known followers ·{' '}{/if}<a
      {href}
      target="_blank"
      rel="noopener noreferrer">Open on Iris</a
    >
  </p>
</section>
