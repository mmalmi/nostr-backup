<script module lang="ts">
  export type Usernames = { x: string; instagram: string; facebook: string };
</script>

<script lang="ts">
  import BrandLogo from './BrandLogo.svelte';

  // `detected` holds the accounts signed in on open tabs.
  let {
    usernames = $bindable(),
    detected = {},
    onedit,
  }: { usernames: Usernames; detected?: Partial<Usernames>; onedit?: (id: keyof Usernames) => void } = $props();

  const accounts = [
    { id: 'x', label: 'X', placeholder: '@yourname' },
    { id: 'facebook', label: 'Facebook', placeholder: 'username or profile ID' },
    { id: 'instagram', label: 'Instagram', placeholder: '@yourname' },
  ] as const;
  const clean = (value: string) => value.trim().replace(/^@/, '').toLowerCase();

  // Clearing counts as an edit, so a found X account does not fill the field again.
  function clear(id: keyof Usernames, button: HTMLButtonElement) {
    usernames[id] = '';
    onedit?.(id);
    button.parentElement?.querySelector('input')?.focus();
  }
</script>

{#each accounts as account (account.id)}
  <label
    ><span class="accountLabel"><BrandLogo network={account.id} />{account.label}</span><span class="clearable"
      ><input
        id={'setup-' + account.id}
        bind:value={usernames[account.id]}
        oninput={() => onedit?.(account.id)}
        placeholder={account.placeholder}
        autocomplete="off"
        spellcheck="false"
      />{#if usernames[account.id]}<button
          type="button"
          class="clear"
          id={'clear-' + account.id}
          aria-label={'Clear ' + account.label + ' username'}
          title="Clear"
          onclick={(event) => clear(account.id, event.currentTarget)}>×</button
        >{/if}</span
    ><small class="detected">
      {#if detected[account.id] && clean(usernames[account.id]) === detected[account.id]}
        Signed in on {account.label} in this browser
      {/if}
    </small></label
  >
{/each}
