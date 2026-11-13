<script lang="ts">
  import { SimplePool } from 'nostr-tools/pool';
  import { verifyEvent } from 'nostr-tools/pure';
  import { getExtension, getServersFromServerListEvent } from 'nostr-tools/nipb7';
  import type { Archive, BlossomDelivery, MediaFile, MediaReference } from '../types.ts';
  import { errorMessage } from '../types.ts';
  import { openArchive, readCooldown } from '../archive.ts';
  import { accountFetch, backupMedia, openMediaBlocks, readMediaFile } from '../media-files.ts';
  import { httpsURL, mediaServers } from '../media-refs.ts';
  import { shareableMediaHashes } from '../legacy-x.ts';
  import { accountRecord } from '../account-storage.ts';
  import { api, downloadBlob, notice, send } from '../ui.ts';
  import { page } from './page.svelte.ts';

  interface Snapshot {
    files: MediaFile[];
    refs: MediaReference[];
    shareable: Set<string>;
    deliveries: BlossomDelivery[];
  }
  const empty = (): Snapshot => ({ files: [], refs: [], shareable: new Set(), deliveries: [] });

  let snapshot = $state<Snapshot>(empty());
  let busy = $state(false);
  let progress = $state('');
  let visibleRows = $state(30);
  let controller: AbortController | undefined;

  const conf = $derived(page.status?.conf);
  const unlocked = $derived(!!page.status?.unlocked);
  const open = $derived(page.section === 'media');

  // A different profile cancels a running backup and starts from an empty list.
  let owner = '';
  $effect(() => {
    const pubkey = conf?.pubkey ?? '';
    if (pubkey === owner) return;
    owner = pubkey;
    controller?.abort();
    snapshot = empty();
    visibleRows = 30;
  });
  // Re-read media with each status refresh while the panel is open.
  $effect(() => {
    if (!open || !page.status) return;
    load().catch((e) => notice(e.message));
  });

  async function load() {
    const current = conf;
    if (!current?.pubkey) return;
    const db = await openArchive(current.archiveName);
    try {
      const tx = db.transaction(['mediaFiles', 'mediaRefs', 'blossomOutbox']);
      const [files, refs, deliveries] = await Promise.all([
        tx.objectStore('mediaFiles').getAll(),
        tx.objectStore('mediaRefs').getAll(),
        tx.objectStore('blossomOutbox').getAll(),
      ]);
      const shareable = await shareableMediaHashes(db, refs);
      if (conf?.pubkey === current.pubkey) snapshot = { files, refs, shareable, deliveries };
    } finally {
      db.close();
    }
  }

  const pending = $derived(snapshot.refs.filter((r) => !r.sha256).length);
  const servers = $derived(conf ? mediaServers(conf) : []);
  const serverRows = $derived(
    servers.map((server) => {
      const queued = snapshot.deliveries.filter((row) => row.server === server);
      const retry = queued.filter((row) => row.retryAt).sort((a, b) => a.retryAt! - b.retryAt!)[0];
      const stored = snapshot.files.filter(
        (file) => snapshot.shareable.has(file.sha256) && file.copies.includes(server),
      ).length;
      return (
        new URL(server).host +
        ' · ' +
        stored +
        ' saved · ' +
        queued.length +
        ' queued' +
        (retry ? ' · Retry ' + new Date(retry.retryAt!).toLocaleString() + ' · ' + retry.error : '')
      );
    }),
  );
  // A blocked download can be retried once the user lets the extension reach that site.
  const accessOrigin = (ref: MediaReference) =>
    ref.status === 'unavailable' && api.permissions && /fetch|network|load failed/i.test(ref.error ?? '')
      ? httpsURL(ref.url)?.origin
      : undefined;

  async function downloadLocal(hash: string) {
    const db = await openArchive(conf!.archiveName);
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

  // Look up the author's advertised mirrors once, only after a hash-addressed read misses.
  async function discoverServers(db: Archive, relays: string[], pubkey: string) {
    const available = [];
    for (const url of relays) if (!(((await readCooldown(db, url)) ?? 0) > Date.now())) available.push(url);
    if (!available.length) return [];
    const pool = new SimplePool();
    try {
      const events = await pool.querySync(available, { kinds: [10063], authors: [pubkey], limit: 1 }, { maxWait: 4000 });
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
    const settings = conf;
    const { relays, pubkey, blossomServer: server, mediaMiB, archiveName } = settings;
    controller = new AbortController();
    const signal = controller.signal;
    busy = true;
    try {
      await navigator.locks.request('nostr-backup-media', { ifAvailable: true }, async (lock) => {
        if (!lock) throw Error('Media backup is running in another tab.');
        const stored = await accountRecord('settings');
        if (!pubkey || stored?.pubkey !== pubkey) throw Error('The active profile changed.');
        const db = await openArchive(archiveName);
        let found: Promise<string[]> | undefined;
        try {
          const result = await backupMedia(db, {
            server,
            servers: mediaServers(settings),
            fetcher: accountFetch(signal),
            signal,
            maxMiB: mediaMiB,
            resolveServers: () => (found ??= discoverServers(db, relays, pubkey)),
            progress: (done, total) => {
              signal.throwIfAborted();
              progress = 'Backing up ' + (done + 1) + ' of ' + total + '…';
            },
          });
          notice(`Media backup finished. ${result.saved} saved, ${result.unavailable} unavailable.`);
        } finally {
          db.close();
        }
      });
    } finally {
      busy = false;
      progress = '';
      await load();
    }
  }
  const run = (action: () => Promise<unknown>) => () => {
    action().catch((e) => notice(errorMessage(e)));
  };
</script>

<section>
  <h3>Local backup</h3>
  <p>Save files linked from your archived posts. Keep this page open while the backup runs.</p>
  <div class="stats">
    <div><strong id="savedFiles">{snapshot.files.length}</strong>Local files</div>
    <div><strong id="posterRefs">{snapshot.refs.filter((r) => r.poster).length}</strong>Video previews</div>
    <div><strong id="missingRefs">{snapshot.refs.filter((r) => r.status === 'unavailable').length}</strong>Unavailable</div>
  </div>
  <button id="backupMedia" disabled={busy || !pending} onclick={run(runMedia)}>Back up media</button>
  <p id="mediaProgress" role="status">{progress}</p>
</section>
<section>
  <h3>Copies on other servers</h3>
  <p id="uploadHint">Check saved public files and restore missing copies.</p>
  <ul id="blossomStatus" aria-label="Blossom server status">
    {#each serverRows as row, i (i)}<li>{row}</li>{/each}
  </ul>
  <button
    id="uploadMedia"
    class="secondary"
    disabled={busy || !snapshot.shareable.size || !unlocked}
    onclick={run(async () => {
      const count = await send('syncBlossom', { account: conf!.pubkey });
      notice(count ? 'Media sync queued.' : 'No saved public media to sync.');
      await load();
    })}>Sync media</button
  >
</section>
<section>
  <h3>Attachments</h3>
  <p id="mediaSummary">
    {snapshot.refs.length
      ? `${snapshot.refs.length} attachments found · ${pending} awaiting backup`
      : 'No media found in your archived posts.'}
  </p>
  <ul id="mediaList">
    {#each snapshot.refs.slice(0, visibleRows) as ref, i (i)}
      {@const origin = !ref.sha256 ? accessOrigin(ref) : undefined}
      <li>
        {(ref.status === 'poster only' ? 'Video preview only' : ref.status) + (ref.error ? ' · ' + ref.error : '')}<small
          >{ref.url}</small
        >
        {#if ref.sha256}
          <button class="secondary" onclick={run(() => downloadLocal(ref.sha256!))}>Download file</button>
        {:else if origin}
          <button
            class="secondary"
            onclick={run(async () => {
              if (await api.permissions!.request({ origins: [origin + '/*'] })) await runMedia();
            })}>Allow access to {new URL(origin).host}</button
          >
        {/if}
      </li>
    {/each}
  </ul>
  <button class="quiet" id="moreMedia" hidden={visibleRows >= snapshot.refs.length} onclick={() => (visibleRows += 30)}
    >Show more</button
  >
</section>
