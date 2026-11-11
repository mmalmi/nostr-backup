import { defaults } from './accounts.ts';
import { generateSecretKey } from 'nostr-tools/pure';
import { nsecEncode, npubEncode } from 'nostr-tools/nip19';
import { indexName } from './index-pointer.ts';
import { showStorage } from './storage-ui.ts';
import { api, el, send, notice, on } from './ui.ts';
import { dump, openArchive } from './archive.ts';
import { downloadBlob, mediaConfig, refreshMedia } from './media-ui.ts';
import { DEFAULT_MEDIA_MIB } from './media-files.ts';

let mediaState: string | undefined,
  archiveName: string | undefined,
  confirmingDelete: string | undefined,
  publishing = false,
  refreshId = 0;
function closeCreate() {
  el('newProfile').hidden = true;
  el('recoveryKey').value = '';
  el('keySaved').checked = false;
  el('profileName').value = '';
  el('startProfile').hidden = false;
}
function cancelDelete() {
  confirmingDelete = undefined;
  el('deleteConfirm').hidden = true;
  el('deleteStart').hidden = false;
}
window.addEventListener('pagehide', closeCreate);
function selectSection() {
  const links = [...document.querySelectorAll<HTMLAnchorElement>('nav a')];
  const current = links.find((link) => link.hash === location.hash) ?? links[0];
  for (const link of links) {
    if (link === current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  for (const panel of document.querySelectorAll<HTMLElement>('[data-panel]'))
    panel.hidden = '#' + panel.dataset.panel !== current.hash;
  if (current.hash !== '#settings') {
    closeCreate();
    cancelDelete();
    el('secret').value = '';
  }
  mediaState = undefined;
}
window.addEventListener('hashchange', () => {
  selectSection();
  refresh().catch((e) => notice(e.message));
});
let pubkey = '',
  queuingBroadcast = false;
async function refresh(initial = false) {
  const request = ++refreshId;
  const {
    conf,
    unlocked,
    events,
    drafts,
    pending,
    running,
    lastRun,
    indexHash,
    pointer,
    preparingIndex,
  } = await send('status');
  if (request !== refreshId) return;
  if (initial && !conf.pubkey && !location.hash) location.hash = 'settings';
  const changed = pubkey !== conf.pubkey;
  if (changed) {
    closeCreate();
    cancelDelete();
    el('secret').value = '';
    el('watchKey').value = '';
    mediaState = undefined;
  }
  archiveName = conf.archiveName;
  pubkey = conf.pubkey;
  mediaConfig(conf, unlocked);
  el('setup').hidden = !!pubkey;
  const state = JSON.stringify([events, unlocked, conf.blossomServer]);
  if (location.hash === '#media' && mediaState !== state) {
    await refreshMedia();
    if (request !== refreshId) return;
    mediaState = state;
  }
  showStorage(conf, location.hash === '#storage');
  if (initial || changed) {
    el('handle').value = conf.handle;
    el('blossomServer').value = conf.blossomServer ?? '';
    el('mediaMiB').value = String(conf.mediaMiB ?? DEFAULT_MEDIA_MIB);
    el('relays').value = conf.relays.join('\n');
    for (const k of ['capture', 'relaySync'] as const) el(k).checked = conf[k];
  }
  el('backupSettings').hidden = !pubkey;
  el('onboarding').hidden = !!pubkey;
  el('manageArchive').hidden = !pubkey;
  el('logout').hidden = !pubkey;
  el('currentIdentity').hidden = !pubkey;
  const npub = pubkey ? npubEncode(pubkey) : '';
  el('accountNpub').value = npub;
  el('download').disabled = !pubkey;
  el('pointerSection').hidden = !pubkey;
  el('indexAddress').value = pubkey ? 'htree://' + indexName(pubkey) : '';
  const needs = [
    !indexHash && 'an indexed event',
    !unlocked && 'an unlocked signer',
    !conf.blossomServer && 'a Blossom server',
    !conf.relays.length && 'a saved relay',
  ].filter(Boolean);
  el('publishIndex').disabled = !!needs.length || publishing || !!preparingIndex;
  const receipts = pointer?.acknowledged.length
    ? 'Acknowledged by ' + pointer.acknowledged.join(', ') + '.'
    : 'No relay acknowledgement yet.';
  const stateText =
    publishing || preparingIndex
      ? 'Uploading index blocks…'
      : pointer
        ? [
            receipts,
            pointer.hash !== indexHash ? 'The local index has newer events.' : '',
            pointer.pending.length ? 'Pending on ' + pointer.pending.join(', ') + '.' : '',
          ]
            .filter(Boolean)
            .join(' ')
        : 'This index has not been published from this archive.';
  el('pointerStatus').textContent =
    stateText +
    (pointer ? ' Block server: ' + pointer.server + '.' : '') +
    (needs.length ? ' Publishing requires ' + needs.join(', ') + '.' : '');
  for (const [k, n] of Object.entries({ events, drafts, pending })) el(k).textContent = String(n);
  el('lockState').textContent = unlocked
    ? 'Signer unlocked for this session.'
    : pubkey
      ? 'Signer locked.'
      : 'Choose how to open your archive.';
  el('unlock').hidden = unlocked;
  el('lock').hidden = !unlocked;
  el('sync').disabled = running || !pubkey;
  el('rescan').disabled = running || !pubkey;
  el('broadcast').textContent = conf.relaySync
    ? 'Broadcast and import'
    : 'Broadcast to saved relays';
  el('broadcast').title = conf.relaySync
    ? 'Publish archived posts to every saved relay and fetch your missing posts.'
    : 'Publish archived posts to every saved relay.';
  el('broadcast').disabled =
    queuingBroadcast || running || (!events && !conf.relaySync) || !conf.relays.length;
  el('activity').textContent = running
    ? 'Sync in progress…'
    : lastRun
      ? 'Last run ' + new Date(lastRun.at).toLocaleString()
      : '';
  el('reports').replaceChildren(
    ...Object.entries(lastRun?.reports ?? {}).map(([url, v]) => {
      const li = document.createElement('li');
      li.textContent = url + ' — ' + v;
      return li;
    }),
  );
}
on('backupSettings', 'submit', async () => {
  await send('settings', {
    pubkey,
    account: pubkey,
    handle: el('handle').value,
    relays: el('relays').value,
    capture: el('capture').checked,
    blossomServer: el('blossomServer').value,
    mediaMiB: el('mediaMiB').value,
    relaySync: el('relaySync').checked,
  });
  await refresh(true);
  notice('Settings saved.');
});
on('unlock', 'submit', async () => {
  const key = el('secret').value;
  el('secret').value = '';
  await send('login', { key, account: pubkey });
  await refresh(true);
  notice('Logged in.');
});
on('lock', 'click', async () => {
  await send('lock', { account: pubkey });
  await refresh();
  notice('Signer locked.');
});
on('startProfile', 'click', () => {
  el('recoveryKey').value = nsecEncode(generateSecretKey());
  el('newProfile').hidden = false;
  el('startProfile').hidden = true;
  el('profileName').focus();
});
on('cancelProfile', 'click', closeCreate);
on('newProfile', 'submit', async () => {
  if (!el('keySaved').checked) throw Error('Save your private key before creating the profile.');
  await send('createProfile', {
    key: el('recoveryKey').value,
    name: el('profileName').value,
    account: pubkey,
  });
  closeCreate();
  await refresh(true);
  notice('Profile created locally. Use Broadcast in Archive to publish it to your saved relays.');
});
on('watch', 'submit', async () => {
  await send('watch', { pubkey: el('watchKey').value, account: pubkey });
  await refresh(true);
  notice('Read-only archive opened.');
});
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
on('copyIndex', 'click', async () => {
  await navigator.clipboard.writeText(el('indexAddress').value);
  notice('Hashtree address copied.');
});
on('publishIndex', 'click', async () => {
  publishing = true;
  el('publishIndex').disabled = true;
  el('pointerStatus').textContent = 'Uploading index blocks…';
  try {
    await send('publishIndex', { account: pubkey });
    notice('Index blocks uploaded. The pointer is queued for relay delivery.');
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
    notice(
      count
        ? `Queued ${count} signed ${count === 1 ? 'post' : 'posts'} for broadcast to your saved relays.`
        : 'Checking saved relays for your posts.',
    );
  } finally {
    queuingBroadcast = false;
    await refresh();
  }
});
for (const id of ['sync', 'rescan'] as const)
  on(id, 'click', async () => {
    await send(id, { account: pubkey });
    await refresh();
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
      'nostr-backup-' + new Date().toISOString().slice(0, 10) + '.zip',
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
  if (!document.hidden) refresh().catch((e) => notice(e.message));
}, 2500);
