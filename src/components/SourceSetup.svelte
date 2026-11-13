<script lang="ts">
  import { page } from './page.svelte.ts';

  type Usernames = { x: string; instagram: string; facebook: string };
  // Saves the usernames through the Sources settings. Rejects with the error already shown.
  let { save }: { save: (usernames: Usernames) => Promise<void> } = $props();

  const conf = page.status?.conf;
  let usernames = $state<Usernames>({
    x: conf?.handle ?? '',
    instagram: conf?.social?.instagram?.handle ?? '',
    facebook: conf?.social?.facebook?.handle ?? '',
  });
  let done = $state(false);
  let saving = $state(false);

  const accounts = [
    { id: 'x', label: 'X', placeholder: '@yourname', url: (u: string) => 'https://x.com/' + u },
    { id: 'instagram', label: 'Instagram', placeholder: '@yourname', url: (u: string) => 'https://www.instagram.com/' + u + '/' },
    { id: 'facebook', label: 'Facebook', placeholder: 'username or profile ID', url: (u: string) => 'https://www.facebook.com/' + u },
  ] as const;
  // Matches how settings store a username.
  const clean = (value: string) => value.trim().replace(/^@/, '').toLowerCase();
  const chosen = $derived(accounts.filter((account) => clean(usernames[account.id])));

  async function next(event: SubmitEvent) {
    event.preventDefault();
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
</script>

<section class="setup" aria-labelledby="setupTitle">
  {#if !done}
    <form onsubmit={next}>
      <h2 id="setupTitle">Which accounts should we back up?</h2>
      <p class="hint">Add your usernames. Posts are saved as you scroll your own profile.</p>
      {#each accounts as account (account.id)}
        <label
          >{account.label}<input
            id={'setup-' + account.id}
            bind:value={usernames[account.id]}
            placeholder={account.placeholder}
            autocomplete="off"
            spellcheck="false"
          /></label
        >
      {/each}
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
