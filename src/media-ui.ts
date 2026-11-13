import type { Settings, MediaFile, MediaReference, Archive, BlossomDelivery } from './types.ts';
import { errorMessage } from './types.ts';
import { readCooldown } from './archive.ts';
import { SimplePool } from 'nostr-tools/pool';
import { verifyEvent } from 'nostr-tools/pure';
import { getServersFromServerListEvent, getExtension } from 'nostr-tools/nipb7';
import { openArchive } from './archive.ts';
import {
  accountFetch,
  backupMedia,
  openMediaBlocks,
  readMediaFile,
} from './media-files.ts';
import { httpsURL, mediaServers } from './media-refs.ts';
import { shareableMediaHashes } from './legacy-x.ts';
import { api, el, send, on, notice } from './ui.ts';

let conf: Settings,
  unlocked: boolean,
  busy = false,
  visibleRows = 30;
let snapshot: { files: MediaFile[]; refs: MediaReference[]; shareable: Set<string>; deliveries: BlossomDelivery[] } | undefined,
  controller: AbortController | undefined;
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function render() {
  if (!snapshot || !conf) return;
  const { refs, files, shareable } = snapshot;
  const pending = refs.filter((r) => !r.sha256).length;
  const servers = mediaServers(conf);
  el('savedFiles').textContent = String(files.length);
  el('posterRefs').textContent = String(refs.filter(r => r.poster).length);
  el('missingRefs').textContent = String(refs.filter(r => r.status === 'unavailable').length);
  el('backupMedia').disabled = busy || !pending;
  el('uploadMedia').disabled = busy || !shareable.size || !unlocked;
  el('uploadHint').textContent = 'Check saved public files and restore missing copies.';
  el('blossomStatus').replaceChildren(...servers.map(server => {
    const queued = snapshot!.deliveries.filter(row => row.server === server);
    const retry = queued.filter(row => row.retryAt).sort((a,b) => a.retryAt! - b.retryAt!)[0];
    const stored = files.filter(file => shareable.has(file.sha256) && file.copies.includes(server)).length;
    const row = document.createElement('li');
    row.textContent = new URL(server).host + ' · ' + stored + ' saved · ' + queued.length + ' queued'
      + (retry ? ' · Retry ' + new Date(retry.retryAt!).toLocaleString() + ' · ' + retry.error : '');
    return row;
  }));
  el('mediaSummary').textContent = refs.length
    ? `${refs.length} attachments found · ${pending} awaiting backup`
    : 'No media found in your archived posts.';
  el('mediaList').replaceChildren(
    ...refs.slice(0, visibleRows).map((ref) => {
      const li = document.createElement('li');
      const source = document.createElement('small');
      source.textContent = ref.url;
      li.append((ref.status === 'poster only' ? 'Video preview only' : ref.status) + (ref.error ? ' · ' + ref.error : ''), source);
      if (ref.sha256) {
        const button = document.createElement('button');
        button.className = 'secondary';
        button.textContent = 'Download file';
        button.onclick = () => downloadLocal(ref.sha256!).catch((e) => notice(e.message));
        li.append(button);
      } else if (
        ref.status === 'unavailable' &&
        httpsURL(ref.url) &&
        api.permissions &&
        /fetch|network|load failed/i.test(ref.error ?? '')
      ) {
        const origin = httpsURL(ref.url)!.origin;
        const button = document.createElement('button');
        button.className = 'secondary';
        button.textContent = 'Allow access to ' + new URL(origin).host;
        button.onclick = async () => {
          try {
            const granted = await api.permissions.request({ origins: [origin + '/*'] });
            if (granted) await runMedia();
          } catch (e) {
            notice(errorMessage(e));
          }
        };
        li.append(button);
      }
      return li;
    }),
  );
  el('moreMedia').hidden = visibleRows >= refs.length;
}

