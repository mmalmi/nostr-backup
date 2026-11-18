import type { Filter } from 'nostr-tools/filter';
import { verifyEvent, type Event } from 'nostr-tools/pure';
import type { Archive, Entry, RelayKindFilter } from './types.ts';
import {
  HistoryCursor,
  relaySource,
  SOURCE_PRIORITY_RELAY,
  RateLimitAwarePool,
  RelayRateLimitError,
  SimplePoolNostrRelayTransport,
} from 'nostr-pubsub';
import { isOwnEvent, matchesRelayKind, relayKindScope } from './model.ts';
import { compareEvents } from './reconcile.ts';
import { inventory } from './archive.ts';

interface RelayPage {
  events: Event[];
  complete: boolean;
  reason?: string;
  throttle?: RelayRateLimitError | null;
}
export interface ImportOptions {
  db: Archive;
  url: string;
  pubkey: string;
  relayKinds?: RelayKindFilter;
  save: (entries: Entry[], pubkey: string) => Promise<number>;
  enabled: () => Promise<boolean>;
}
export interface ImportResult {
  since?: number;
  until?: number;
  have?: Set<string>;
  kinds?: number[];
  report?: string;
}

export const pool = new RateLimitAwarePool();
export function publish(relay: string, event: Event) {
  if (!verifyEvent(event)) throw Error('Could not verify who created this item.');
  return new SimplePoolNostrRelayTransport({
    pool,
    getRelays: () => [relay],
    publishTimeoutMs: 8000,
  }).publish(event);
}

// Use the concrete subscription for history. A pool can synthesize aggregate
// EOSE on disconnect. Only wire EOSE may advance a durable archive cursor.
export async function readPage(url: string, filter: Filter, connection = pool) {
  const relay = await connection.ensureRelay(url, { connectionTimeout: 7000 });
  return new Promise<RelayPage>((resolve, reject) => {
    const id = crypto.randomUUID();
    const limit = connection.watchRateLimit(url, 'CLOSED', id);
    let subscription: ReturnType<typeof relay.subscribe> | undefined,
      finished = false;
    const events = new Map<string, Event>();
    const finish = (complete: boolean, reason?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (subscription && relay.openSubs.has(id)) subscription.close();
      resolve({ events: [...events.values()], complete, reason, throttle: limit(reason) });
    };
    const timer = setTimeout(() => finish(false, 'Relay timed out before EOSE.'), 10000);
    try {
      subscription = relay.subscribe([filter], {
        id,
        eoseTimeout: 30000,
        onevent(event) {
          if (
            isOwnEvent(event, filter.authors?.[0] ?? '') &&
            (!filter.kinds || filter.kinds.includes(event.kind)) &&
            (!filter.ids || filter.ids.includes(event.id)) &&
            event.created_at <= (filter.until ?? Infinity) &&
            event.created_at >= (filter.since ?? 0)
          )
            events.set(event.id, event);
          if (events.size > (filter.limit ?? Infinity))
            finish(false, 'Relay exceeded the requested page size.');
        },
        oneose: () => finish(true),
        onclose: (reason) => finish(false, reason || 'Relay closed before EOSE.'),
      });
    } catch (e) {
      clearTimeout(timer);
      limit();
      reject(e);
    }
  });
}

async function finishImport(db: Archive, key: string[], scope: string, through: number) {
  const tx = db.transaction(['cursors', 'meta'], 'readwrite');
  tx.objectStore('cursors').put({ scope, through }, key);
  tx.objectStore('meta').put(Date.now(), ['lastSyncedAt', key[1]]);
  await tx.done;
}

// Older checkpoints only cover post kinds. A different selection needs its own full pass.
async function importCheckpoint(db: Archive, key: string[], scope: string) {
  const checkpoint = await db.get('cursors', key);
  return checkpoint?.scope === scope ? checkpoint : {};
}

// Relays support inclusive kind lists. Exclusions are applied after reading the wire page.
function authorFilter(pubkey: string, relayKinds?: RelayKindFilter): Filter {
  return { authors: [pubkey], ...(relayKinds?.mode === 'include' && { kinds: relayKinds.kinds }) };
}

