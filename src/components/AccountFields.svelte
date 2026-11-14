<script module lang="ts">
  export type Usernames = { x: string; instagram: string; facebook: string };
</script>

<script lang="ts">
  // `detected` is the X account signed in on an open X tab, if any.
  let {
    usernames = $bindable(),
    detected = '',
    onedit,
  }: { usernames: Usernames; detected?: string; onedit?: (id: keyof Usernames) => void } = $props();

  const accounts = [
    { id: 'x', label: 'X', placeholder: '@yourname' },
    { id: 'facebook', label: 'Facebook', placeholder: 'username or profile ID' },
    { id: 'instagram', label: 'Instagram', placeholder: '@yourname' },
  ] as const;
  const clean = (value: string) => value.trim().replace(/^@/, '').toLowerCase();
</script>

{#each accounts as account (account.id)}
  <label
    >{account.label}<input
      id={'setup-' + account.id}
      bind:value={usernames[account.id]}
      oninput={() => onedit?.(account.id)}
      placeholder={account.placeholder}
      autocomplete="off"
      spellcheck="false"
    />{#if account.id === 'x' && detected && clean(usernames.x) === detected}<small class="detected"
        >Signed in on X in this browser</small
      >{/if}</label
  >
{/each}