async function downloadLocal(hash: string) {
  const db = await openArchive(conf.archiveName);
  const store = openMediaBlocks(db);
  try {
    const file = await db.get('mediaFiles', hash);
    if (!file) throw Error('Local media file is missing.');
    const bytes = await readMediaFile(store, file);
    downloadBlob(
      new Blob([bytes as Uint8Array<ArrayBuffer>], { type: file.mime }),
      file.sha256 + (getExtension(file.mime) || '.bin'),
    );
  } finally {
    store.close();
    db.close();
  }
}

export function mediaConfig(settings: Settings, isUnlocked: boolean) {
  if (conf?.pubkey !== settings.pubkey) {
    controller?.abort();
    snapshot = { files: [], refs: [], shareable: new Set(), deliveries: [] };
    visibleRows = 30;
  }
  conf = settings;
  unlocked = isUnlocked;
}

export async function refreshMedia() {
  if (!conf?.pubkey) {
    render();
    return;
  }
  const account = conf.pubkey;
  const db = await openArchive(conf.archiveName);
  try {
    const tx = db.transaction(['mediaFiles', 'mediaRefs', 'blossomOutbox']);
    const [files, refs, deliveries] = await Promise.all([
      tx.objectStore('mediaFiles').getAll(),
      tx.objectStore('mediaRefs').getAll(),
      tx.objectStore('blossomOutbox').getAll(),
    ]);
    const shareable = await shareableMediaHashes(db, refs);
    if (conf.pubkey !== account) return;
    snapshot = {files, refs, shareable, deliveries};
    render();
  } finally {
    db.close();
  }
}

// Look up the author's advertised mirrors once, only after a hash-addressed read misses.
async function discoverServers(db: Archive, relays: string[], pubkey: string) {
  const available = [];
  for (const url of relays) {
    if (!(((await readCooldown(db, url)) ?? 0) > Date.now())) available.push(url);
  }
  if (!available.length) return [];
  const pool = new SimplePool();
  try {
    const events = await pool.querySync(
      available,
      { kinds: [10063], authors: [pubkey], limit: 1 },
      { maxWait: 4000 },
    );
    const latest = events
      .filter((e) => e.kind === 10063 && e.pubkey === pubkey && verifyEvent(e))
      .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
    return latest
      ? getServersFromServerListEvent(latest)
          .filter((u) => httpsURL(u.href))
          .map((u) => u.origin)
      : [];
  } finally {
    pool.destroy();
  }
}

async function runMedia() {
  if (busy || !conf) return;
  const { relays, pubkey, blossomServer: server, mediaMiB } = conf;
  const archiveName = conf.archiveName;
  controller = new AbortController();
  const signal = controller.signal;
  const fetcher = accountFetch(signal);
  busy = true;
  render();
  try {
    await navigator.locks.request('nostr-backup-media', { ifAvailable: true }, async (lock) => {
      if (!lock) throw Error('Media backup is running in another tab.');
      const { settings } = await api.storage.local.get('settings');
      if (!pubkey || settings?.pubkey !== pubkey) throw Error('The active profile changed.');
      const db = await openArchive(archiveName);
      let servers: Promise<string[]> | undefined;
      const progress = (done: number, total: number) => {
        signal.throwIfAborted();
        el('mediaProgress').textContent = 'Backing up ' + (done + 1) + ' of ' + total + '…';
      };
      try {
        const result = await backupMedia(db, {
          server,
          servers: mediaServers(conf),
          fetcher,
          signal,
          maxMiB: mediaMiB,
          resolveServers: () => (servers ??= discoverServers(db, relays, pubkey)),
          progress,
        });
        notice(`Media backup finished. ${result.saved} saved, ${result.unavailable} unavailable.`);
      } finally {
        db.close();
      }
    });
  } finally {
    busy = false;
    el('mediaProgress').textContent = '';
    await refreshMedia();
  }
}
on('backupMedia', 'click', () => runMedia());
on('uploadMedia', 'click', async () => {
  const count = await send('syncBlossom', { account: conf.pubkey });
  notice(count ? 'Media sync queued.' : 'No saved public media to sync.');
  await refreshMedia();
});
on('moreMedia', 'click', () => {
  visibleRows += 30;
  render();
});
