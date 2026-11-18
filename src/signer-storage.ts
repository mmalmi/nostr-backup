import { openDB, type DBSchema } from 'idb';

interface SignerDB extends DBSchema {
  keys: { key: string; value: string };
  // true always allows, false always declines.
  permissions: { key: [string, string, number]; value: boolean };
}
const open = () => openDB<SignerDB>('nostr-backup-signer', 1, {
  upgrade(db) {
    db.createObjectStore('keys');
    db.createObjectStore('permissions');
  },
});

export async function savedKey() {
  const db = await open();
  try { return await db.get('keys', 'active'); } finally { db.close(); }
}

export async function saveKey(key?: string) {
  const db = await open();
  try {
    if (key) await db.put('keys', key, 'active');
    else await db.delete('keys', 'active');
  } finally { db.close(); }
}

// Negative keys are outside the event kind range. Keep -1 for existing login rules.
export const LOGIN = -1;
export const ALL_SIGNING = -2;
const names: Record<number, string> = {
  [LOGIN]: 'login', [ALL_SIGNING]: 'all signing requests', 0: 'profile changes', 1: 'posts', 3: 'follow list changes',
  5: 'event deletions', 6: 'reposts', 7: 'reactions', 16: 'reposts', 1111: 'comments', 9734: 'zap requests',
  22242: 'relay sign-ins', 24242: 'media uploads', 27235: 'website sign-ins', 30023: 'articles', 30078: 'app data',
};
export const permissionLabel = (kind: number) => names[kind] ?? 'kind ' + kind + ' events';

/** A remembered choice for this website and kind: true allows, false declines, undefined asks. */
export async function permissionDecision(owner: string, origin: string, kind: number) {
  const db = await open();
  try {
    const store = db.transaction('permissions').store;
    const specific = await store.get([owner, origin, kind]);
    if (specific !== undefined || kind === LOGIN) return specific;
    return await store.get([owner, origin, ALL_SIGNING]);
  } finally { db.close(); }
}

export async function savePermission(owner: string, origin: string, kind: number, allow = true) {
  const db = await open();
  try {
    const tx = db.transaction('permissions', 'readwrite');
    if (kind === ALL_SIGNING) {
      const signingKinds = IDBKeyRange.bound([owner, origin, 0], [owner, origin, 65535]);
      await tx.store.delete(signingKinds);
    }
    await tx.store.put(allow, [owner, origin, kind]);
    await tx.done;
  } finally { db.close(); }
}

export async function permissions(owner: string) {
  const db = await open();
  try {
    const range = IDBKeyRange.bound([owner], [owner, []]);
    const [keys, values] = await Promise.all([db.getAllKeys('permissions', range), db.getAll('permissions', range)]);
    return keys.map(([, origin, kind], i) => ({ origin, kind, allow: values[i] !== false, label: permissionLabel(kind) }));
  } finally { db.close(); }
}

export async function forgetPermissions(owner: string, origin?: string) {
  const db = await open();
  try {
    const prefix = origin ? [owner, origin] : [owner];
    await db.delete('permissions', IDBKeyRange.bound(prefix, [...prefix, []]));
  } finally { db.close(); }
}
