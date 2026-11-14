<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from './page.svelte.ts';
  import { send } from '../ui.ts';
  import AccountFields, { type Usernames } from './AccountFields.svelte';
  import XLinkPost from './XLinkPost.svelte';
  import XFollowMatches from './XFollowMatches.svelte';
  import SaveKey from './SaveKey.svelte';
  import WizardSteps from './WizardSteps.svelte';

  // Saves the usernames through the Sources settings. Rejects with the error already shown.
  let { save }: { save: (usernames: Usernames) => Promise<void> } = $props();

  // Accounts chosen before signing up or in fill the form; blank ones keep this device's saved usernames.
  const conf = page.status?.conf;
  const chosenFirst = page.accounts;
  page.accounts = undefined;
  // A new account ends setup by offering to save its secret key.
  const created = !!page.created;
  page.created = false;
  let usernames = $state<Usernames>({
    x: chosenFirst?.x || conf?.handle || '',
    instagram: chosenFirst?.instagram || conf?.social?.instagram?.handle || '',
    facebook: chosenFirst?.facebook || conf?.social?.facebook?.handle || '',
  });
  // With an X account, linking it and finding the people you follow come before "You're set".
  // Accounts chosen before signing up or in save at once; the form shows only if that fails.
  let stage = $state<'saving' | 'accounts' | 'nostr' | 'done' | 'key'>(chosenFirst ? 'saving' : 'accounts');
  let saving = $state(false);
  // After signing in with a key, accounts signed in on open tabs fill the empty fields.
  let detected = $state<Partial<Usernames>>({});

  const accounts = [
    { id: 'x', label: 'X', url: (u: string) => 'https://x.com/' + u },
    { id: 'facebook', label: 'Facebook', url: (u: string) => 'https://www.facebook.com/' + u },
    { id: 'instagram', label: 'Instagram', url: (u: string) => 'https://www.instagram.com/' + u + '/' },
  ] as const;
  // Matches how settings store a username.
  const clean = (value: string) => value.trim().replace(/^@/, '').toLowerCase();
  const chosen = $derived(accounts.filter((account) => clean(usernames[account.id])));
  const flow = page.flow ?? (created ? 'signup' : 'signin');
  const picked = $derived({ x: !!clean(usernames.x), any: chosen.length > 0 });

  async function next(event?: SubmitEvent) {
    event?.preventDefault();
    if (saving) return;
    saving = true;
    try {
      await save(usernames);
      if (clean(usernames.x)) stage = 'nostr';
      else if (chosen.length) stage = 'done';
      else if (created) stage = 'key';
      else page.setup = false;
    } catch {
      // The page shows the error; the user can fix the username.
      stage = 'accounts';
    } finally {
      saving = false;
    }
  }
  const finish = () => (page.setup = false);
  // Accounts already chosen during sign-up are saved at once, so the next screen is "You're set".
  onMount(() => {
    if (chosenFirst) return void next();
    send('detectAccounts').then((found) => {
      detected = { x: found.x, instagram: found.instagram };
      for (const id of ['x', 'instagram'] as const) if (found[id] && !usernames[id].trim()) usernames[id] = found[id]!;
    }, () => {});
  });
</script>

<section class="setup" aria-labelledby="setupTitle">
  {#if stage !== 'saving'}<WizardSteps {flow} current={stage} chosen={picked} />{/if}
  {#if stage === 'accounts'}
    <form onsubmit={next}>
      <h2 id="setupTitle">Which accounts should we back up?</h2>
      <p class="hint">Add your usernames. Posts are saved as you scroll your own profile.</p>
      <AccountFields bind:usernames {detected} />
      <div class="setupActions">
        <button type="button" class="quiet" id="skipSetup" onclick={finish}>Skip</button>
        <button type="submit" id="saveSetup" disabled={saving}>Continue</button>
      </div>
    </form>
  {:else if stage === 'nostr'}
    <h2 id="setupTitle">Find each other on Nostr</h2>
    <p class="hint">Both are optional. You can also do them later in Sources.</p>
    <h3>Link your X account</h3>
    <XLinkPost pubkey={page.status?.conf.pubkey ?? ''} xLink={page.status?.xLink} />
    <h3>People you follow on X</h3>
    <XFollowMatches handle={clean(usernames.x)} read={page.status?.xFollows} unlocked={page.status?.unlocked} />
    <button id="nostrNext" class="setupNext" onclick={() => (stage = 'done')}>Continue</button>
  {:else if stage === 'done'}
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
    </ul>
    <button id="finishSetup" onclick={() => (created ? (stage = 'key') : finish())}
      >{created ? 'Continue' : 'Go to your backup'}</button
    >
  {:else if stage === 'key'}
    <SaveKey pubkey={page.status?.conf.pubkey ?? ''} ondone={finish} />
  {/if}
</section>
