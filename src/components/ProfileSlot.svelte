<script lang="ts">
  import type { Profile } from '../types.ts';
  import ProfileCard from './Profile.svelte';

  // Lets plain page code update the profile card until the whole page is a component.
  let shown = $state<{ pubkey: string; profile?: Profile; readOnly: boolean }>({ pubkey: '', readOnly: false });
  export function show(pubkey: string, profile: Profile | undefined, readOnly: boolean) {
    shown = { pubkey, profile, readOnly };
  }
</script>

<ProfileCard pubkey={shown.pubkey} profile={shown.profile} readOnly={shown.readOnly} />
