<script lang="ts">
  import { onMount } from 'svelte';
  import type { NostrCard, Status } from '../types.ts';
  import { api, notice, send } from '../ui.ts';
  import { captureNetwork } from '../social.ts';
  import { siteName, siteState, type TabReport } from '../site-status.ts';
  import ProfileCard from './Profile.svelte';
  import NostrCardView from './NostrCard.svelte';
  import { profileHandle } from '../x.ts';

  let status = $state<Status>();
  let site = $state<ReturnType<typeof captureNetwork>>();
  // What the settings cannot tell about this tab, such as posts on its page that stay out of the backup.
  let reported = $state<TabReport>();
  let card = $state<NostrCard | null>(null);
  let looked = false;

  async function openBackup() {
    await api.runtime.openOptionsPage();
    window.close();
  }

  async function refresh() {
    const [next, tabs] = await Promise.all([send('status'), api.tabs.query({ active: true, currentWindow: true })]);
    if (!next.conf.pubkey) return openBackup();
    const tab = tabs[0], here = captureNetwork(tab?.url);
    const key = `site-${tab?.id ?? -1}` as const;
    const saved = here ? (await api.storage.session.get(key))[key] : undefined;
    site = here;
    reported = saved?.site === here ? saved : undefined;
    status = next;
    // Once per opening: the Nostr profile of the X account in this tab, when it has a verified link.
    const handle = site === 'x' ? profileHandle(tab?.url) : undefined;
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

  // On X, Facebook and Instagram: what the backup is doing in this tab, as on the toolbar icon.
  const shown = $derived(status && site ? siteState(site, status.conf, status.unlocked, reported) : undefined);
  const count = (n: number, one: string, many: string) => n.toLocaleString() + ' ' + (n === 1 ? one : many);
  // One number: the posts saved from the site in this tab, or the size of the whole backup elsewhere.
  const summary = $derived.by(() => {
    const here = site;
    if (!status) return '';
    if (!here) return count(status.events, 'item', 'items') + ' in your backup';
    if (here !== 'x') return count(status.social?.[here].saved ?? 0, 'post', 'posts') + ' saved from ' + siteName(here);
    const waiting = status.x.drafts + (status.x.media ?? 0);
    return count(status.x.captured, 'post', 'posts') + ' saved from X' + (waiting ? ' · ' + waiting.toLocaleString() + ' in progress' : '');
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
  <p id="siteState" data-level={shown?.level ?? 'off'} hidden={!shown}>{shown?.text}</p>
  <p id="summary">{summary}</p>
  <button id="open" onclick={openBackup}>Open backup</button>
  {#if card}<NostrCardView {card} canFollow={!!status?.unlocked} />{/if}
</div>
