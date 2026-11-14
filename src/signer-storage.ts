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

const names: Record<number, string> = {
  [-1]: 'login', 1: 'posts', 6: 'reposts', 7: 'reactions', 16: 'reposts', 1111: 'comments', 9734: 'zap requests',
  22242: 'relay sign-ins', 24242: 'media uploads', 27235: 'website sign-ins', 30023: 'articles', 30078: 'app data',
};
/**
 * The name of a kind a website may be always allowed or declined. Kinds that replace or delete what
 * you have, such as your profile, follow list, deletions and replaceable lists, always ask.
 */
export const permissionLabel = (kind: number) =>
  kind < -1 || kind === 0 || kind === 3 || kind === 5 || (kind >= 10000 && kind < 20000)
    ? undefined
    : names[kind] ?? 'kind ' + kind + ' events';

/** A remembered choice for this website and kind: true allows, false declines, undefined asks. */
export async function permissionDecision(owner: string, origin: string, kind: number) {
  if (!permissionLabel(kind)) return;
  const db = await open();
  try { return await db.get('permissions', [owner, origin, kind]); } finally { db.close(); }
}
export const hasPermission = async (owner: string, origin: string, kind: number) =>
  (await permissionDecision(owner, origin, kind)) === true;

export async function savePermission(owner: string, origin: string, kind: number, allow = true) {
  if (!permissionLabel(kind)) throw Error('This request needs individual approval.');
  const db = await open();
  try { await db.put('permissions', allow, [owner, origin, kind]); } finally { db.close(); }
}

export async function permissions(owner: string) {
  const db = await open();
  try {
    const range = IDBKeyRange.bound([owner], [owner, []]);
    const [keys, values] = await Promise.all([db.getAllKeys('permissions', range), db.getAll('permissions', range)]);
    return keys.map(([, origin, kind], i) => ({ origin, kind, allow: values[i] !== false, label: permissionLabel(kind) ?? 'kind ' + kind }));
  } finally { db.close(); }
}

export async function forgetPermissions(owner: string, origin?: string) {
  const db = await open();
  try {
    const prefix = origin ? [owner, origin] : [owner];
    await db.delete('permissions', IDBKeyRange.bound(prefix, [...prefix, []]));
  } finally { db.close(); }
}
