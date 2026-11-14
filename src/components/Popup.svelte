<script lang="ts">
  import { onMount } from 'svelte';
  import type { NostrCard, SocialNetwork, Status } from '../types.ts';
  import { api, notice, send } from '../ui.ts';
  import { captureNetwork } from '../social.ts';
  import ProfileCard from './Profile.svelte';
  import XStats from './XStats.svelte';
  import NostrCardView from './NostrCard.svelte';
  import { profileHandle } from '../x.ts';

  let status = $state<Status>();
  let site = $state<ReturnType<typeof captureNetwork>>();
  let card = $state<NostrCard | null>(null);
  let looked = false;

  async function openBackup() {
    await api.runtime.openOptionsPage();
    window.close();
  }

  async function refresh() {
    const [next, tabs] = await Promise.all([send('status'), api.tabs.query({ active: true, currentWindow: true })]);
    if (!next.conf.pubkey) return openBackup();
    site = captureNetwork(tabs[0]?.url);
    status = next;
    // Once per opening: the Nostr profile of the X account in this tab, when it has a verified link.
    const handle = site === 'x' ? profileHandle(tabs[0]?.url) : undefined;
    if (!looked && handle && handle !== next.conf.handle) {
      looked = true;
      send('nostrCard', { handle }).then((found) => (card = found), () => {});
    }
  }

  onMount(() => {
    refresh().catch((e) => notice(e.message));
    const timer = setInterval(() => {
      if (!document.hidden) refresh().catch((e) => notice(e.message));
    }, 1500);
    return () => clearInterval(timer);
  });

  const socialLine = $derived.by(() => {
    if (!status || (site !== 'instagram' && site !== 'facebook')) return '';
    const network: SocialNetwork = site;
    const label = network === 'instagram' ? 'Instagram' : 'Facebook';
    const selection = status.conf.social?.[network];
    if (!status.unlocked) return label + ' backup paused · Read-only mode';
    if (!selection?.capture) return label + ' backup off';
    if (!selection.handle) return 'Add your ' + label + ' username in Sources';
    return label + ' · ' + (status.social?.[network].saved ?? 0) + ' backed up for ' + selection.handle;
  });
  const xLine = $derived.by(() => {
    if (!status) return '';
    if (!status.unlocked) return 'Capture paused · Read-only mode';
    if (!status.conf.capture) return 'Backup off';
    return status.conf.handle ? 'Backing up @' + status.conf.handle : 'Add your X username in Sources';
  });
</script>

<div id="backupActions" hidden={!status}>
  <header class="popupHeader">
    <ProfileCard
      pubkey={status?.conf.pubkey}
      profile={status?.profile}
      readOnly={!status?.unlocked}
      onopen={() => void openBackup()}
    />
    <img class="popupMark" src="icon.svg" alt="Social Backup" title="Social Backup" width="18" height="18" />
  </header>
  <p id="summary">{status?.events ?? 0} backed-up {status?.events === 1 ? 'item' : 'items'}</p>
  <p id="socialPopup" hidden={!socialLine}>{socialLine}</p>
  <section id="xPopupStats" hidden={site !== 'x'} aria-label="X capture statistics">
    <h2>X backup</h2>
    <XStats x={status?.x} />
    <p id="xCaptureState">{xLine}</p>
  </section>
  <button id="open" onclick={openBackup}>Open backup</button>
  {#if card}<NostrCardView {card} canFollow={!!status?.unlocked} />{/if}
</div>
