import type { RelayProgress, RelayStatus } from './types.ts';
import { el } from './ui.ts';

const phases: Record<RelayProgress['phase'], string> = {
  queued: 'Queued',
  connecting: 'Connecting',
  importing: 'Importing',
  broadcasting: 'Broadcasting',
  index: 'Publishing index',
  finished: 'Finished',
  partial: 'More to sync',
  idle: 'Idle',
  retry: 'Retry pending',
  error: 'Failed',
};
let previous = '';
export function showRelayStatus(relays: RelayStatus[]) {
  const value = JSON.stringify(relays);
  if (value === previous) return;
  previous = value;
  el('reports').replaceChildren(
    ...relays.map((relay) => {
      const row = document.createElement('li');
      row.className = 'relayRow';
      const identity = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = new URL(relay.url).host;
      name.title = relay.url;
      const connection = document.createElement('span');
      connection.className = 'relayConnection ' + relay.connection;
      connection.textContent =
        relay.connection === 'connected'
          ? 'Connected'
          : relay.connection === 'connecting'
            ? 'Connecting…'
            : 'Disconnected';
      identity.append(name, connection);
      if (relay.lastSyncedAt) {
        const time = document.createElement('small');
        time.textContent = 'Last synced ' + new Date(relay.lastSyncedAt).toLocaleString();
        identity.append(time);
      }
      const activity = document.createElement('div');
      const phase = document.createElement('strong');
      phase.textContent = phases[relay.phase];
      activity.append(phase);
      if (
        relay.retryAt ||
        (relay.detail && ['retry', 'error', 'partial'].includes(relay.phase))
      ) {
        const detail = document.createElement('small');
        detail.textContent = relay.retryAt
          ? 'Retry after ' + new Date(relay.retryAt).toLocaleTimeString()
          : relay.detail!;
        activity.append(detail);
      }
      const counts = document.createElement('div');
      counts.className = 'relayCounts';
      const imported = document.createElement('span');
      imported.textContent = relay.imported.toLocaleString() + ' imported';
      const sent = document.createElement('span');
      sent.textContent =
        relay.sent.toLocaleString() + ' sent · ' + relay.pending.toLocaleString() + ' queued';
      counts.append(imported, sent);
      if (relay.present) {
        const present = document.createElement('small');
        present.textContent = relay.present.toLocaleString() + ' already on relay';
        counts.append(present);
      }
      const total = relay.sent + relay.present + relay.pending;
      if (total) {
        const progress = document.createElement('progress');
        progress.max = total;
        progress.value = relay.sent + relay.present;
        progress.setAttribute(
          'aria-label',
          'Broadcast progress for ' + new URL(relay.url).host,
        );
        counts.append(progress);
      }
      row.append(identity, activity, counts);
      return row;
    }),
  );
}
