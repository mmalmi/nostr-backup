import { HistoryCursor, SimplePoolNostrRelayTransport } from 'nostr-pubsub';
import { SimplePool } from 'nostr-tools/pool';
import { POST_KINDS, isOwnPost } from './model.js';

export const pool = new SimplePool();
export function publish(relay, event) {
  return new SimplePoolNostrRelayTransport({
    pool,
    getRelays: () => [relay],
    publishTimeoutMs: 8000,
  }).publish(event);
}

// Use the concrete subscription for history. A pool can synthesize aggregate
// EOSE on disconnect. Only wire EOSE may advance a durable archive cursor.
export async function readPage(url, filter) {
  const relay = await pool.ensureRelay(url, { connectionTimeout: 7000 });
  return new Promise((resolve, reject) => {
    let subscription,
      finished = false;
    const events = new Map();
    const finish = (complete, reason) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      subscription?.close();
      resolve({ events: [...events.values()], complete, reason });
    };
    const timer = setTimeout(() => finish(false, 'Relay timed out before EOSE.'), 10000);
    try {
      subscription = relay.subscribe([filter], {
        eoseTimeout: 30000,
        onevent(event) {
          if (
            isOwnPost(event, filter.authors[0]) &&
            event.created_at <= filter.until &&
            event.created_at >= (filter.since ?? 0)
          )
            events.set(event.id, event);
          if (events.size > filter.limit) finish(false, 'Relay exceeded the requested page size.');
        },
        oneose: () => finish(true),
        onclose: (reason) => finish(false, reason || 'Relay closed before EOSE.'),
      });
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  });
}

export async function syncHistory({
  db,
  url,
  pubkey,
  save,
  read = readPage,
  now = Math.floor(Date.now() / 1000),
  pageBudget = 8,
}) {
  const key = [pubkey, url];
  const checkpoint = (await db.get('cursors', key)) ?? {};
  // Scan through the time at which this pass began. An overlap also recovers
  // posts that arrived a little late on the relay. Full rescan is available.
  const started = checkpoint.started ?? now;
  const filter = {
    authors: [pubkey],
    kinds: POST_KINDS,
    limit: 100,
    until: started,
    ...(checkpoint.through ? { since: Math.max(0, checkpoint.through - 86400) } : {}),
    ...checkpoint.next,
  };
  const cursor = new HistoryCursor(url, filter, now, 1600);
  let page = cursor.beginPage();
  for (let i = 0; i < pageBudget; i++) {
    const result = await read(url, page.filter);
    const accepted = [];
    for (const event of result.events) {
      if (isOwnPost(event, pubkey) && cursor.observe(page.token, { source: { id: url }, event }))
        accepted.push({ event });
    }
    if (accepted.length) await save(accepted, pubkey);
    const { status } = cursor.finishPage(page.token, result.complete ? 'complete' : 'partial');
    if (status === 'retry') throw Error(result.reason || 'Incomplete relay page. Will retry.');
    if (status === 'limited')
      throw Error('Too many posts at one timestamp. History is incomplete.');
    if (status === 'exhausted') {
      await db.put('cursors', { through: started }, key);
      return 'Up to date';
    }
    page = cursor.beginPage();
    const { until, limit } = page.filter;
    await db.put('cursors', { through: checkpoint.through, started, next: { until, limit } }, key);
  }
  return 'More history queued';
}
