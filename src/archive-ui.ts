import { socialNetworks } from './social.ts';
import { mediaServers, publicMediaURL } from './media-refs.ts';
import { defaults } from './accounts.ts';
import { resetOnboarding, setupOnboarding } from './onboarding.ts';
import { npubEncode } from 'nostr-tools/nip19';
import { showProfile } from './profile-ui.ts';
import { showRelayStatus } from './relay-status-ui.ts';
import { DEFAULT_RELAYS } from './default-relays.ts';
import { relayList, secretKey } from './model.ts';
import { indexName } from './index-pointer.ts';
import { showStorage } from './storage-ui.ts';
import { api, el, send, notice, on } from './ui.ts';
import { dump, openArchive } from './archive.ts';
import { downloadBlob, mediaConfig, refreshMedia } from './media-ui.ts';
import { DEFAULT_MEDIA_MIB } from './media-files.ts';

let permissionState = '';
let archiveName: string | undefined,
  confirmingDelete: string | undefined,
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
function cancelDelete() {
  confirmingDelete = undefined;
  el('deleteConfirm').hidden = true;
  el('deleteStart').hidden = false;
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
  if (current.hash !== '#account') {
    cancelDelete();
    el('secret').value = '';
  }
}
window.addEventListener('hashchange', () => {
  selectSection();
  refresh().catch((e) => notice(e.message));
});
let pubkey = '',
  queuingBroadcast = false,
  unlocking = false,
  syncing = false,
  lastRefresh = 0;
