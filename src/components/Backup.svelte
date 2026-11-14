<script lang="ts">
  import { DEFAULT_RELAYS } from '../default-relays.ts';
  import { relayList } from '../model.ts';
  import { indexName } from '../index-pointer.ts';
  import { npubEncode } from 'nostr-tools/nip19';
  import { mediaServers, publicMediaURL } from '../media-refs.ts';
  import { dump, openArchive } from '../archive.ts';
  import { downloadBlob, notice, send } from '../ui.ts';
  import { app, page } from './page.svelte.ts';
  import { form } from './settings.svelte.ts';
  import RelayRows from './RelayRows.svelte';

  // Saves the settings form. The page shows errors.
  let { save }: { save: () => Promise<void> } = $props();

  const status = $derived(page.status);
  const conf = $derived(status?.conf);
  const pubkey = $derived(conf?.pubkey ?? '');
  const running = $derived(!!status?.running);

  let publishing = $state(false);
  let queuingBroadcast = $state(false);
  let customRelay: HTMLInputElement;

  const saved = $derived(conf?.relays ?? []);
  const choices = $derived([...new Set([...DEFAULT_RELAYS, ...saved])]);
  const kindSummary = $derived.by(() => {
    const filter = conf?.relayKinds;
    if (!filter) return 'Download all event kinds';
    const selection = (filter.kinds.length === 1 ? 'kind ' : 'kinds ') + filter.kinds.join(', ');
    return (filter.mode === 'include' ? 'Download only ' : 'Download all except ') + selection;
  });

  const lastSynced = $derived.by(() => {
    const latest = Math.max(0, ...(status?.relays ?? []).map((relay) => relay.lastSyncedAt ?? 0));
    return latest ? 'Last synced ' + new Date(latest).toLocaleString() : 'Not synced yet';
  });
  const activity = $derived(running ? 'Syncing…' : conf && !conf.relays.length ? 'Select a relay to sync your posts.' : '');

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

  function toggleRelay(url: string, on: boolean) {
    const current = relayList(form.relays);
    form.relays = (on ? [...current, url] : current.filter((relay) => relay !== url)).join('\n');
    void save().catch(() => {});
  }
  function addRelay() {
    const value = customRelay.value.trim();
    if (!value) return;
    const url = value.includes('://') ? value : 'wss://' + value;
    form.relays = relayList(form.relays + '\n' + url).join('\n');
    customRelay.value = '';
    void save().catch(() => {});
  }
  // A kind list saves once it is entered. Switching back to all kinds saves right away.
  function kindModeChanged(event: Event & { currentTarget: HTMLSelectElement }) {
    // Read the choice from the event: the binding may update after this handler.
    form.kindMode = event.currentTarget.value;
    if (form.kindMode === 'all' || form.kinds.trim()) void save().catch(() => {});
    else (event.currentTarget as HTMLElement).closest('details')?.querySelector<HTMLInputElement>('#downloadKinds')?.focus();
  }

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
  async function relayAction(type: 'sync' | 'rescan') {
    notice('');
    try {
      await send(type, { account: pubkey });
    } finally {
      await app.refresh();
    }
  }
</script>

<h2>Your backup</h2>
<section aria-label="Backup contents">
  <div class="stats">
    <div><strong id="events">{status?.events ?? 0}</strong>Saved items</div>
    <div><strong id="drafts">{status?.drafts ?? 0}</strong>Preparing</div>
    <div><strong id="pending">{status?.pending ?? 0}</strong>Waiting to send</div>
  </div>
  <div class="actions">
    <button id="download" disabled={!pubkey} onclick={run(downloadZip)}>Download ZIP</button>
    {#if pubkey}
      <a class="button secondary" id="viewOnIris" href={'https://iris.to/' + npubEncode(pubkey)} target="_blank" rel="noopener noreferrer"
        >See your posts on Iris</a
      >
    {/if}
  </div>
</section>
<section>
  <h3>Online copies</h3>
  <p class="hint">Relays are servers that store and share public posts. You can use the ones already selected.</p>
  <details id="relaySelector">
    <summary id="relaySummary">Relays ({saved.length})</summary>
    <div id="relayChoices">
      {#each choices as url (url)}
        <label class="check"
          ><input
            type="checkbox"
            value={url}
            checked={relayList(form.relays).includes(url)}
            onchange={(e) => toggleRelay(url, e.currentTarget.checked)}
          />
          {new URL(url).host}</label
        >
      {/each}
    </div>
    <div class="actions">
      <input
        id="customRelay"
        bind:this={customRelay}
        aria-label="Custom relay"
        placeholder="wss://relay.example.com"
        spellcheck="false"
        onkeydown={(e) => e.key === 'Enter' && addRelay()}
      />
      <button type="button" id="addRelay" class="secondary" onclick={addRelay}>Add relay</button>
    </div>
  </details>
  <details id="kindSelector">
    <summary id="kindSummary">{kindSummary}</summary>
    <label
      >Download from relays
      <select id="kindMode" bind:value={form.kindMode} onchange={kindModeChanged}>
        <option value="all">All event kinds</option>
        <option value="include">Only these kinds</option>
        <option value="exclude">All except these kinds</option>
      </select>
    </label>
    <label id="kindListField" hidden={form.kindMode === 'all'}
      >Kind numbers
      <input
        id="downloadKinds"
        bind:value={form.kinds}
        onchange={() => save().catch(() => {})}
        placeholder="e.g. 0, 1, 7"
        spellcheck="false"
        autocomplete="off"
      />
    </label>
  </details>
  <label class="check"
    ><input type="checkbox" id="relaySync" bind:checked={form.relaySync} onchange={() => save().catch(() => {})} />
    Sync daily</label
  >
  <div class="actions">
    <button id="sync" class="secondary" disabled={running || !pubkey} onclick={run(() => relayAction('sync'))}
      >Sync now</button
    >
    <button
      id="broadcast"
      class="secondary"
      title={conf?.relaySync
        ? 'Share your backed-up public posts and check for older posts to save.'
        : 'Share your backed-up public posts with your selected servers.'}
      disabled={queuingBroadcast || running || (!status?.events && !conf?.relaySync) || !conf?.relays.length}
      onclick={run(async () => {
        queuingBroadcast = true;
        try {
          const count = await send('broadcast', { account: pubkey });
          notice(count ? 'Posts queued for sharing.' : 'Checking saved relays for your posts.');
        } finally {
          queuingBroadcast = false;
          await app.refresh();
        }
      })}>{conf?.relaySync ? 'Share and check for posts' : 'Share backed-up posts'}</button
    >
    <button id="rescan" class="quiet" disabled={running || !pubkey} onclick={run(() => relayAction('rescan'))}
      >Check for older posts</button
    >
  </div>
  <p id="lastSynced">{lastSynced}</p>
  <p id="activity" role="status">{activity}</p>
  <RelayRows relays={status?.relays ?? []} />
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
