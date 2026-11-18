import { parseHashtreeRootEvent } from '@hashtree/nostr';
import type { Archive, IndexPointer } from './types.ts';
import { HashTree, toHex, type CID, type Store } from '@hashtree/core';

// HashTree readers accept the full Store interface, including mutation methods.
export function readOnlyStore(get: Store['get']): Store {
  const rejectWrite = async (): Promise<never> => {
    throw Error('This block store is read-only.');
  };
  return { get, has: async (hash) => !!(await get(hash)), put: rejectWrite, delete: rejectWrite };
}

export const readRoot = (db: Archive) => db.get('meta', 'root') as Promise<CID | undefined>;

const indexLock = (db: Archive) => 'social-backup-index:' + db.name;

// Readers can finish using an old immutable root while new writes advance the current root.
export async function withIndexSnapshot<T>(db: Archive, task: () => Promise<T>): Promise<T> {
  return await navigator.locks.request(indexLock(db), { mode: 'shared' }, task);
}

// Indexing many follow tags creates intermediate immutable trees inside one build.
// Only the final root is committed. A pre-existing subtree already owns all of its children.
export async function reachableNewBlocks(root: CID, staged: Map<string, Uint8Array>) {
  const tree = new HashTree({ store: readOnlyStore(async hash => staged.get(toHex(hash)) ?? null) });
  const retained = new Map<string, Uint8Array>();
  const pending = [root];
  while (pending.length) {
    const cid = pending.pop()!;
    const hash = toHex(cid.hash);
    const bytes = staged.get(hash);
    if (!bytes || retained.has(hash)) continue;
    retained.set(hash, bytes);
    const node = await tree.getTreeNode(cid);
    if (node) pending.push(...node.links);
  }
  return retained;
}

export const INDEX_SWEEP_BYTES = 512 * 1024;

// Only this archive's event index uses the blocks store. Signed originals and media live
// separately. The manifest in the ZIP names the current root; uploaded roots live on their server.
export async function compactHistoryIndex(db: Archive) {
  if (await db.get('meta', 'compactHistoryIndex') !== true) return;
  // A housekeeping failure must not turn an already committed publication into a failed save.
  await navigator.locks.request(indexLock(db), { ifAvailable: true }, async lock => {
    if (!lock || await db.get('meta', 'compactHistoryIndex') !== true) return;
    const root = await readRoot(db);
    if (!root) return;
    const tree = new HashTree({ store: readOnlyStore(async hash => (await db.get('blocks', toHex(hash))) ?? null) });
    const live = new Set<string>();
    const pointer = await db.get('meta', 'indexPointer') as IndexPointer | undefined;
    const published = pointer && parseHashtreeRootEvent(pointer.event)?.rootCid;
    const roots = [root];
    if (published && toHex(published.hash) !== toHex(root.hash) && await db.getKey('blocks', toHex(published.hash))) {
      roots.push(published);
    }
    for (const retained of roots) {
      for await (const { hash } of tree.walkBlocks(retained)) live.add(toHex(hash));
    }
    // walkBlocks throws on incomplete snapshots before any block is removed.
    const tx = db.transaction(['blocks', 'meta'], 'readwrite');
    for (let key = await tx.objectStore('blocks').openKeyCursor(); key; key = await key.continue()) {
      if (!live.has(key.primaryKey)) await tx.objectStore('blocks').delete(key.primaryKey);
    }
    await tx.objectStore('meta').delete('compactHistoryIndex');
    await tx.objectStore('meta').delete('historyIndexGrowth');
    await tx.done;
  }).catch(error => console.warn('Archive index compaction will retry.', error));
}
