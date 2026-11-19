<script lang="ts">
  import { openArchive } from '../archive.ts';
  import { storageStats, type KindStats } from '../storage-stats.ts';
  import { page } from './page.svelte.ts';
  import Relays from './Relays.svelte';

  // Saves the settings form for relay choices. The page shows errors.
  let { save }: { save: () => Promise<void> } = $props();

  type Stats = Awaited<ReturnType<typeof storageStats>>;
  const size = (n: number) =>
    n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KiB' : (n / 1048576).toFixed(1) + ' MiB';
  const labels = new Map([
    [0, 'Profile'],
    [1, 'Note'],
    [6, 'Repost'],
    [16, 'Generic repost'],
    [20, 'Picture'],
    [21, 'Video'],
    [22, 'Short video'],
    [1063, 'File metadata'],
    [1111, 'Comment'],
    [30023, 'Article'],
  ]);

  let stats = $state<Stats>();
  let message = $state('');
  let reloads = $state(0);
  // How many items each open type shows.
  let shown = $state<Record<number, number>>({});

  const archiveName = $derived(page.section === 'storage' ? page.status?.conf.archiveName : undefined);

  // Reads the archive when the panel opens or the user asks, not on every status refresh.
  $effect(() => {
    const name = archiveName;
    void reloads;
    stats = undefined;
    shown = {};
    message = name ? 'Checking storage…' : '';
    if (!name) return;
    let current = true;
    (async () => {
      const db = await openArchive(name);
      try {
        const next = await storageStats(db);
        if (!current) return;
        stats = next;
        message = next.kinds.length ? '' : 'No items in this backup yet.';
      } finally {
        db.close();
      }
    })().catch((e) => {
      if (current) message = e.message;
    });
    return () => {
      current = false;
    };
  });

  const totals = $derived<[string, string | number][]>(
    stats
      ? [
          ['Items in your backup', stats.kinds.reduce((n, kind) => n + kind.events.length, 0)],
          ['Size of saved items', size(stats.kinds.reduce((n, kind) => n + kind.bytes, 0))],
          ['Saved versions', stats.retained],
          ['Pieces in the backup index', stats.blocks],
          ['Space used by the index', size(stats.blockBytes)],
          ['Unique media files', stats.mediaFiles],
          ['Original media bytes', size(stats.mediaBytes)],
          ['Media block storage', size(stats.mediaBlockBytes)],
          ['Public posts being prepared', stats.drafts],
          ['Copies waiting to send', stats.pending],
        ]
      : [],
  );
  const title = (row: KindStats) =>
    `${labels.get(row.kind) ?? 'Other items (type ' + row.kind + ')'} · ${row.events.length} · ${size(row.bytes)}`;
</script>

<h2>Storage</h2>
<Relays {save} />
<p id="storageState" role="status">{message}</p>
<div id="storageDetails" hidden={!stats}>
  <section>
    <h3>On this device</h3>
    <dl id="storageTotals">
      {#each totals as [label, value] (label)}<dt>{label}</dt><dd>{value}</dd>{/each}
    </dl>
  </section>
  <section>
    <h3>Saved items by type</h3>
    <p class="hint">Choose a type to see individual items and how much space they use.</p>
    <div id="kindList">
      {#each stats?.kinds ?? [] as row (row.kind)}
        <details ontoggle={(e) => (e.currentTarget.open ? (shown[row.kind] ??= 25) : undefined)}>
          <summary>{title(row)}</summary>
          {#if shown[row.kind]}
            <table>
              <thead><tr><th>Item ID</th><th>Created</th><th>Bytes</th></tr></thead>
              <tbody>
                {#each row.events.slice(0, shown[row.kind]) as event (event.id)}
                  <tr>
                    <td>{event.id}</td>
                    <td>{new Date(event.createdAt * 1000).toLocaleString()}</td>
                    <td>{event.bytes.toLocaleString()}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
            {#if shown[row.kind] < row.events.length}
              <button class="quiet" onclick={() => (shown[row.kind] += 25)}>Show more</button>
            {/if}
          {/if}
        </details>
      {/each}
    </div>
  </section>
</div>
<button class="secondary" id="refreshStats" hidden={!archiveName} onclick={() => reloads++}>Refresh statistics</button>