export async function importWithNegentropy({
  db,
  url,
  pubkey,
  relayKinds,
  save,
  enabled,
}: ImportOptions): Promise<ImportResult> {
  const key = [pubkey, url];
  const scope = relayKindScope(relayKinds);
  const checkpoint = await importCheckpoint(db, key, scope);
  if (checkpoint.next) return {}; // Resume the paged fallback from its committed boundary.
  const since = Math.max(0, (checkpoint.through ?? 0) - 86400);
  const until = Math.floor(Date.now() / 1000);
  const filter = { ...authorFilter(pubkey, relayKinds), since, until };
  if (since > until) return {};
  const records = await inventory(db, since, until, filter.kinds);
  if (!records) return {};
  let diff;
  try {
    diff = await compareEvents(url, filter, records, true);
  } catch (error) {
    if (error instanceof RelayRateLimitError) throw error;
    return {};
  }
  const result = { since, until, kinds: filter.kinds, have: diff.have };
  const ids = [...diff.need];
  let imported = 0;
  for (let start = 0; start < ids.length; start += 100) {
    if (!(await enabled())) return { ...result, report: 'Import paused' };
    const candidates = ids.slice(start, start + 100);
    // Local-only IDs stay out of relay inventories, even when we already hold the event.
    const known = await Promise.all(candidates.map(id => db.getKey('events', id)));
    const batch = candidates.filter((_, i) => !known[i]);
    if (!batch.length) continue;
    const page = await readPage(url, { ...filter, ids: batch, limit: batch.length });
    const stillEnabled = await enabled();
    const accepted = page.events.filter(event => matchesRelayKind(event.kind, relayKinds));
    if (stillEnabled && accepted.length)
      imported += await save(
        accepted.map((event) => ({ event })),
        pubkey,
      );
    if (page.throttle) throw page.throttle;
    if (!stillEnabled) return { ...result, report: 'Import paused' };
    if (!page.complete || page.events.length !== batch.length) {
      return { ...result, report: `${imported} imported · Incomplete relay response, will retry` };
    }
  }
  if (!(await enabled())) return { ...result, report: 'Import paused' };
  await finishImport(db, key, scope, until);
  return { ...result, report: `Negentropy import · ${imported} new` };
}

export async function syncHistory({
  db,
  url,
  pubkey,
  relayKinds,
  save,
  read = readPage,
  now = Math.floor(Date.now() / 1000),
  pageBudget = 8,
  enabled = async () => true,
}: Omit<ImportOptions, 'enabled'> & {
  enabled?: ImportOptions['enabled'];
  read?: typeof readPage;
  now?: number;
  pageBudget?: number;
}) {
  const key = [pubkey, url];
  const scope = relayKindScope(relayKinds);
  const checkpoint = await importCheckpoint(db, key, scope);
  // Scan through the time at which this pass began. An overlap also recovers
  // events that arrived a little late on the relay. Full rescan is available.
  const started = checkpoint.started ?? now;
  const filter = {
    ...authorFilter(pubkey, relayKinds),
    limit: 100,
    until: started,
    ...(checkpoint.through ? { since: Math.max(0, checkpoint.through - 86400) } : {}),
    ...checkpoint.next,
  };
  const source = relaySource(url);
  const cursor = new HistoryCursor(url, filter, now, 1600);
  let page = cursor.beginPage();
  for (let i = 0; i < pageBudget; i++) {
    if (!(await enabled())) return 'Import paused';
    if (!page) throw Error('History cursor has no active page.');
    const result = await read(url, page.filter);
    if (!(await enabled())) return 'Import paused';
    const accepted = [];
    for (const event of result.events) {
      if (
        isOwnEvent(event, pubkey) &&
        cursor.observe(page.token, { source, priority: SOURCE_PRIORITY_RELAY, event }) &&
        matchesRelayKind(event.kind, relayKinds)
      )
        accepted.push({ event });
    }
    if (accepted.length) await save(accepted, pubkey);
    if (result.throttle) throw result.throttle;
    const { status } = cursor.finishPage(page.token, result.complete ? 'complete' : 'partial');
    if (status === 'retry') throw Error(result.reason || 'Incomplete relay page. Will retry.');
    if (status === 'limited')
      throw Error('Too many events at one timestamp. History is incomplete.');
    if (status === 'exhausted') {
      await finishImport(db, key, scope, started);
      return 'Up to date';
    }
    page = cursor.beginPage();
    if (!page) throw Error('History cursor did not advance.');
    const { until, limit } = page.filter;
    await db.put('cursors', { scope, through: checkpoint.through, started, next: { until, limit } }, key);
  }
  return 'More history queued';
}
