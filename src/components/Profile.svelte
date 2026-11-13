<script lang="ts">
  import Avatar from '@iris/svelte-ui/Avatar.svelte';
  import { npubEncode } from 'nostr-tools/nip19';
  import type { Profile } from '../types.ts';

  // `onopen` replaces the Iris profile link, for example to open the backup page from the popup.
  let {
    pubkey = '',
    profile,
    readOnly = false,
    onopen,
  }: { pubkey?: string; profile?: Profile; readOnly?: boolean; onopen?: () => void } = $props();

  const name = $derived(profile?.displayName || 'Your profile');
  const handle = $derived(profile?.name && profile.name !== name ? '@' + profile.name : '');
</script>

<a
  id="signedInProfile"
  class="profile"
  target={onopen ? undefined : '_blank'}
  rel="noopener noreferrer"
  title={onopen ? 'Open backup' : 'View profile on Iris'}
  href={!pubkey ? undefined : onopen ? 'archive.html' : 'https://iris.to/' + npubEncode(pubkey)}
  onclick={(event) => {
    if (!onopen) return;
    event.preventDefault();
    onopen();
  }}
  hidden={!pubkey}
>
  <!-- The Iris avatar falls back to an identicon. Pictures load directly, not through an image proxy. -->
  <span class="avatar">
    <Avatar {pubkey} picture={pubkey ? profile?.picture : undefined} name={name} size={42} imgProxy={false} />
  </span>
  <span class="profileText"
    ><strong id="displayName">{name}</strong><small id="profileIdentity" hidden={!handle}>{handle}</small><small
      id="profileMode"
      class="profileMode"
      hidden={!pubkey || !readOnly}>Read-only</small
    ></span
  >
</a>
