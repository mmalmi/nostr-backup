<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { errorMessage } from '../types.ts';
  import { api, notice, send } from '../ui.ts';
  import { app, page } from './page.svelte.ts';
  import { form, loadForm } from './settings.svelte.ts';
  import ProfileCard from './Profile.svelte';
  import Onboarding from './Onboarding.svelte';
  import Backup from './Backup.svelte';
  import Sources from './Sources.svelte';
  import Media from './Media.svelte';
  import Storage from './Storage.svelte';
  import Account from './Account.svelte';
  import ProfileWorkspace from './ProfileWorkspace.svelte';
  import SourceSetup from './SourceSetup.svelte';

  const sections = [
    ['archive', 'Backup'],
    ['sources', 'Sources'],
    ['media', 'Media'],
    ['storage', 'Storage'],
    ['profile', 'Profile'],
    ['account', 'Keys & access'],
  ] as const;

  let sources: ReturnType<typeof Sources>;
  let onboarding: ReturnType<typeof Onboarding>;
  let refreshId = 0,
    lastRefresh = 0,
    pubkey = '';

  const status = $derived(page.status);
  const signedIn = $derived(!!status?.conf.pubkey);

  function selectSection() {
    if (location.hash === '#settings') history.replaceState(null, '', '#account');
    if (location.hash === '#x' || location.hash === '#profiles') history.replaceState(null, '', '#sources');
    const hash = location.hash.slice(1);
    page.section = sections.some(([id]) => id === hash) ? hash : 'archive';
  }

  /** Loads the latest status. `initial` also reloads settings fields that are not being edited. */
  async function refresh(initial = false) {
    const request = ++refreshId;
    const next = await send('status');
    if (request !== refreshId) return;
    lastRefresh = Date.now();
    const changed = pubkey !== next.conf.pubkey;
    pubkey = next.conf.pubkey;
    if (!pubkey) page.setup = false;
    page.status = next;
    const { conf, unlocked, x, social, localX, xLink, xFollows, xFollowingTotal } = next;
    sources.show({ conf, unlocked, x, social, localX, xLink, xFollows, xFollowingTotal, lightning: next.profile?.lightning }, changed ? 'replace' : initial ? 'sync' : 'none');
    if (initial || changed) loadForm(conf);
    if (pubkey && changed && !location.hash) {
      history.replaceState(null, '', '#archive');
      selectSection();
    }
    if (!pubkey && (initial || changed)) {
      await tick();
      onboarding.focus();
    }
  }

  async function save(quiet = false) {
    try {
      await send('settings', {
        pubkey,
        account: pubkey,
        ...sources.values(),
        relays: form.relays,
        blossomServer: form.blossomServers,
        mediaMiB: form.mediaMiB ?? undefined,
        relaySync: form.relaySync,
        relayKinds: { mode: form.kindMode, list: form.kinds },
      });
    } catch (error) {
      notice(errorMessage(error));
      throw error;
    }
    await refresh(true);
    if (!quiet) notice('Saved.');
  }

  // The setup step saves usernames through the Sources settings, so validation is shared.
  async function saveUsernames(usernames: { x: string; instagram: string; facebook: string }) {
    sources.useUsernames(usernames);
    try {
      await save(true);
    } catch (error) {
      await refresh(true);
      throw error;
    }
  }

  onMount(() => {
    app.refresh = refresh;
    selectSection();
    const show = () => refresh().catch((e) => notice(e.message));
    const hashchange = () => {
      selectSection();
      show();
    };
    addEventListener('hashchange', hashchange);
    const changed = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && changes.settingsChanged) show();
    };
    api.storage?.onChanged?.addListener(changed);
    refresh(true).catch((e) => notice(e.message));
    // Poll every second while syncing, otherwise every few seconds.
    const timer = setInterval(() => {
      if (!document.hidden && (page.status?.running || Date.now() - lastRefresh >= 2500)) show();
    }, 1000);
    // The page lives as long as its tab, so the storage listener is never removed.
    return () => {
      clearInterval(timer);
      removeEventListener('hashchange', hashchange);
    };
  });
</script>

<header class="appHeader">
  <h1 class="brand"><img src="icon.svg" alt="" width="28" height="28" />Social Backup</h1>
  <ProfileCard pubkey={status?.conf.pubkey} profile={status?.profile} readOnly={!status?.unlocked} />
</header>
<section id="onboarding" aria-label="Profile setup" hidden={!status || signedIn}>
  <Onboarding bind:this={onboarding} />
</section>
{#if signedIn && page.setup}<SourceSetup save={saveUsernames} />{/if}
<div class="workspace" id="workspace" hidden={!signedIn || page.setup}>
  <nav aria-label="Backup sections">
    {#each sections as [id, label] (id)}
      <a href={'#' + id} aria-current={page.section === id ? 'page' : undefined}>{label}</a>
    {/each}
  </nav>
  <div class="panels">
    <div data-panel="archive" hidden={page.section !== 'archive'}><Backup {save} /></div>
    <div data-panel="sources" hidden={page.section !== 'sources'}>
      <Sources bind:this={sources} {save} activeAccount={page.section === 'sources' && !page.setup ? status?.conf.pubkey : undefined} />
    </div>
    <div data-panel="media" hidden={page.section !== 'media'}><Media {save} /></div>
    <div data-panel="storage" hidden={page.section !== 'storage'}><Storage /></div>
    {#if page.section === 'profile' && status?.conf.pubkey}
      <div data-panel="profile">{#key status.conf.pubkey}<ProfileWorkspace account={status.conf.pubkey} unlocked={status.unlocked} />{/key}</div>
    {/if}
    <div data-panel="account" hidden={page.section !== 'account'}><Account /></div>
  </div>
</div>
<!-- Saves every setting at once, for tests and scripts that set fields directly. -->
<form
  id="backupSettings"
  hidden
  onsubmit={(e) => {
    e.preventDefault();
    save().catch(() => {});
  }}
>
  <textarea id="relays" bind:value={form.relays}></textarea>
</form>
