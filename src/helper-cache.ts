import { openDB, type DBSchema } from 'idb';

interface CacheSchema extends DBSchema {
  blocks: { key: string; value: { hash: string; bytes: Uint8Array; saved: number }; indexes: { saved: number } };
  meta: { key: string; value: number };
}

// Browsing must never add page-selected files to an account's backup or upload queue.
export function imageCache(name = 'nostr-backup-browser-cache', limit = 64 * 1048576) {
  let opened: ReturnType<typeof openDB<CacheSchema>> | undefined;
  const open = () => opened ??= openDB<CacheSchema>(name, 1, {
    upgrade(db) {
      db.createObjectStore('blocks', { keyPath: 'hash' }).createIndex('saved', 'saved');
      db.createObjectStore('meta');
    },
  }).catch(error => { opened = undefined; throw error; });
  return {
    async get(hash: string) {
      return (await (await open()).get('blocks', hash))?.bytes;
    },
    async put(hash: string, bytes: Uint8Array) {
      if (!bytes.length || bytes.length > limit) return;
      const tx = (await open()).transaction(['blocks', 'meta'], 'readwrite');
      const blocks = tx.objectStore('blocks'), meta = tx.objectStore('meta');
      if (await blocks.getKey(hash)) return tx.done;
      // Charge row overhead as well as payload so tiny blocks can't exhaust the database.
      const cost = bytes.length + 256;
      let total = (await meta.get('bytes') ?? 0) + cost;
      if (cost > limit) return tx.done;
      if (total > limit) {
        for (let c = await blocks.index('saved').openCursor(); c && total > limit; c = await c.continue()) {
          total -= c.value.bytes.length + 256;
          await c.delete();
        }
      }
      await blocks.add({ hash, bytes, saved: Date.now() });
      await meta.put(total, 'bytes');
      await tx.done;
    },
  };
}
