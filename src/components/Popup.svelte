<script lang="ts">
  import { onMount } from 'svelte';
  import type { SocialNetwork, Status } from '../types.ts';
  import { api, notice, send } from '../ui.ts';
  import { captureNetwork } from '../social.ts';
  import ProfileCard from './Profile.svelte';
  import XStats from './XStats.svelte';

  let status = $state<Status>();
  let site = $state<ReturnType<typeof captureNetwork>>();

  async function openBackup() {
    await api.runtime.openOptionsPage();
    window.close();
  }

  async function refresh() {
    const [next, tabs] = await Promise.all([send('status'), api.tabs.query({ active: true, currentWindow: true })]);
    if (!next.conf.pubkey) return openBackup();
    site = captureNetwork(tabs[0]?.url);
    status = next;
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

<h1 class="brand"><img src="icon.svg" alt="" width="20" height="20" />Social Backup</h1>
<div id="backupActions" hidden={!status}>
  <ProfileCard pubkey={status?.conf.pubkey} profile={status?.profile} readOnly={!status?.unlocked} />
  <p id="summary">{status?.events ?? 0} backed-up {status?.events === 1 ? 'item' : 'items'}</p>
  <p id="socialPopup" hidden={!socialLine}>{socialLine}</p>
  <section id="xPopupStats" hidden={site !== 'x'} aria-label="X capture statistics">
    <h2>X backup</h2>
    <XStats x={status?.x} />
    <p id="xCaptureState">{xLine}</p>
  </section>
  <button id="open" onclick={openBackup}>Open backup</button>
</div>
