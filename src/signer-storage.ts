import { openDB, type DBSchema } from 'idb';

interface SignerDB extends DBSchema {
  keys: { key: string; value: string };
  permissions: { key: [string, string, number]; value: true };
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

export const permissionLabel = (kind: number) => kind === -1 ? 'login' : kind === 1 ? 'posts' : kind === 7 ? 'reactions' : undefined;
export async function hasPermission(owner: string, origin: string, kind: number) {
  if (!permissionLabel(kind)) return false;
  const db = await open();
  try { return !!await db.get('permissions', [owner, origin, kind]); } finally { db.close(); }
}

export async function savePermission(owner: string, origin: string, kind: number) {
  if (!permissionLabel(kind)) throw Error('This request needs individual approval.');
  const db = await open();
  try { await db.put('permissions', true, [owner, origin, kind]); } finally { db.close(); }
}

export async function permissions(owner: string) {
  const db = await open();
  try {
    const keys = await db.getAllKeys('permissions', IDBKeyRange.bound([owner], [owner, []]));
    return keys.map(([, origin, kind]) => ({ origin, kind }));
  } finally { db.close(); }
}

export async function forgetPermissions(owner: string, origin?: string) {
  const db = await open();
  try {
    const prefix = origin ? [owner, origin] : [owner];
    await db.delete('permissions', IDBKeyRange.bound(prefix, [...prefix, []]));
  } finally { db.close(); }
}
