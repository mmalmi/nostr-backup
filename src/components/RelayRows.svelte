<script lang="ts">
  import type { RelayProgress, RelayStatus } from '../types.ts';

  let { relays }: { relays: RelayStatus[] } = $props();

  const phases: Record<RelayProgress['phase'], string> = {
    queued: 'Queued',
    connecting: 'Connecting',
    importing: 'Importing',
    broadcasting: 'Sharing',
    index: 'Sharing backup link',
    finished: 'Finished',
    partial: 'More to sync',
    idle: 'Idle',
    retry: 'Retry pending',
    error: 'Failed',
  };
  const connection = { connected: 'Connected', connecting: 'Connecting…', disconnected: 'Disconnected' };
  const host = (url: string) => new URL(url).host;
  const detail = (relay: RelayStatus) =>
    relay.retryAt
      ? 'Retry after ' + new Date(relay.retryAt).toLocaleTimeString()
      : relay.detail && ['retry', 'error', 'partial'].includes(relay.phase)
        ? relay.detail
        : '';
</script>

<ul id="reports" class="relayRows" aria-label="Relay status">
  {#each relays as relay (relay.url)}
    {@const total = relay.sent + relay.present + relay.pending}
    <li class="relayRow">
      <div>
        <strong title={relay.url}>{host(relay.url)}</strong>
        <span class="relayConnection {relay.connection}">{connection[relay.connection]}</span>
        {#if relay.lastSyncedAt}<small>Last synced {new Date(relay.lastSyncedAt).toLocaleString()}</small>{/if}
      </div>
      <div>
        <strong>{phases[relay.phase]}</strong>
        {#if detail(relay)}<small>{detail(relay)}</small>{/if}
      </div>
      <div class="relayCounts">
        <span>{relay.imported.toLocaleString()} imported</span>
        <span>{relay.sent.toLocaleString()} sent · {relay.pending.toLocaleString()} queued</span>
        {#if relay.present}<small>{relay.present.toLocaleString()} already on relay</small>{/if}
        {#if total}
          <progress
            max={total}
            value={relay.sent + relay.present}
            aria-label={'Broadcast progress for ' + host(relay.url)}
          ></progress>
        {/if}
      </div>
    </li>
  {/each}
</ul>
