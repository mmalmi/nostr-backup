<script lang="ts">
  import { proofTweet } from '../x-identity.ts';
  import type { XLink } from '../types.ts';

  // Links your X account to this Nostr profile with a public verification post.
  let { pubkey, xLink }: { pubkey: string; xLink?: XLink } = $props();
  const postURL = $derived(pubkey ? 'https://x.com/intent/post?text=' + encodeURIComponent(proofTweet(pubkey)) : '');
</script>

{#if xLink}
  <p class="hint" id="xLinked">
    Linked to this Nostr profile ·
    <a href={'https://x.com/' + xLink.handle + '/status/' + xLink.proof} target="_blank" rel="noopener noreferrer">proof post</a>
  </p>
{:else}
  <p class="hint">Post a short verification on X so people can find you on Nostr. It links once the post is backed up.</p>
  <a class="button secondary" id="linkX" href={postURL} target="_blank" rel="noopener noreferrer">Post verification on X</a>
{/if}
