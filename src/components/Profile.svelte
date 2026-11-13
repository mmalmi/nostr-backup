<script lang="ts">
  import Avatar from '@iris/svelte-ui/Avatar.svelte';
  import { npubEncode } from 'nostr-tools/nip19';
  import type { Profile } from '../types.ts';

  let { pubkey = '', profile, readOnly = false }: { pubkey?: string; profile?: Profile; readOnly?: boolean } =
    $props();

  const name = $derived(profile?.displayName || 'Your profile');
  const handle = $derived(profile?.name && profile.name !== name ? '@' + profile.name : '');
</script>

<a
  id="signedInProfile"
  class="profile"
  target="_blank"
  rel="noopener noreferrer"
  title="View profile on Iris"
  href={pubkey ? 'https://iris.to/' + npubEncode(pubkey) : undefined}
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
