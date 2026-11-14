<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from './page.svelte.ts';
  import AccountFields, { type Usernames } from './AccountFields.svelte';

  // Saves the usernames through the Sources settings. Rejects with the error already shown.
  let { save }: { save: (usernames: Usernames) => Promise<void> } = $props();

  // Accounts chosen before signing up or in fill the form; blank ones keep this device's saved usernames.
  const conf = page.status?.conf;
  const chosenFirst = page.accounts;
  page.accounts = undefined;
  let usernames = $state<Usernames>({
    x: chosenFirst?.x || conf?.handle || '',
    instagram: chosenFirst?.instagram || conf?.social?.instagram?.handle || '',
    facebook: chosenFirst?.facebook || conf?.social?.facebook?.handle || '',
  });
  let done = $state(false);
  let saving = $state(false);

  const accounts = [
    { id: 'x', label: 'X', url: (u: string) => 'https://x.com/' + u },
    { id: 'facebook', label: 'Facebook', url: (u: string) => 'https://www.facebook.com/' + u },
    { id: 'instagram', label: 'Instagram', url: (u: string) => 'https://www.instagram.com/' + u + '/' },
  ] as const;
  // Matches how settings store a username.
  const clean = (value: string) => value.trim().replace(/^@/, '').toLowerCase();
  const chosen = $derived(accounts.filter((account) => clean(usernames[account.id])));

  async function next(event?: SubmitEvent) {
    event?.preventDefault();
    if (saving) return;
    saving = true;
    try {
      await save(usernames);
      if (chosen.length) done = true;
      else page.setup = false;
    } catch {
      // The page shows the error; the user can fix the username.
    } finally {
      saving = false;
    }
  }
  const finish = () => (page.setup = false);
  // Accounts already chosen during sign-up are saved at once, so the next screen is "You're set".
  onMount(() => {
    if (chosenFirst) void next();
  });
</script>

<section class="setup" aria-labelledby="setupTitle">
  {#if !done}
    <form onsubmit={next}>
      <h2 id="setupTitle">Which accounts should we back up?</h2>
      <p class="hint">Add your usernames. Posts are saved as you scroll your own profile.</p>
      <AccountFields bind:usernames />
      <div class="setupActions">
        <button type="button" class="quiet" id="skipSetup" onclick={finish}>Skip</button>
        <button type="submit" id="saveSetup" disabled={saving}>Continue</button>
      </div>
    </form>
  {:else}
    <h2 id="setupTitle">You're set</h2>
    <p class="hint">Open each profile and scroll down. Social Backup saves your posts as they appear.</p>
    <ul class="setupLinks">
      {#each chosen as account (account.id)}
        <li>
          <a href={account.url(clean(usernames[account.id]))} target="_blank" rel="noopener noreferrer"
            >Open your {account.label} profile</a
          >
        </li>
      {/each}
      {#if clean(usernames.x)}
        <li>
          <a href={'https://x.com/' + clean(usernames.x) + '/following'} target="_blank" rel="noopener noreferrer"
            >Open who you follow on X</a
          ><small>Scroll it, then find them on Nostr from Sources.</small>
        </li>
      {/if}
    </ul>
    <button id="finishSetup" onclick={finish}>Go to your backup</button>
  {/if}
</section>
