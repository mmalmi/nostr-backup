import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { LocalData } from './platform.d.ts';

interface AccountDB extends DBSchema {
  records: { key: string; value: LocalData[keyof LocalData] | true };
}

// Content scripts can write browser.storage.local on some browsers. Only
// trusted extension contexts share the origin of this settings database.
let opening: Promise<IDBPDatabase<AccountDB>> | undefined;
async function accounts() {
  return opening ??= initialize().catch(error => { opening = undefined; throw error; });
}

async function initialize() {
  const db = await openDB<AccountDB>('nostr-backup-accounts', 1, {
    upgrade(db) { db.createObjectStore('records'); },
  });
  try {
    if (!await db.getKey('records', 'migrated')) {
      const local = (globalThis.browser ?? chrome).storage.local;
      const previous = await local.get(null);
      const keys = (Object.keys(previous) as (keyof LocalData)[]).filter(key =>
        ['settings', 'lastRun', 'deletingAccount'].includes(key) || /^account:[0-9a-f]{64}$/.test(key));
      const tx = db.transaction('records', 'readwrite');
      if (!await tx.store.getKey('migrated')) {
        for (const key of keys) await tx.store.put(previous[key], key);
        await tx.store.put(true, 'migrated');
      }
      await tx.done;
      for (const key of keys) await local.remove(key);
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export async function accountRecord<K extends keyof LocalData>(key: K): Promise<LocalData[K]> {
  return (await accounts()).get('records', key) as Promise<LocalData[K]>;
}

export async function writeAccountRecords(records: Partial<LocalData>) {
  const tx = (await accounts()).transaction('records', 'readwrite');
  for (const [key, value] of Object.entries(records)) {
    if (value === undefined) await tx.store.delete(key);
    else await tx.store.put(value, key);
  }
  await tx.done;
  if ('settings' in records)
    await (globalThis.browser ?? chrome).storage.local.set({ settingsChanged: crypto.randomUUID() });
}
