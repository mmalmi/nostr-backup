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

  const origins = $derived([...new Set(rules.map((rule) => rule.origin))]);
  // "Allowed: posts, reactions · Declined: app data"
  const kinds = (origin: string) => {
    const of = (allow: boolean) =>
      rules.filter((rule) => rule.origin === origin && rule.allow === allow).map((rule) => rule.label).join(', ');
    return [of(true) && 'Allowed: ' + of(true), of(false) && 'Declined: ' + of(false)].filter(Boolean).join(' · ');
  };

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

<h2>Account</h2>
<section>
  <h3>Profile</h3>
  <p id="lockState" hidden={unlocked}>
    You can view this backup. Enter your secret key to back up new posts or approve website requests.
  </p>
  <label id="currentIdentity" hidden={!pubkey}
    >User ID<input id="accountNpub" readonly spellcheck="false" value={pubkey ? npubEncode(pubkey) : ''} /></label
  >
  <p class="hint">
    Your user ID is safe to share. Keep a copy of your secret key somewhere private. Anyone with it can use your account.
  </p>
  {#if pubkey && unlocked}
    {#if status?.profile?.lightning === receivingAddress(pubkey)}
      <p class="hint">Your public receiving address is {status.profile.lightning}.</p>
      <button class="secondary" disabled={updatingAddress} onclick={() => run(() => changeAddress(false))}>Remove npub.cash from profile</button>
    {:else if !status?.profile?.lightning && !status?.profile?.hasLightning}
      <button class="secondary" disabled={updatingAddress} onclick={() => run(() => changeAddress(true))}>Add npub.cash address to public profile</button>
    {/if}
  {/if}
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
  <div class="actions">
    <button
      id="copyPrivateKey"
      class="secondary"
      hidden={!unlocked}
      onclick={() =>
        run(async () => {
          await navigator.clipboard.writeText(await send('exportPrivateKey', { account: pubkey }));
          notice('Secret key copied.');
        })}>Copy secret key</button
    >
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

<section id="sitePermissions" hidden={!rules.length}>
  <h3>Website permissions</h3>
  <ul id="permissionList">
    {#each origins as origin (origin)}
      <li>
        {origin} · {kinds(origin)}
        <button
          class="secondary"
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
