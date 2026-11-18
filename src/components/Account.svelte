<script lang="ts">
  import { npubEncode } from 'nostr-tools/nip19';
  import { paymentConsent } from '../tip-consent.ts';
  import { receivingAddress } from '../receiving-address.ts';
  import { secretKey } from '../model.ts';
  import { notice, send } from '../ui.ts';
  import { app, page } from './page.svelte.ts';

  type Rule = Awaited<ReturnType<typeof send<'listPermissions'>>>[number];

  const status = $derived(page.status);
  const pubkey = $derived(status?.conf.pubkey ?? '');
  const unlocked = $derived(!!status?.unlocked);
  const open = $derived(page.section === 'account');

  let updatingAddress = $state(false);
  async function changeAddress(enabled: boolean) {
    updatingAddress = true;
    try {
      if (enabled && !await paymentConsent(true)) throw Error('Payment permission is needed to publish the address.');
      await send('receivingAddress', { account: pubkey, enabled });
      await app.refresh(true);
      notice(enabled ? 'Receiving address added to your public profile.' : 'Receiving address removed from your public profile.');
    } finally { updatingAddress = false; }
  }
  let secret = $state('');
  let unlocking = $state(false);
  let confirmingLogout = $state<string>();
  let confirmingDelete = $state<string>();
  let rules = $state<Rule[]>([]);

  // Leaving the panel or changing profile dismisses pending confirmations.
  $effect(() => {
    if (!open || pubkey !== confirmingLogout) confirmingLogout = undefined;
    if (!open || pubkey !== confirmingDelete) confirmingDelete = undefined;
    if (!open) secret = '';
  });
  $effect(() => {
    if (!open || !pubkey) return;
    const owner = pubkey;
    void status; // Reload permissions with each status refresh.
    send('listPermissions', { account: owner })
      .then((next) => {
        if (owner === pubkey) rules = next;
      })
      .catch((e) => notice(e.message));
  });

  const sites = $derived.by(() => {
    const grouped = new Map<string, { allowed: string[]; declined: string[] }>();
    for (const rule of rules) {
      const site = grouped.get(rule.origin) ?? { allowed: [], declined: [] };
      (rule.allow ? site.allowed : site.declined).push(rule.label);
      grouped.set(rule.origin, site);
    }
    return grouped;
  });

  async function copy(text: string, message: string) {
    await navigator.clipboard.writeText(text);
    notice(message);
  }

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
    } catch (e) {
      notice((e as Error).message);
    }
  }
  async function unlock() {
    if (unlocking) return;
    const key = secret;
    secretKey(key);
    unlocking = true;
    secret = '';
    try {
      await send('login', { key, account: pubkey });
      await app.refresh(true);
      notice('');
    } finally {
      unlocking = false;
    }
  }
  // A complete key unlocks as soon as it is pasted.
  function typed() {
    try {
      secretKey(secret);
    } catch {
      return;
    }
    void run(unlock);
  }
</script>

