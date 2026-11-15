import type { Archive, ArchiveSchema, Settings, Entry, Capture, SocialCapture, IndexPointer } from './types.ts';
import { markLegacyX } from './legacy-x.ts';
import type { Event } from 'nostr-tools/pure';
import type { CID } from '@hashtree/core';
import type { Zippable } from 'fflate';
import { enqueueRelayPublication } from 'nostr-pubsub';
import { openDB, type IDBPTransaction, type StoreNames } from 'idb';
import { ArchiveEventBus } from './archive-event-bus.ts';
import { zipSync, strToU8 } from 'fflate';
import { mediaReferences } from './media-refs.ts';
import { openMediaBlocks } from './media-files.ts';
import { hex, unhex } from './model.ts';

// The meta store contains three key-specific value types.
export { readRoot } from './blocks.ts';
export const readPointer = (db: Archive) =>
  db.get('meta', 'indexPointer') as Promise<IndexPointer | undefined>;
export const readCooldown = (db: Archive, url: string) =>
  db.get('meta', ['retryAfter', url]) as Promise<number | undefined>;

export function openArchive(name = 'nostr-backup-v1') {
  const opened = openDB<ArchiveSchema>(name, 10, {
    blocking() {
      void opened.then((db) => db.close());
    },
    upgrade(db, oldVersion, _newVersion, tx) {
      if (oldVersion < 10) db.createObjectStore('xDirectory', { keyPath: ['pubkey', 'kind'] })
        .createIndex('handles', 'handles', { multiEntry: true });
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
      if (oldVersion < 7) {
        const queue = db.createObjectStore('blossomOutbox', { keyPath: ['hash', 'server'] });
        queue.createIndex('server', 'server');
      }
      if (oldVersion < 5) db.createObjectStore('xMedia');
      if (oldVersion < 4) db.createObjectStore('xMatches');
      if (oldVersion < 6) {
        db.createObjectStore('localCaptures');
        db.createObjectStore('heldEvents');
        if (oldVersion > 0) {
          markLegacyX(tx).catch(() => tx.abort());
          (async () => {
            for (let c = await tx.objectStore('drafts').openCursor(); c; c = await c.continue()) {
              await tx.objectStore('localCaptures').put({ ...c.value, visibility: 'unknown' }, c.primaryKey);
              await c.delete();
            }
          })().catch(() => tx.abort());
        }
      }
      if (oldVersion >= 6 && oldVersion < 9) {
        // Old drafts used page-supplied signing fields. Keep each snapshot
        // local until the post is independently verified on its next capture.
        (async () => {
          for (let c = await tx.objectStore('drafts').openCursor(); c; c = await c.continue()) {
            await tx.objectStore('localCaptures').put({ ...c.value, visibility: 'unknown' }, c.primaryKey);
            await c.delete();
          }
        })().catch(() => tx.abort());
      }
      if (oldVersion >= 3 && oldVersion < 8) {
        tx.objectStore('mediaRefs').createIndex('sha256', 'sha256');
        tx.objectStore('mediaFiles').createIndex('rootHash', 'cid.hash');
      }
      if (oldVersion >= 3) return;
      const refs = db.createObjectStore('mediaRefs', { keyPath: ['eventId', 'url'] });
      refs.createIndex('url', 'url');
      refs.createIndex('sha256', 'sha256');
      db.createObjectStore('mediaFiles', { keyPath: 'sha256' }).createIndex('rootHash', 'cid.hash');
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

// Compatibility entry point for existing archive callers with explicit delivery metadata.
export function append(db: Archive, entries: Entry[], pubkey: string) {
  return new ArchiveEventBus(db, pubkey).publishBatch(entries);
}

export async function stagePosts(db: Archive, posts: Capture[]) {
  const tx = db.transaction(['sources', 'drafts', 'localCaptures', 'heldEvents', 'outbox', 'meta', 'xMatches'], 'readwrite');
  for (const post of posts) {
    const key = 'x:' + post.id;
    const id = await tx.objectStore('sources').get(key);
    if (id && post.visibility === 'private' && !await tx.objectStore('xMatches').getKey(key)) {
      await holdCapture(tx, id, key);
    } else if (id && !(await tx.objectStore('heldEvents').getKey(id))) continue;
    if (post.visibility === 'public') {
      await tx.objectStore('localCaptures').delete(key);
      await tx.objectStore('drafts').put(post, key);
    } else {
      await tx.objectStore('drafts').delete(key);
      await tx.objectStore('localCaptures').put(post, key);
    }
  }
  await tx.done;
}

/**
 * Which of these posts are in the backup: signed, waiting to be signed, or kept on this device.
 * A signed post comes with its event, unless that event is held back from relays.
 */
export async function savedPosts(db: Archive, network: string, ids: string[]) {
  const tx = db.transaction(['sources', 'drafts', 'localCaptures', 'heldEvents']);
  const found: { id: string; event?: string }[] = [];
  for (const id of ids) {
    const key = network + ':' + id;
    const event = await tx.objectStore('sources').get(key);
    if (event) found.push((await tx.objectStore('heldEvents').getKey(event)) ? { id } : { id, event });
    else if ((await tx.objectStore('drafts').getKey(key)) ?? (await tx.objectStore('localCaptures').getKey(key))) found.push({ id });
  }
  return found;
}

// Preserve the original signed event locally and stop queued deliveries,
// including an index pointer whose snapshot could contain the restricted post.
async function holdCapture(
  tx: IDBPTransaction<ArchiveSchema, ArrayLike<StoreNames<ArchiveSchema>>, 'readwrite'>,
  id: string, source: string,
) {
  await tx.objectStore('heldEvents').put(source, id);
  await tx.objectStore('outbox').delete(IDBKeyRange.bound([id], [id, []]));
  const meta = tx.objectStore('meta');
  const pointer = await meta.get('indexPointer') as IndexPointer | undefined;
  if (pointer?.pending.length) await meta.put({ ...pointer, pending: [] }, 'indexPointer');
}

export async function saveSocialCaptures(db: Archive, posts: SocialCapture[]) {
  const tx = db.transaction(['localCaptures', 'mediaRefs', 'sources', 'drafts', 'heldEvents', 'outbox', 'meta'], 'readwrite');
  for (const post of posts) {
    const key = post.source + ':' + post.id;
    const previous = await tx.objectStore('localCaptures').get(key);
    const eventId = await tx.objectStore('sources').get(key);
    if (eventId && post.visibility === 'private') {
      await holdCapture(tx, eventId, key);
    } else if ((previous?.visibility === 'public' && post.visibility === 'unknown') ||
        (eventId && !await tx.objectStore('heldEvents').getKey(eventId))) continue;
    await tx.objectStore('localCaptures').put(post, key);
    if (post.visibility === 'public') await tx.objectStore('drafts').put(post, key);
    else await tx.objectStore('drafts').delete(key);
    for (const url of new Set([...(post.media ?? []), ...(post.posters ?? [])])) {
      const refs = tx.objectStore('mediaRefs');
      if (!await refs.getKey([key, url])) await refs.put({
        eventId: key, url, servers: [], fallbacks: [], invalidHash: false,
        poster: !!post.posters?.includes(url), status: 'pending',
      });
    }
  }
  await tx.done;
}

export async function inventory(db: Archive, since: number, until: number, kinds?: number[]) {
  const tx = db.transaction(['events', 'heldEvents']);
  const index = tx.objectStore('events').index('created_at');
  const range = IDBKeyRange.bound(since, until);
  const records = [];
  for (let cursor = await index.openKeyCursor(range); cursor; cursor = await cursor.continue()) {
    if (await tx.objectStore('heldEvents').getKey(cursor.primaryKey)) continue;
    if (kinds) {
      const event = await tx.objectStore('events').get(cursor.primaryKey);
      if (!event || !kinds.includes(event.kind)) continue;
    }
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
  const tx = db.transaction(['events', 'outbox', 'cursors', 'heldEvents'], 'readwrite');
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
    if (await tx.objectStore('heldEvents').getKey(cursor.value.id)) continue;
    await enqueueRelayPublication(
      cursor.value,
      relays,
      (row) => outbox.put(row, [row.id, row.relay]),
      { broadcast: true },
    );
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
    'xMatches',
    'localCaptures',
  ]);

  const [events, root, keys, data, drafts, pending, sources, ids, mediaFiles, references, matches, captures] =
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
      tx.objectStore('xMatches').getAll(),
      tx.objectStore('localCaptures').getAll(),
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
    'x-sources.json': json(Object.fromEntries(sources.flatMap((k, i) => k.startsWith('x:') ? [[k, ids[i]]] : []))),
    'social-sources.json': json(Object.fromEntries(sources.flatMap((k, i) => k.startsWith('x:') ? [] : [[k, ids[i]]]))),
    'profile-captures.json': json(captures),
    'matched-x-posts.json': json(matches),
    'unsigned-x-posts.json': json(drafts.filter(post => !('source' in post))),
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
