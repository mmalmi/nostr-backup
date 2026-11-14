import type { Archive, BlossomDelivery } from './types.ts';
import { errorMessage } from './types.ts';
import { openMediaBlocks, putBlossom, readMediaFile, BlossomResponseError } from './media-files.ts';
import { xImageURLs, publicImageURL } from './x-media.ts';
import { publicMediaURL } from './media-refs.ts';
import { shareableMediaHashes } from './legacy-x.ts';
import type { Event } from 'nostr-tools/pure';

// Persist one intent per blob and destination. A manual sync rechecks past receipts.
export async function queueBlossom(
  db: Archive,
  hashes: Iterable<string>,
  servers: string[],
  check: boolean,
) {
  const tx = db.transaction(['mediaFiles', 'blossomOutbox', 'meta'], 'readwrite');
  if (check) for (const server of servers) tx.objectStore('meta').delete(['blossomRetry', server]);
  let count = 0;
  for (const hash of hashes) {
    const file = await tx.objectStore('mediaFiles').get(hash);
    if (!file) continue;
    for (const server of servers) {
      if (!check && file.copies.includes(server)) continue;
      const store = tx.objectStore('blossomOutbox');
      const old = await store.get([hash, server]);
      if (check || !old) await store.put({ hash, server, attempts: 0, check });
      count++;
    }
  }
  await tx.done;
  return count;
}

export async function deliverBlossom(
  db: Archive,
  servers: string[],
  options: {
    captureHandle?: string;
    authorize: (hash: string, server: string) => Promise<Event>;
    fetcher: typeof fetch;
    signal: AbortSignal;
    onCopy?: (hash: string, server: string, url: string) => Promise<void>;
  },
) {
  const pending = await db.getAll('blossomOutbox');
  if (!pending.length) return;
  const allowed = await shareableMediaHashes(db);
  // Public X drafts can upload before the signed note and its media references exist.
  const drafts = await db.getAll('drafts');
  const publicImages = new Set(
    drafts
      .filter(
        (p) => !('source' in p) && p.author === options.captureHandle && p.visibility === 'public',
      )
      .flatMap((p) => xImageURLs(p.text)),
  );
  for (const url of publicImages) {
    const receipt = await db.get('xMedia', url);
    if (receipt?.hash) allowed.add(receipt.hash);
  }
  const blocks = openMediaBlocks(db);
  async function deliver(row: BlossomDelivery) {
    const { hash, server } = row;
    const key: [string, string] = [hash, server];
    if (!allowed.has(hash)) return;
    if ((row.retryAt ?? 0) > Date.now()) return;
    const file = await db.get('mediaFiles', hash);
    if (!file) {
      await db.delete('blossomOutbox', key);
      return;
    }
    let url = file.copyUrls?.[server];
    try {
      let present = false;
      if (row.check) {
        const response = await options.fetcher(new URL('/' + hash, server).href, {
          method: 'HEAD',
          cache: 'no-store',
          redirect: 'error',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: AbortSignal.timeout(15000),
        });
        if (response.ok) present = true;
        else if (![401, 403, 404, 410, 405, 501].includes(response.status))
          throw new BlossomResponseError('check', response);
      }
      if (!present) {
        const bytes = await readMediaFile(blocks, file);
        const auth = await options.authorize(hash, server);
        options.signal.throwIfAborted();
        url = await putBlossom(server, hash, bytes, file.mime, auth, options.fetcher);
        if (publicMediaURL(server) && !publicImageURL(url))
          throw Error('The media backup server returned an unusable public link.');
      }
    } catch (error) {
      options.signal.throwIfAborted();
      const attempts = row.attempts + 1;
      const backoff = Date.now() + Math.min(21600000, 300000 * 2 ** Math.min(attempts - 1, 7));
      const retryAt =
        error instanceof BlossomResponseError ? Math.max(backoff, error.retryAt ?? 0) : backoff;
      const pause =
        error instanceof TypeError ||
        (error instanceof DOMException && error.name === 'TimeoutError') ||
        (error instanceof BlossomResponseError && (error.status === 429 || error.status >= 500));
      if (pause) await db.put('meta', retryAt, ['blossomRetry', server]);
      await db.put('blossomOutbox', { ...row, attempts, retryAt, error: errorMessage(error) });
      return pause;
    }
    url ??= new URL('/' + hash, server).href;
    const tx = db.transaction(['mediaFiles', 'blossomOutbox'], 'readwrite');
    const current = await tx.objectStore('mediaFiles').get(hash);
    if (current)
      await tx
        .objectStore('mediaFiles')
        .put({
          ...current,
          copies: [...new Set([...current.copies, server])],
          copyUrls: { ...current.copyUrls, [server]: url },
        });
    await tx.objectStore('blossomOutbox').delete(key);
    await tx.done;
    await options.onCopy?.(hash, server, url);
  }
  try {
    const results = await Promise.allSettled(
      servers.map(async (server) => {
        const until = (await db.get('meta', ['blossomRetry', server])) as number | undefined;
        if (until && until > Date.now()) return;
        for (const row of pending) {
          options.signal.throwIfAborted();
          if (row.server === server && (await deliver(row))) break;
        }
      }),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  } finally {
    blocks.close();
  }
}
