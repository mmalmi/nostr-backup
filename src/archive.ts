import type { Archive, ArchiveSchema, Settings, Entry, Capture, IndexPointer } from './types.ts';
import type { Event } from 'nostr-tools/pure';
import type { CID, Store } from '@hashtree/core';
import type { Zippable } from 'fflate';
import { openDB } from 'idb';
import { NostrEventStore } from '@hashtree/nostr';
import { zipSync, strToU8 } from 'fflate';
import { mediaReferences } from './media-refs.ts';
import { openMediaBlocks } from './media-files.ts';
import { hex, unhex, isOwnPost } from './model.ts';

// The meta store contains three key-specific value types.
export const readRoot = (db: Archive) => db.get('meta', 'root') as Promise<CID | undefined>;
export const readPointer = (db: Archive) =>
  db.get('meta', 'indexPointer') as Promise<IndexPointer | undefined>;
export const readCooldown = (db: Archive, url: string) =>
  db.get('meta', ['retryAfter', url]) as Promise<number | undefined>;

export function openArchive(name = 'nostr-backup-v1') {
  const opened = openDB<ArchiveSchema>(name, 3, {
    blocking() {
      void opened.then((db) => db.close());
    },
    upgrade(db, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
        for (const store of [
          'blocks',
          'meta',
          'events',
          'drafts',
          'sources',
          'outbox',
          'cursors',
        ] as const)
          db.createObjectStore(store);
      }
      if (oldVersion < 2) tx.objectStore('events').createIndex('created_at', 'created_at');
      const refs = db.createObjectStore('mediaRefs', { keyPath: ['eventId', 'url'] });
      refs.createIndex('url', 'url');
      db.createObjectStore('mediaFiles', { keyPath: 'sha256' });
      if (oldVersion) {
        const backfill = async () => {
          for (let c = await tx.objectStore('events').openCursor(); c; c = await c.continue())
            for (const ref of mediaReferences(c.value)) await refs.put(ref);
        };
        backfill().catch(() => tx.abort());
      }
    },
  });
  return opened;
}

// Only the background writes tree roots. Stage immutable blocks, then commit the
// root, records, and delivery state together. A stopped worker leaves the old root valid.
export async function append(db: Archive, entries: Entry[], pubkey: string) {
  const fresh = new Map<string, Event>(),
    blocks = new Map<string, Uint8Array>();
  for (const { event } of entries) {
    if (!isOwnPost(event, pubkey)) throw Error('Invalid event signature, author or post kind.');
    if (!fresh.has(event.id) && !(await db.getKey('events', event.id))) fresh.set(event.id, event);
  }
  const store: Store = {
    async delete() {
      throw Error('Index blocks are immutable.');
    },
    async put(hash, bytes) {
      blocks.set(hex(hash), bytes);
      return true;
    },
    async get(hash) {
      return blocks.get(hex(hash)) ?? (await db.get('blocks', hex(hash))) ?? null;
    },
    async has(hash) {
      return !!(await this.get(hash));
    },
  };
  const oldRoot = await readRoot(db);
  const root = fresh.size
    ? await new NostrEventStore(store).build(oldRoot ?? null, [...fresh.values()])
    : oldRoot;
  const tx = db.transaction(
    ['blocks', 'meta', 'events', 'sources', 'drafts', 'outbox', 'mediaRefs'],
    'readwrite',
  );

  for (const [key, bytes] of blocks) tx.objectStore('blocks').put(bytes, key);
  if (root) tx.objectStore('meta').put(root, 'root');
  for (const [id, event] of fresh)
    tx.objectStore('events').put(JSON.parse(JSON.stringify(event)), id);
  for (const { event, source, targets, posters } of entries) {
    if (fresh.has(event.id)) {
      for (const ref of mediaReferences(event, posters)) tx.objectStore('mediaRefs').put(ref);
    }
    if (!source) continue;
    tx.objectStore('sources').put(event.id, source);
    tx.objectStore('drafts').delete(source);
    for (const relay of targets ?? []) {
      const key: [string, string] = [event.id, relay];
      if (!(await tx.objectStore('outbox').getKey(key)))
        tx.objectStore('outbox').put({ id: event.id, relay }, key);
    }
  }
  await tx.done;
  return fresh.size;
}