<h2>Profile</h2>
<section>
  <div class="accountRow">
    <div>
      <h3>Profile</h3>
      <a href="#profile">Edit profile and view history</a>
    </div>
    <button id="copyProfileId" class="secondary" hidden={!pubkey}
      onclick={() => run(() => copy(npubEncode(pubkey), 'Profile ID copied.'))}>Copy profile ID</button>
  </div>
  {#if pubkey && unlocked}
    {@const address = receivingAddress(pubkey)}
    {#if status?.profile?.lightning === address}
      <div class="accountRow accountDivider">
        <div>
          <h4>Receiving address</h4>
          <p>Published on your profile via npub.cash.</p>
        </div>
        <div class="actions">
          <button class="secondary" onclick={() => run(() => copy(address, 'Receiving address copied.'))}>Copy address</button>
          <button class="secondary" aria-label="Remove npub.cash address from profile" disabled={updatingAddress}
            onclick={() => run(() => changeAddress(false))}>Remove</button>
        </div>
      </div>
    {:else if !status?.profile?.lightning && !status?.profile?.hasLightning}
      <div class="accountRow accountDivider">
        <div>
          <h4>Receiving address</h4>
          <p>Publish an npub.cash address to receive tips.</p>
        </div>
        <button class="secondary" disabled={updatingAddress} onclick={() => run(() => changeAddress(true))}>Add address</button>
      </div>
    {/if}
  {/if}
  <p id="lockState" class="accountDivider" hidden={unlocked}>
    You can view this backup. Enter your secret key to back up new posts or approve website requests.
  </p>
  <form id="unlock" hidden={unlocked} onsubmit={(e) => (e.preventDefault(), run(unlock))}>
    <label
      >Secret key<input
        id="secret"
        type="password"
        required
        placeholder="Paste your secret key"
        autocomplete="off"
        spellcheck="false"
        disabled={unlocking}
        bind:value={secret}
        oninput={typed}
      /></label
    >
  </form>
  <div class="actions accountDivider">
    <button
      id="lock"
      class="secondary"
      hidden={!unlocked}
      onclick={() =>
        run(async () => {
          await send('lock', { account: pubkey });
          await app.refresh();
          notice('Account locked.');
        })}>Lock account</button
    >
    <button
      id="logout"
      class="secondary"
      hidden={!pubkey || !!confirmingLogout}
      onclick={() => (confirmingLogout = pubkey)}>Log out</button
    >
  </div>
  {#if confirmingLogout}
    <div role="group" aria-labelledby="logoutQuestion">
      <p id="logoutQuestion">Log out of this profile? Your archive will stay on this device.</p>
      {#if unlocked}<p class="hint">Save your secret key before logging out so you can sign back in.</p>{/if}
      <div class="actions">
        <button id="cancelLogout" class="secondary" onclick={() => (confirmingLogout = undefined)}>Cancel</button>
        <button
          id="confirmLogout"
          onclick={() =>
            run(async () => {
              if (!confirmingLogout || confirmingLogout !== pubkey) return;
              await send('logout', { pubkey: confirmingLogout });
              await app.refresh(true);
              notice('Logged out. Your archive is saved on this device.');
            })}>Log out</button
        >
      </div>
    </div>
  {/if}
</section>

{#if unlocked}
  <section class="accountRow secretKeyPanel" aria-labelledby="secretKeyHeading">
    <div>
      <h3 id="secretKeyHeading"><span aria-hidden="true">⚠︎</span> Secret key</h3>
      <p id="secretKeyWarning">Anyone with this key can use your account. Save it in a password manager.</p>
    </div>
    <button id="copyPrivateKey" class="secondary" aria-describedby="secretKeyWarning"
      onclick={() => run(async () => copy(await send('exportPrivateKey', { account: pubkey }), 'Secret key copied.'))}>Copy secret key</button>
  </section>
{/if}

<section id="sitePermissions" hidden={!sites.size}>
  <h3>Website permissions</h3>
  <ul id="permissionList" role="list">
    {#each sites as [origin, site] (origin)}
      <li>
        <div class="permissionSite">{origin}</div>
        <div class="permissionDetails">
          {#if site.allowed.length}<p><strong>Allowed</strong> {site.allowed.join(', ')}</p>{/if}
          {#if site.declined.length}<p><strong>Declined</strong> {site.declined.join(', ')}</p>{/if}
        </div>
        <button
          class="secondary"
          aria-label={'Revoke permissions for ' + origin}
          onclick={() =>
            run(async () => {
              await send('forgetPermissions', { account: pubkey, origin });
              await app.refresh();
            })}>Revoke</button
        >
      </li>
    {/each}
  </ul>
</section>
<section id="manageArchive" hidden={!pubkey}>
  <h3>Local data</h3>
  <p><a href="#storage">See what’s saved on this device</a></p>
  <button id="deleteStart" class="secondary" hidden={!!confirmingDelete} onclick={() => (confirmingDelete = pubkey)}
    >Delete local archive…</button
  >
  <div id="deleteConfirm" hidden={!confirmingDelete}>
    <p>
      Delete the posts, drafts, media, settings and queued deliveries saved in this browser for this profile? Remote
      copies and downloaded ZIPs are kept.
    </p>
    <div class="actions">
      <button
        id="deleteAccount"
        class="danger"
        onclick={() =>
          run(async () => {
            if (!confirmingDelete || confirmingDelete !== pubkey) throw Error('Confirm which archive to delete.');
            await send('deleteAccount', { pubkey: confirmingDelete, confirmed: true });
            confirmingDelete = undefined;
            await app.refresh(true);
            notice('Local archive deleted.');
          })}>Delete local archive</button
      >
      <button id="cancelDelete" class="secondary" onclick={() => (confirmingDelete = undefined)}>Cancel</button>
    </div>
  </div>
</section>
