import type { RelayStatus } from './types.ts';

/** How a relay is doing, for its dot and label. */
export type RelayTone = 'ok' | 'busy' | 'warn';

/** What the Backup page says about the online copies. */
export interface OnlineSummary {
  tone: RelayTone | 'off';
  text: string;
  /** Which relays failed in the last sync, and what happens to items waiting for them. */
  problem?: string;
}

const busyPhases = new Set<RelayStatus['phase']>(['queued', 'connecting', 'importing', 'broadcasting', 'index']);

export const relayHost = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
/** When a relay last synced, as the pages show it. */
export const syncedAt = (at: number) =>
  new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const items = (n: number) => n.toLocaleString() + (n === 1 ? ' item' : ' items');
const failed = (relay: RelayStatus) => relay.phase === 'error' || relay.phase === 'retry';
const list = (words: string[]) => new Intl.ListFormat('en', { type: 'conjunction' }).format(words);

export function relayTone(relay: RelayStatus): RelayTone {
  if (failed(relay)) return 'warn';
  return busyPhases.has(relay.phase) || relay.phase === 'partial' || relay.pending ? 'busy' : 'ok';
}

/** What a relay is doing now, in a few words. */
export function relayState(relay: RelayStatus) {
  switch (relay.phase) {
    case 'queued':
      return 'Waiting for its turn';
    case 'connecting':
      return 'Connecting';
    case 'importing':
      return 'Downloading posts';
    case 'broadcasting':
      return 'Sending posts';
    case 'index':
      return 'Sharing backup link';
    case 'partial':
      return 'More to download';
    case 'retry':
      return 'Asked to wait';
    case 'error':
      return 'Failed';
    default:
      return relay.pending ? 'Waiting to send' : 'Up to date';
  }
}

/** Why the failed relays failed. */
function reason(down: RelayStatus[]) {
  const [first] = down;
  if (down.length > 1) return 'Sync failed with ' + list(down.map((relay) => relayHost(relay.url))) + '.';
  if (first.phase === 'retry')
    return (
      relayHost(first.url) +
      ' asked to wait' +
      (first.retryAt ? ' until ' + new Date(first.retryAt).toLocaleTimeString([], { timeStyle: 'short' }) : '') +
      '.'
    );
  return 'Sync with ' + relayHost(first.url) + ' failed' + (first.detail ? ': ' + first.detail.replace(/\.$/, '') : '') + '.';
}

/**
 * One line about the online copies, and a second one when relays failed.
 * Relays close their connections after each sync, so connection state says nothing here.
 */
export function onlineSummary(relays: RelayStatus[], pending: number, running: boolean): OnlineSummary {
  if (!relays.length) return { tone: 'off', text: 'Online copies are off. Choose relays to keep copies of your public posts.' };
  const down = relays.filter(failed);
  const retrying = pending ? 'Social Backup keeps trying to send ' + items(pending) + '.' : '';
  const problem = down.length ? (reason(down) + ' ' + retrying).trim() : undefined;
  if (running) return { tone: 'busy', text: pending ? 'Syncing… ' + items(pending) + ' left to send.' : 'Syncing…', problem };
  const current = relays.filter((relay) => !failed(relay) && !relay.pending).length;
  if (current === relays.length)
    return {
      tone: 'ok',
      text:
        'Online copies are up to date on ' +
        (relays.length === 1 ? relayHost(relays[0].url) : 'all ' + relays.length + ' relays') +
        '.',
    };
  if (down.length === relays.length)
    return {
      tone: 'warn',
      text: (relays.length === 1 ? reason(down) : 'Sync failed with every relay.') + ' Your backup is safe on this device.',
      problem: retrying || undefined,
    };
  return {
    tone: down.length ? 'warn' : 'busy',
    text:
      (current ? 'Online copies are up to date on ' + current + ' of ' + relays.length + ' relays.' : 'Online copies are being updated.') +
      (pending && !down.length ? ' ' + items(pending) + ' waiting to send.' : ''),
    problem,
  };
}
