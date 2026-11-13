import { errorMessage, type Profile } from './types.ts';
import { mediaServers, publicMediaURL } from './media-refs.ts';
import { settings } from './accounts.ts';
import { resetOnboarding, setupOnboarding } from './onboarding.ts';
import { showRelayStatus } from './relay-status-ui.ts';
import { DEFAULT_RELAYS } from './default-relays.ts';
import { relayList } from './model.ts';
import { indexName } from './index-pointer.ts';
import { showStorage } from './storage-ui.ts';
import { api, el, send, notice, on } from './ui.ts';
import { dump, openArchive } from './archive.ts';
import { downloadBlob, mediaConfig, refreshMedia } from './media-ui.ts';
import { DEFAULT_MEDIA_MIB } from './media-files.ts';
import { mount } from 'svelte';
import Sources from './components/Sources.svelte';
import ProfileSlot from './components/ProfileSlot.svelte';
import type { SourcesPanel } from './components/views.ts';
import Account from './components/Account.svelte';
import { app, page } from './components/page.svelte.ts';

const header = mount(ProfileSlot, { target: el('profileSlot') }) as {
  show(pubkey: string, profile: Profile | undefined, readOnly: boolean): void;
};
const sources = mount(Sources, {
  target: el('sourcesPanel'),
  props: {
    save: () =>
      saveSettings().catch((error) => {
        notice(errorMessage(error));
        throw error;
      }),
  },
}) as SourcesPanel;
mount(Account, { target: el('accountPanel') });
app.refresh = (initial) => refresh(initial);

let archiveName: string | undefined,
  publishing = false,
  refreshId = 0;