export async function stagePosts(db: Archive, posts: Capture[]) {
  const tx = db.transaction(['sources', 'drafts'], 'readwrite');
  for (const post of posts) {
    const key = 'x:' + post.id;
    if (!(await tx.objectStore('sources').getKey(key)))
      await tx.objectStore('drafts').put(post, key);
  }
  await tx.done;
}

export async function inventory(db: Archive, since: number, until: number) {
  const index = db.transaction('events').store.index('created_at');
  const range = IDBKeyRange.bound(since, until);
  const records = [];
  for (let cursor = await index.openKeyCursor(range); cursor; cursor = await cursor.continue()) {
    records.push({ id: cursor.primaryKey, created_at: cursor.key });
    if (records.length > 100000) return; // Use the paged importer above the engine's record limit.
  }
  return records;
}

export async function queueBroadcast(
  db: Archive,
  { relays, relaySync, pubkey }: Pick<Settings, 'relays' | 'relaySync' | 'pubkey'>,
) {
  if (!relays.length) throw Error('Save at least one relay before broadcasting.');
  const tx = db.transaction(['events', 'outbox', 'cursors'], 'readwrite');
  // A manual two-way sync covers all history, including a relay with no local matches.
  if (relaySync) {
    for (const url of relays) tx.objectStore('cursors').delete([pubkey, url]);
  }
  const outbox = tx.objectStore('outbox');
  let count = 0;
  for (
    let cursor = await tx.objectStore('events').openCursor();
    cursor;
    cursor = await cursor.continue()
  ) {
    const { id, created_at } = cursor.value;
    for (const relay of relays) outbox.put({ id, relay, broadcast: true, created_at }, [id, relay]);
    count++;
  }
  await tx.done;
  return count;
}

export async function dump(db: Archive, pubkey: string) {
  const tx = db.transaction([
    'blocks',
    'events',
    'meta',
    'drafts',
    'outbox',
    'sources',
    'mediaFiles',
    'mediaRefs',
  ]);

  const [events, root, keys, data, drafts, pending, sources, ids, mediaFiles, references] =
    await Promise.all([
      tx.objectStore('events').getAll(),
      tx.objectStore('meta').get('root') as Promise<CID | undefined>,
      tx.objectStore('blocks').getAllKeys(),
      tx.objectStore('blocks').getAll(),
      tx.objectStore('drafts').getAll(),
      tx.objectStore('outbox').getAll(),
      tx.objectStore('sources').getAllKeys(),
      tx.objectStore('sources').getAll(),
      tx.objectStore('mediaFiles').getAll(),
      tx.objectStore('mediaRefs').getAll(),
    ]);
  const cid = root && { hash: hex(root.hash), ...(root.key ? { key: hex(root.key) } : {}) };
  const json = (v: unknown) => strToU8(JSON.stringify(v, null, 2));
  const files: Zippable = {
    'manifest.json': json({
      version: 2,
      mediaFiles: mediaFiles.length,
      pubkey,
      events: events.length,
      root: cid ?? null,
      exportedAt: new Date().toISOString(),
    }),
    'media.json': json({ files: mediaFiles, references }),
    'events.jsonl': strToU8(events.map((e) => JSON.stringify(e) + '\n').join('')),
    'x-sources.json': json(Object.fromEntries(sources.map((k, i) => [k, ids[i]]))),
    'unsigned-x-posts.json': json(drafts),
    'pending-deliveries.json': json(pending),
  };
  keys.forEach((key, i) => {
    files['blocks/' + key] = data[i];
  });
  if (mediaFiles.length) {
    const store = openMediaBlocks(db);
    try {
      for (const file of mediaFiles) {
        for (const key of file.blocks) {
          const path = 'blocks/' + key;
          if (files[path]) continue;
          const block = await store.get(unhex(key));
          if (!block) throw Error('Missing media block ' + key + '.');
          files[path] = [block, { level: 0 }];
        }
      }
    } finally {
      store.close();
    }
  }
  return zipSync(files, { level: 1 });
}
