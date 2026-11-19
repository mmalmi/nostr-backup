<script lang="ts">
  import { indexName } from '../index-pointer.ts';
  import { npubEncode } from 'nostr-tools/nip19';
  import { mediaServers, publicMediaURL } from '../media-refs.ts';
  import { dump, openArchive } from '../archive.ts';
  import { onlineSummary, syncedAt } from '../relay-summary.ts';
  import { downloadBlob, notice, send } from '../ui.ts';
  import { app, page } from './page.svelte.ts';

  const status = $derived(page.status);
  const conf = $derived(status?.conf);
  const pubkey = $derived(conf?.pubkey ?? '');
  const running = $derived(!!status?.running);
  const events = $derived(status?.events ?? 0);
  const drafts = $derived(status?.drafts ?? 0);

  let publishing = $state(false);

  const online = $derived(onlineSummary(status?.relays ?? [], status?.pending ?? 0, running));
  const lastSynced = $derived.by(() => {
    const latest = Math.max(0, ...(status?.relays ?? []).map((relay) => relay.lastSyncedAt ?? 0));
    return latest ? 'Last synced ' + syncedAt(latest) : 'Not synced yet';
  });

  // What publishing the public backup link still needs.
  const needs = $derived(
    [
      !status?.indexHash && 'a saved item',
      !status?.unlocked && 'an unlocked account',
      conf && !mediaServers(conf).some(publicMediaURL) && 'a public media backup server',
      !conf?.relays.length && 'a saved relay',
    ].filter(Boolean),
  );
  const pointerStatus = $derived.by(() => {
    const pointer = status?.pointer;
    const state =
      publishing || status?.preparingIndex
        ? 'Preparing your public backup…'
        : pointer
          ? [
              pointer.acknowledged.length
                ? 'Received by ' + pointer.acknowledged.join(', ') + '.'
                : 'Waiting for confirmation.',
              (pointer.localHash ?? pointer.hash) !== status?.indexHash ? 'There are newer items on this device.' : '',
              pointer.pending.length ? 'Pending on ' + pointer.pending.join(', ') + '.' : '',
            ]
              .filter(Boolean)
              .join(' ')
          : 'Your backup link hasn’t been published yet.';
    return (
      state +
      (pointer ? ' Storage server: ' + pointer.server + '.' : '') +
      (needs.length ? ' Publishing requires ' + needs.join(', ') + '.' : '')
    );
  });
  const address = $derived(pubkey ? 'htree://' + indexName(pubkey) : '');

  const run = (action: () => Promise<unknown>) => () => {
    action().catch((e) => notice((e as Error).message));
  };
  async function downloadZip() {
    if (!conf) return;
    const owner = conf.pubkey;
    const db = await openArchive(conf.archiveName);
    try {
      const bytes = await dump(db, owner);
      if (page.status?.conf.pubkey !== owner) return;
      downloadBlob(
        new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' }),
        'social-backup-' + new Date().toISOString().slice(0, 10) + '.zip',
      );
      notice('ZIP download started.');
    } finally {
      db.close();
    }
  }
  async function sync() {
    notice('');
    try {
      await send('sync', { account: pubkey });
    } finally {
      await app.refresh();
    }
  }
</script>

<h2>Your backup</h2>
<section class="backupSummary" aria-label="Backup contents">
  <p class="backupCount">
    <strong id="events">{events.toLocaleString()}</strong>
    {events === 1 ? 'item' : 'items'} saved on this device
  </p>
  {#if drafts}<p id="drafts">{drafts.toLocaleString()} public {drafts === 1 ? 'post is' : 'posts are'} being prepared.</p>{/if}
  <div class="onlineState {online.tone}" role="status">
    <p id="onlineState">{online.text}</p>
    {#if online.problem}<p id="relayProblem">{online.problem}</p>{/if}
    <p class="hint">
      <span id="lastSynced">{lastSynced}</span>{' · '}<a href="#storage">{conf?.relays.length ? 'Relay details' : 'Choose relays'}</a>
    </p>
  </div>
  <div class="actions">
    <button id="download" disabled={!pubkey} onclick={run(downloadZip)}>Download ZIP</button>
    <button id="sync" class="secondary" disabled={running || !pubkey || !conf?.relays.length} onclick={run(sync)}
      >{running ? 'Syncing…' : 'Sync now'}</button
    >
    {#if pubkey}
      <a class="button secondary" id="viewOnIris" href={'https://iris.to/' + npubEncode(pubkey)} target="_blank" rel="noopener noreferrer"
        >See your posts on Iris</a
      >
    {/if}
  </div>
</section>
<section id="pointerSection" hidden={!pubkey}>
  <details
    ><summary>Share a link to your public backup</summary>
    <label>Backup address<input id="indexAddress" readonly spellcheck="false" value={address} /></label>
    <p id="pointerStatus">{pointerStatus}</p>
    <div class="actions">
      <button
        id="publishIndex"
        disabled={!!needs.length || publishing || !!status?.preparingIndex}
        onclick={run(async () => {
          publishing = true;
          try {
            await send('publishIndex', { account: pubkey });
            notice('Your public backup is ready. Its link is waiting to be shared.');
          } finally {
            publishing = false;
            await app.refresh();
          }
        })}>Publish link</button
      ><button
        id="copyIndex"
        class="secondary"
        onclick={run(async () => {
          await navigator.clipboard.writeText(address);
          notice('Hashtree address copied.');
        })}>Copy link</button
      >
    </div>
    <p class="hint">Anyone with the link can read the public items in this backup.</p>
  </details>
</section>
