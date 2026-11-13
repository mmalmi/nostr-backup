import type { IDBPTransaction, StoreNames } from 'idb';
import type { Archive, ArchiveSchema, IndexPointer, MediaReference } from './types.ts';

// Older archives recorded the source ID but did not distinguish public X
// captures from protected ones. Keep their signed originals in the local ZIP.
export async function markLegacyX(
  tx: IDBPTransaction<ArchiveSchema, ArrayLike<StoreNames<ArchiveSchema>>, 'versionchange'>,
) {
  const range = IDBKeyRange.bound('x:', 'x;', false, true);
  const held = new Set<string>();
  for (let c = await tx.objectStore('sources').openCursor(range); c; c = await c.continue()) {
    // A match references an independently signed, existing Nostr note.
    if (await tx.objectStore('xMatches').getKey(c.key)) continue;
    held.add(c.value);
    await tx.objectStore('heldEvents').put(c.key, c.value);
  }
  if (!held.size) return;
  for (let c = await tx.objectStore('outbox').openCursor(); c; c = await c.continue()) {
    if (held.has(c.value.id)) await c.delete();
  }
  const meta = tx.objectStore('meta');
  const pointer = await meta.get('indexPointer') as IndexPointer | undefined;
  if (pointer?.pending.length) await meta.put({ ...pointer, pending: [] }, 'indexPointer');
}

// A blob may appear in both a private backup and a public post. Only an
// archived, shareable signed event can make a referenced blob uploadable.
export async function shareableMediaHashes(db: Archive, references?: MediaReference[]) {
  const refs = references ?? await db.getAll('mediaRefs');
  const ids = new Set(refs.filter(ref => ref.sha256 && /^[a-f0-9]{64}$/.test(ref.eventId))
    .map(ref => ref.eventId));
  const tx = db.transaction(['heldEvents', 'events']);
  const allowed = new Set<string>();
  for (const id of ids) {
    if (!(await tx.objectStore('heldEvents').getKey(id)) && await tx.objectStore('events').getKey(id))
      allowed.add(id);
  }
  return new Set(refs.filter(ref => ref.sha256 && allowed.has(ref.eventId)).map(ref => ref.sha256!));
}
