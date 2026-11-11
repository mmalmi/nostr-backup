import type { Archive, Delivery, Settings } from './types.ts';
import { errorMessage } from './types.ts';
import type { ImportResult } from './relays.ts';
import { normalizeURL } from 'nostr-tools/utils';
import { POST_KINDS } from './model.ts';
import { pool, publish } from './relays.ts';
import { compareEvents } from './reconcile.ts';
import { RelayRateLimitError } from 'nostr-pubsub';

export async function deliverPending(
  db: Archive,
  url: string,
  rows: Delivery[],
  settings: () => Promise<Settings>,
  pubkey: string,
  imported?: ImportResult,
) {
  const automatic = rows.filter((row) => !row.broadcast).slice(0, 100);
  const broadcast = rows
    .filter(
      (row): row is Delivery & { created_at: number } =>
        !!row.broadcast && row.created_at !== undefined,
    )
    .sort((a, b) => a.created_at - b.created_at);
  let published = 0,
    present = 0,
    failed = 0,
    lastError,
    mode = imported?.have ? 'Negentropy broadcast' : imported ? 'Direct broadcast' : undefined;
  async function deliver(batch: Delivery[]) {
    for (const row of batch) {
      const current = await settings();
      if (!current.relays.includes(url)) return false;
      if (!row.broadcast && !current.capture) continue;
      const event = await db.get('events', row.id);
      if (!event) throw Error('Queued event is missing from the archive.');
      try {
        await publish(url, event);
      } catch (error) {
        if (error instanceof RelayRateLimitError) throw error;
        failed++;
        lastError = errorMessage(error);
        // Continue past individual rejections. Leave an unresponsive relay for the next pass.
        if (!pool.listConnectionStatus().get(normalizeURL(url)) || lastError.endsWith('timed out'))
          return false;
        continue;
      }
      await db.delete('outbox', [row.id, url]);
      published++;
    }
    return true;
  }
  const available = await deliver(automatic);
  for (let start = 0; available && start < broadcast.length; start += 512) {
    if (!(await settings()).relays.includes(url)) break;
    let batch = broadcast.slice(start, start + 512);
    let missing: Set<string> | undefined;
    if (imported?.have) {
      // Entries outside the import window still have an outstanding delivery.
      missing = new Set(
        batch
          .filter(
            (row) =>
              row.created_at < (imported.since ?? 0) ||
              row.created_at > (imported.until ?? Infinity) ||
              imported.have!.has(row.id),
          )
          .map((row) => row.id),
      );
    } else if (mode !== 'Direct broadcast') {
      try {
        const filter = {
          authors: [pubkey],
          kinds: POST_KINDS,
          since: batch[0].created_at,
          until: batch[batch.length - 1].created_at,
        };
        missing = (await compareEvents(url, filter, batch, false)).have;
        mode = 'Negentropy broadcast';
      } catch (error) {
        if (error instanceof RelayRateLimitError) throw error;
        mode = 'Direct broadcast';
      }
    }
    if (missing && missing.size < batch.length) {
      const tx = db.transaction('outbox', 'readwrite');
      for (const row of batch) {
        if (!missing.has(row.id)) tx.store.delete([row.id, url]);
      }
      await tx.done;
      present += batch.length - missing.size;
      batch = batch.filter((row) => missing!.has(row.id));
    }
    if (!(await deliver(batch))) break;
  }
  const report = [];
  if (mode && broadcast.length) report.push(mode);
  if (published) report.push(`${published} acknowledged`);
  if (present) report.push(`${present} already on relay`);
  if (failed) report.push(`${failed} pending retry (${lastError})`);
  return report.join(' · ');
}
