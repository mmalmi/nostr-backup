import { openDB } from 'idb';
import { NostrEventStore } from '@hashtree/nostr';
import { zipSync, strToU8 } from 'fflate';
import { hex, isOwnPost } from './model.js';

export function openArchive(name = 'nostr-backup-v1') {
  return openDB(name, 1, {
    upgrade(db) {
      for (const store of ['blocks', 'meta', 'events', 'drafts', 'sources', 'outbox', 'cursors'])
        db.createObjectStore(store);
    },
  });
}

// Only the background writes tree roots. Stage immutable blocks, then commit the
// root, records, and delivery state together. A stopped worker leaves the old root valid.
export async function append(db, entries, pubkey) {
  const fresh = new Map(),
    blocks = new Map();
  for (const { event } of entries) {
    if (!isOwnPost(event, pubkey)) throw Error('Invalid event signature, author or post kind.');
    if (!fresh.has(event.id) && !(await db.getKey('events', event.id))) fresh.set(event.id, event);
  }
  const store = {
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
  const oldRoot = await db.get('meta', 'root');
  const root = fresh.size
    ? await new NostrEventStore(store).build(oldRoot ?? null, [...fresh.values()])
    : oldRoot;
  const tx = db.transaction(
    ['blocks', 'meta', 'events', 'sources', 'drafts', 'outbox'],
    'readwrite',
  );
  const s = (name) => tx.objectStore(name);
  for (const [key, bytes] of blocks) s('blocks').put(bytes, key);
  if (root) s('meta').put(root, 'root');
  for (const [id, event] of fresh) s('events').put(JSON.parse(JSON.stringify(event)), id);
  for (const { event, source, targets } of entries) {
    if (!source) continue;
    s('sources').put(event.id, source);
    s('drafts').delete(source);
    for (const relay of targets) s('outbox').put({ id: event.id, relay }, [event.id, relay]);
  }
  await tx.done;
  return fresh.size;
}

export async function stagePosts(db, posts) {
  const tx = db.transaction(['sources', 'drafts'], 'readwrite');
  for (const post of posts) {
    const key = 'x:' + post.id;
    if (!(await tx.objectStore('sources').getKey(key)))
      await tx.objectStore('drafts').put(post, key);
  }
  await tx.done;
}

export async function dump(db, pubkey) {
  const tx = db.transaction(['blocks', 'events', 'meta', 'drafts', 'outbox', 'sources']);
  const s = (name) => tx.objectStore(name);
  const [events, root, keys, data, drafts, pending, sources, ids] = await Promise.all([
    s('events').getAll(),
    s('meta').get('root'),
    s('blocks').getAllKeys(),
    s('blocks').getAll(),
    s('drafts').getAll(),
    s('outbox').getAll(),
    s('sources').getAllKeys(),
    s('sources').getAll(),
  ]);
  const cid = root && { hash: hex(root.hash), ...(root.key ? { key: hex(root.key) } : {}) };
  const json = (v) => strToU8(JSON.stringify(v, null, 2));
  const files = {
    'manifest.json': json({
      version: 1,
      pubkey,
      events: events.length,
      root: cid ?? null,
      exportedAt: new Date().toISOString(),
    }),
    'events.jsonl': strToU8(events.map((e) => JSON.stringify(e) + '\n').join('')),
    'x-sources.json': json(Object.fromEntries(sources.map((k, i) => [k, ids[i]]))),
    'unsigned-x-posts.json': json(drafts),
    'pending-deliveries.json': json(pending),
  };
  keys.forEach((key, i) => {
    files['blocks/' + key] = data[i];
  });
  return zipSync(files, { level: 1 });
}
