<script lang="ts">
  import { DEFAULT_RELAYS } from '../default-relays.ts';
  import { relayList } from '../model.ts';
  import { relayHost } from '../relay-summary.ts';
  import { notice, send } from '../ui.ts';
  import { app, page } from './page.svelte.ts';
  import { form } from './settings.svelte.ts';
  import RelayRows from './RelayRows.svelte';

  // Saves the settings form. The page shows errors.
  let { save }: { save: () => Promise<void> } = $props();

  const status = $derived(page.status);
  const conf = $derived(status?.conf);
  const pubkey = $derived(conf?.pubkey ?? '');
  const running = $derived(!!status?.running);

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
  async function rescan() {
    notice('');
    try {
      await send('rescan', { account: pubkey });
    } finally {
      await app.refresh();
    }
  }
  async function resend() {
    queuingBroadcast = true;
    try {
      const count = await send('broadcast', { account: pubkey });
      notice(count ? 'Posts queued for sending.' : 'Checking saved relays for your posts.');
    } finally {
      queuingBroadcast = false;
      await app.refresh();
    }
  }
</script>

<section id="relaySection" aria-labelledby="relayHeading">
  <h3 id="relayHeading">Online copies</h3>
  <p class="hint">
    Relays are servers that keep and share your public posts. Private and unverified posts stay on this device.
  </p>
  <RelayRows relays={status?.relays ?? []} />
  {#if conf && !saved.length}<p>No relays selected. Choose at least one to keep copies online.</p>{/if}
  <div class="actions">
    <button
      id="broadcast"
      class="secondary"
      title={conf?.relaySync
        ? 'Send your backed-up public posts to every relay again, and check for older posts to save.'
        : 'Send your backed-up public posts to every relay again.'}
      disabled={queuingBroadcast || running || (!status?.events && !conf?.relaySync) || !saved.length}
      onclick={run(resend)}>Resend posts</button
    >
    <button id="rescan" class="quiet" disabled={running || !pubkey || !saved.length} onclick={run(rescan)}
      >Check for older posts</button
    >
  </div>
  <details id="relaySelector" open={!saved.length}>
    <summary id="relaySummary">Choose relays ({saved.length} selected)</summary>
    <div id="relayChoices">
      {#each choices as url (url)}
        <label class="check"
          ><input
            type="checkbox"
            value={url}
            checked={relayList(form.relays).includes(url)}
            onchange={(e) => toggleRelay(url, e.currentTarget.checked)}
          />
          {relayHost(url)}</label
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
    Download your posts from relays daily</label
  >
</section>
