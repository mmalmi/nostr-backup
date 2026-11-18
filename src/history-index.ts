import { BLOB_MAX_BYTES, toHex, type CID } from '@hashtree/core';
import { HASHTREE_ROOT_KINDS, NostrEventStore, parseHashtreeRootEvent } from '@hashtree/nostr';
import type { Event } from 'nostr-tools/pure';
import { RateLimitAwarePool } from 'nostr-pubsub';
import { readPointer } from './archive.ts';
import { readOnlyStore, readRoot, withIndexSnapshot } from './blocks.ts';
import { isHistoryKind } from './event-history.ts';
import { download } from './media-files.ts';
import { blossomOrigin } from './media-refs.ts';
import { isOwnEvent } from './model.ts';
import { readPage } from './relays.ts';
import type { Archive, Settings } from './types.ts';

// A history refresh reads only the owner's named public event index. Blocks from
// a configured backup server are checked by hash and never added to the block cache.
export async function readHistoryIndexes(db: Archive, owner: string, pointers: Event[], server?: string, fetcher = fetch) {
  const deadline = AbortSignal.timeout(8000);
  const origin = server && blossomOrigin(server);
  const events = new Map<string, Event>();
  const roots = new Map<string, {cid: CID; published: boolean}>();
  let remaining = 4 * 1024 * 1024, requests = 0;
  const store = (published: boolean) => readOnlyStore(async hash => {
    deadline.throwIfAborted();
    const id = toHex(hash);
    const local = await db.get('blocks', id);
    if (local) return local;
    if (!published || !origin || ++requests > 64 || remaining <= 0) return null;
    const { bytes } = await download(origin + '/' + id, id, Math.min(BLOB_MAX_BYTES, remaining),
      (url, options) => fetcher(url, {...options, signal: deadline, redirect: 'error'}));
    remaining -= bytes.byteLength;
    return bytes;
  });
  return withIndexSnapshot(db, async () => {
    const local = await readRoot(db);
    if (local) roots.set(toHex(local.hash), {cid: local, published: false});
    for (const event of pointers.sort((a,b) => b.created_at - a.created_at || a.id.localeCompare(b.id))) {
      if (!isOwnEvent(event, owner)) continue;
      const root = parseHashtreeRootEvent(event);
      if (root?.treeName === 'my-events' && root.visibility === 'public') roots.set(toHex(root.rootCid.hash), {cid: root.rootCid, published: true});
      if (roots.size >= 3) break;
    }
    for (const {cid, published} of roots.values()) {
      const index = new NostrEventStore(store(published));
      for (const kind of [0,3]) {
        if (deadline.aborted) return [...events.values()];
        try {
          const rows = await index.query(cid, {authors: owner, kinds: kind}, {limit: kind === 0 ? 11 : 4});
          for (const row of rows) if (row.kind === kind && isOwnEvent(row, owner)) events.set(row.id, row);
        } catch { /* A missing snapshot cannot invalidate events from another source. */ }
      }
    }
    return [...events.values()];
  });
}

const active = new Map<string, Promise<Event[]>>();
export function observedIndexVersions(db: Archive, conf: Settings) {
  const key = JSON.stringify([db.name, conf.pubkey, conf.blossomServer, conf.relays]);
  const pending = active.get(key);
  if (pending) return pending;
  const read = (async () => {
    const saved = await readPointer(db);
    const connections = new RateLimitAwarePool();
    const filter = {authors: [conf.pubkey], kinds: [...HASHTREE_ROOT_KINDS], '#d': ['my-events'], limit: 2};
    const replies = await Promise.allSettled(conf.relays.map(url => readPage(url, filter, connections)))
      .finally(() => connections.destroy());
    const pointers = replies.flatMap(reply => reply.status === 'fulfilled' ? reply.value.events : []);
    if (saved) pointers.push(saved.event);
    return readHistoryIndexes(db, conf.pubkey, pointers, conf.blossomServer);
  })().finally(() => active.delete(key));
  active.set(key, read);
  return read;
}

export function ownHistoryEvents(events: Event[], owner: string) {
  return [...new Map(events.filter(event => isHistoryKind(event.kind) && isOwnEvent(event, owner))
    .map(event => [event.id, event])).values()];
}