async function refresh(initial = false) {
  const request = ++refreshId;
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
  } = await send('status');
  if (request !== refreshId) return;
  syncing = running;
  lastRefresh = Date.now();
  const changed = pubkey !== conf.pubkey;
  if (changed) {
    resetOnboarding();
    cancelDelete();
    el('secret').value = '';
    }
  archiveName = conf.archiveName;
  pubkey = conf.pubkey;
  showProfile(pubkey, profile, !unlocked);
  el('sourcesReadOnly').hidden = unlocked;
  for (const site of socialNetworks) {
    el(`${site}Capture`).disabled = !unlocked;
    const counts = social?.[site];
    el(`${site}Count`).textContent = counts?.saved
      ? counts.saved.toLocaleString() + ' backed up · ' + counts.signed.toLocaleString() + ' prepared for sharing'
      : 'No posts backed up yet';
    if (initial || changed) {
      el(`${site}Handle`).value = conf.social?.[site]?.handle ?? '';
      el(`${site}Capture`).checked = conf.social?.[site]?.capture ?? false;
    }
  }
  el('localXCount').hidden = !localX;
  el('localXCount').textContent = (localX ?? 0).toLocaleString() + ' local only';
  el('capture').disabled = !unlocked;
  el('skipCrossposts').disabled = !unlocked;
  el('xCaptured').textContent = x.captured.toLocaleString();
  el('xMatched').textContent = x.matched.toLocaleString();
  el('xSigned').textContent = x.signed.toLocaleString();
  el('xImageState').hidden = !x.media;
  el('xImageState').textContent = x.media
    ? x.media.toLocaleString() + (x.media === 1 ? ' post waiting for images' : ' posts waiting for images') +
      (x.mediaError ? ' · ' + x.mediaError : '') : '';
  el('xDrafts').textContent = x.drafts.toLocaleString();
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
    el('handle').value = conf.handle;
    el('skipCrossposts').checked = conf.skipCrossposts !== false;
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
    for (const k of ['capture', 'relaySync'] as const) el(k).checked = conf[k];
  }
  el('backupSettings').hidden = !pubkey;
  el('manageArchive').hidden = !pubkey;
  el('logout').hidden = !pubkey;
  el('currentIdentity').hidden = !pubkey;
  const npub = pubkey ? npubEncode(pubkey) : '';
  el('accountNpub').value = npub;
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
  el('lockState').hidden = unlocked;
  if (pubkey && location.hash === '#account') {
    const owner = pubkey;
    const rules = await send('listPermissions', { account: owner });
    if (request !== refreshId) return;
    const state = JSON.stringify([owner, rules]);
    if (state !== permissionState) {
      permissionState = state;
      const origins = [...new Set(rules.map(rule => rule.origin))];
      el('permissionList').replaceChildren(...origins.map(origin => {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.textContent = 'Revoke';
        button.className = 'secondary';
        button.onclick = () => send('forgetPermissions', { account: owner, origin })
          .then(() => refresh()).catch(error => notice(error.message));
        li.append(origin + ' · ' + rules.filter(rule => rule.origin === origin)
          .map(rule => rule.kind === -1 ? 'login' : rule.kind === 1 ? 'posts' : 'reactions').join(', ') + ' ', button);
        return li;
      }));
      el('sitePermissions').hidden = !rules.length;
    }
  }
  el('unlock').hidden = unlocked;
  el('lock').hidden = !unlocked;
  el('copyPrivateKey').hidden = !unlocked;
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
  if (!el('kindListField').hidden) el('downloadKinds').focus();
});
on('backupSettings', 'submit', async () => {
  await send('settings', {
    pubkey,
    account: pubkey,
    handle: el('handle').value,
    social: Object.fromEntries(socialNetworks.map(site => [site, {
      handle: el(`${site}Handle`).value, capture: el(`${site}Capture`).checked,
    }])),
    relays: el('relays').value,
    capture: el('capture').checked,
    skipCrossposts: el('skipCrossposts').checked,
    blossomServer: el('blossomServer').value,
    mediaMiB: el('mediaMiB').value,
    relaySync: el('relaySync').checked,
    relayKinds: { mode: el('kindMode').value, list: el('downloadKinds').value },
  });
  await refresh(true);
  notice('Saved.');
});
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
async function unlockSigner() {
  if (unlocking) return;
  const key = el('secret').value;
  secretKey(key);
  unlocking = true;
  el('secret').disabled = true;
  el('secret').value = '';
  try {
    await send('login', { key, account: pubkey });
    await refresh(true);
    notice('');
  } finally {
    unlocking = false;
    el('secret').disabled = false;
  }
}
on('unlock', 'submit', unlockSigner);
on('secret', 'input', () => {
  try {
    secretKey(el('secret').value);
  } catch {
    return;
  }
  return unlockSigner();
});
on('lock', 'click', async () => {
  await send('lock', { account: pubkey });
  await refresh();
  notice('Account locked.');
});
setupOnboarding(() => refresh(true));
on('logout', 'click', async () => {
  await send('logout', { pubkey });
  await refresh(true);
  notice('Logged out. Your archive is saved on this device.');
});
on('deleteStart', 'click', () => {
  confirmingDelete = pubkey;
  el('deleteStart').hidden = true;
  el('deleteConfirm').hidden = false;
  el('cancelDelete').focus();
});
on('cancelDelete', 'click', cancelDelete);
on('deleteAccount', 'click', async () => {
  if (!confirmingDelete || confirmingDelete !== pubkey)
    throw Error('Confirm which archive to delete.');
  await send('deleteAccount', { pubkey: confirmingDelete, confirmed: true });
  cancelDelete();
  await refresh(true);
  notice('Local archive deleted.');
});
on('copyPrivateKey', 'click', async () => {
  const key = await send('exportPrivateKey', { account: pubkey });
  await navigator.clipboard.writeText(key);
  notice('Secret key copied.');
});
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
  if (area !== 'local' || !changes.settings) return;
  const next = changes.settings.newValue;
  if ((next?.pubkey ?? '') !== pubkey) mediaConfig(next ?? defaults, false);
  refresh().catch((e) => notice(e.message));
});
selectSection();
refresh(true).catch((e) => notice(e.message));
setInterval(() => {
  if (!document.hidden && (syncing || Date.now() - lastRefresh >= 2500))
    refresh().catch((e) => notice(e.message));
}, 1000);