let shownRelays = '';
function showRelays(relays: string[]) {
  const state = JSON.stringify(relays);
  if (state === shownRelays) return;
  shownRelays = state;
  el('relaySummary').textContent = `Relays (${relays.length})`;
  el('relayChoices').replaceChildren(
    ...[...new Set([...DEFAULT_RELAYS, ...relays])].map((url) => {
      const label = document.createElement('label');
      label.className = 'check';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = url;
      checkbox.checked = relays.includes(url);
      label.append(checkbox, ' ' + new URL(url).host);
      return label;
    }),
  );
}
function selectSection() {
  if (location.hash === '#settings') history.replaceState(null, '', '#account');
  if (location.hash === '#x' || location.hash === '#profiles') history.replaceState(null, '', '#sources');
  const links = [...document.querySelectorAll<HTMLAnchorElement>('nav a')];
  const current = links.find((link) => link.hash === location.hash) ?? links[0];
  for (const link of links) {
    if (link === current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  for (const panel of document.querySelectorAll<HTMLElement>('[data-panel]'))
    panel.hidden = '#' + panel.dataset.panel !== current.hash;
  page.section = current.hash.slice(1);
}
window.addEventListener('hashchange', () => {
  selectSection();
  refresh().catch((e) => notice(e.message));
});
let pubkey = '',
  queuingBroadcast = false,
  syncing = false,
  lastRefresh = 0;
async function refresh(initial = false) {
  const request = ++refreshId;
  const status = await send('status');
  const {
    conf,
    profile,
    unlocked,
    events,
    drafts,
    pending,
    relays,
    x,
    social,
    localX,
    running,
    indexHash,
    pointer,
    preparingIndex,
  } = status;
  if (request !== refreshId) return;
  syncing = running;
  lastRefresh = Date.now();
  const changed = pubkey !== conf.pubkey;
  if (changed) resetOnboarding();
  page.status = status;
  archiveName = conf.archiveName;
  pubkey = conf.pubkey;
  header.show(pubkey, profile, !unlocked);
  sources.show({ conf, unlocked, x, social, localX }, changed ? 'replace' : initial ? 'sync' : 'none');
  mediaConfig(conf, unlocked);
  if (pubkey && !el('onboarding').hidden && !location.hash) {
    history.replaceState(null, '', '#archive');
    selectSection();
  }
  const enteringWelcome = !pubkey && el('onboarding').hidden;
  el('onboarding').hidden = !!pubkey;
  if (enteringWelcome) el('profileName').focus();
  el('workspace').hidden = !pubkey;
  if (pubkey && location.hash === '#media') {
    await refreshMedia();
    if (request !== refreshId) return;
  }
  showStorage(conf, location.hash === '#storage');
  if (initial || changed) {
    el('blossomServer').value = mediaServers(conf).join('\n');
    el('mediaMiB').value = String(conf.mediaMiB ?? DEFAULT_MEDIA_MIB);
    el('relays').value = conf.relays.join('\n');
    showRelays(conf.relays);
    const filter = conf.relayKinds;
    el('kindMode').value = filter?.mode ?? 'all';
    el('downloadKinds').value = filter?.kinds.join(', ') ?? '';
    el('kindListField').hidden = !filter;
    let summary = 'Download all event kinds';
    if (filter) {
      const selection = (filter.kinds.length === 1 ? 'kind ' : 'kinds ') + filter.kinds.join(', ');
      summary = (filter.mode === 'include' ? 'Download only ' : 'Download all except ') + selection;
    }
    el('kindSummary').textContent = summary;
    el('relaySync').checked = conf.relaySync;
  }
  el('backupSettings').hidden = !pubkey;
  el('download').disabled = !pubkey;
  el('pointerSection').hidden = !pubkey;
  el('indexAddress').value = pubkey ? 'htree://' + indexName(pubkey) : '';
  const needs = [
    !indexHash && 'a saved item',
    !unlocked && 'an unlocked account',
    !mediaServers(conf).some(publicMediaURL) && 'a public Blossom server',
    !conf.relays.length && 'a saved relay',
  ].filter(Boolean);
  el('publishIndex').disabled = !!needs.length || publishing || !!preparingIndex;
  const receipts = pointer?.acknowledged.length
    ? 'Received by ' + pointer.acknowledged.join(', ') + '.'
    : 'Waiting for confirmation.';
  const stateText =
    publishing || preparingIndex
      ? 'Preparing your public backup…'
      : pointer
        ? [
            receipts,
            (pointer.localHash ?? pointer.hash) !== indexHash ? 'There are newer items on this device.' : '',
            pointer.pending.length ? 'Pending on ' + pointer.pending.join(', ') + '.' : '',
          ]
            .filter(Boolean)
            .join(' ')
        : 'Your backup link hasn’t been published yet.';
  el('pointerStatus').textContent =
    stateText +
    (pointer ? ' Storage server: ' + pointer.server + '.' : '') +
    (needs.length ? ' Publishing requires ' + needs.join(', ') + '.' : '');
  for (const [k, n] of Object.entries({ events, drafts, pending }))
    el(k).textContent = String(n);
  el('sync').disabled = running || !pubkey;
  el('rescan').disabled = running || !pubkey;
  el('broadcast').textContent = conf.relaySync
    ? 'Share and check for posts'
    : 'Share backed-up posts';
  el('broadcast').title = conf.relaySync
    ? 'Share your backed-up public posts and check for older posts to save.'
    : 'Share your backed-up public posts with your selected servers.';
  el('broadcast').disabled =
    queuingBroadcast || running || (!events && !conf.relaySync) || !conf.relays.length;
  const latest = Math.max(0, ...relays.map(relay => relay.lastSyncedAt ?? 0));
  el('lastSynced').textContent = latest ? 'Last synced ' + new Date(latest).toLocaleString() : 'Not synced yet';
  el('activity').textContent = running ? 'Syncing…' : !conf.relays.length ? 'Select a relay to sync your posts.' : '';
  showRelayStatus(relays);
}
on('kindMode', 'change', () => {
  el('kindListField').hidden = el('kindMode').value === 'all';
  // A kind list saves once it is entered. Switching back to all kinds saves right away.
  if (el('kindListField').hidden || el('downloadKinds').value.trim()) el('backupSettings').requestSubmit();
  else el('downloadKinds').focus();
});
// Settings save as they change. Text fields save when they are finished, not on every keystroke.
for (const id of ['downloadKinds', 'mediaMiB', 'blossomServer'])
  on(id, 'change', () => el('backupSettings').requestSubmit());
async function saveSettings() {
  await send('settings', {
    pubkey,
    account: pubkey,
    ...sources.values(),
    relays: el('relays').value,
    blossomServer: el('blossomServer').value,
    mediaMiB: el('mediaMiB').value,
    relaySync: el('relaySync').checked,
    relayKinds: { mode: el('kindMode').value, list: el('downloadKinds').value },
  });
  await refresh(true);
  notice('Saved.');
}
on('backupSettings', 'submit', saveSettings);
on('relayChoices', 'change', () => {
  el('relays').value = [
    ...document.querySelectorAll<HTMLInputElement>('#relayChoices input:checked'),
  ]
    .map((input) => input.value)
    .join('\n');
  el('backupSettings').requestSubmit();
});
on('addRelay', 'click', () => {
  const value = el('customRelay').value.trim();
  if (!value) return;
  const url = value.includes('://') ? value : 'wss://' + value;
  el('relays').value = relayList(el('relays').value + '\n' + url).join('\n');
  el('customRelay').value = '';
  el('backupSettings').requestSubmit();
});
on('relaySync', 'change', () => el('backupSettings').requestSubmit());
setupOnboarding(() => refresh(true));
on('copyIndex', 'click', async () => {
  await navigator.clipboard.writeText(el('indexAddress').value);
  notice('Hashtree address copied.');
});
on('publishIndex', 'click', async () => {
  publishing = true;
  el('publishIndex').disabled = true;
  el('pointerStatus').textContent = 'Preparing your public backup…';
  try {
    await send('publishIndex', { account: pubkey });
    notice('Your public backup is ready. Its link is waiting to be shared.');
  } finally {
    publishing = false;
    await refresh();
  }
});
on('broadcast', 'click', async () => {
  queuingBroadcast = true;
  el('broadcast').disabled = true;
  try {
    const count = await send('broadcast', { account: pubkey });
    notice(count ? 'Posts queued for sharing.' : 'Checking saved relays for your posts.');
  } finally {
    queuingBroadcast = false;
    await refresh();
  }
});
for (const id of ['sync', 'rescan'] as const)
  on(id, 'click', async () => {
    notice('');
    el(id).disabled = true;
    try {
      await send(id, { account: pubkey });
    } finally {
      await refresh();
    }
  });
on('download', 'click', async () => {
  if (!archiveName) return;
  const owner = pubkey;
  const db = await openArchive(archiveName);
  try {
    const bytes = await dump(db, owner);
    if (pubkey !== owner) return;
    downloadBlob(
      new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' }),
      'social-backup-' + new Date().toISOString().slice(0, 10) + '.zip',
    );
    notice('ZIP download started.');
  } finally {
    db.close();
  }
});
api.storage?.onChanged?.addListener((changes, area) => {
  if (area !== 'local' || !changes.settingsChanged) return;
  settings().then(next => {
    if (next.pubkey !== pubkey) mediaConfig(next, false);
    return refresh();
  }).catch(e => notice(e.message));
});
selectSection();
refresh(true).catch((e) => notice(e.message));
setInterval(() => {
  if (!document.hidden && (syncing || Date.now() - lastRefresh >= 2500))
    refresh().catch((e) => notice(e.message));
}, 1000);
