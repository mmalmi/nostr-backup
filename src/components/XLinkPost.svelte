<script lang="ts">
  import { proofTweet } from '../x-identity.ts';
  import type { XLink } from '../types.ts';
  import { notice, send } from '../ui.ts';
  import { app } from './page.svelte.ts';

  // Links your X account to this Nostr profile with a public verification post. It links as soon as
  // the post shows on an X page; pasting its link works too, whatever X's pages look like.
  let { pubkey, xLink, handle = '' }: { pubkey: string; xLink?: XLink; handle?: string } = $props();
  const postURL = $derived(pubkey ? 'https://x.com/intent/post?text=' + encodeURIComponent(proofTweet(pubkey)) : '');
  let posted = $state(false);
  let link = $state('');
  let checking = $state(false);

  async function usePasted(event: SubmitEvent) {
    event.preventDefault();
    checking = true;
    try {
      await send('xProof', { url: link });
      link = '';
      await app.refresh();
    } catch (e) {
      notice((e as Error).message);
    } finally {
      checking = false;
    }
  }
</script>

{#if xLink}
  <p class="hint" id="xLinked">
    Linked to this Nostr profile ·
    <a href={'https://x.com/' + xLink.handle + '/status/' + xLink.proof} target="_blank" rel="noopener noreferrer">proof post</a>
  </p>
{:else}
  <p class="hint">Post a short verification on X so people can find you on Nostr.</p>
  <a class="button secondary" id="linkX" href={postURL} target="_blank" rel="noopener noreferrer" onclick={() => (posted = true)}
    >Post verification on X</a
  >
  {#if posted}
    <p class="hint" id="xLinkWaiting">
      Posted? It links as soon as your post shows on X{#if handle}, for example on <a
          href={'https://x.com/' + handle}
          target="_blank"
          rel="noopener noreferrer">your profile</a
        >{/if}.
    </p>
    <form class="pasteProof" onsubmit={usePasted}>
      <input
        id="proofLink"
        bind:value={link}
        placeholder="Or paste the link to your post"
        aria-label="Link to your verification post"
        autocomplete="off"
        spellcheck="false"
      />
      <button type="submit" class="secondary" id="useProofLink" disabled={checking || !link.trim()}>{checking ? 'Checking…' : 'Link'}</button>
    </form>
  {/if}
{/if}
