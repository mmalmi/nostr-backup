import type { Event } from 'nostr-tools/pure';
import type { IDBPTransaction, StoreNames } from 'idb';
import type { Archive, ArchiveSchema, Delivery } from './types.ts';

export type HistoryKind = 0 | 3;
export const isHistoryKind = (kind: number): kind is HistoryKind => kind === 0 || kind === 3;
const previousLimit = { 0: 10, 3: 3 };
export const HISTORY_BYTE_LIMIT = 2 * 1024 * 1024;

export interface HistoryRow {
  id: string;
  pubkey: string;
  kind: HistoryKind;
  created_at: number;
  bytes: number;
}

type HistoryTransaction = IDBPTransaction<ArchiveSchema, ArrayLike<StoreNames<ArchiveSchema>>, 'readwrite' | 'versionchange'>;
const newestFirst = (a: HistoryRow, b: HistoryRow) => b.created_at - a.created_at || a.id.localeCompare(b.id);
const encoder = new TextEncoder();

export function historyRow(event: Event): HistoryRow | undefined {
  if (!isHistoryKind(event.kind)) return;
  return { id: event.id, pubkey: event.pubkey, kind: event.kind, created_at: event.created_at,
    bytes: encoder.encode(JSON.stringify(event)).length };
}

// Only the current edition of each list/profile belongs in a newly shared snapshot.
export function currentHistoryIds(rows: HistoryRow[]) {
  const newest = new Map<number, HistoryRow>();
  for (const row of rows) {
    const previous = newest.get(row.kind);
    if (!previous || newestFirst(row, previous) < 0) newest.set(row.kind, row);
  }
  return new Set([...newest.values()].map(row => row.id));
}

export async function readEventHistory(db: Archive, pubkey: string, kind: HistoryKind): Promise<Event[]> {
  const tx = db.transaction(['eventHistory', 'events']);
  const rows = await tx.objectStore('eventHistory').index('pubkey').getAll(pubkey);
  const order = rows.filter(row => row.kind === kind).sort(newestFirst);
  const events = await Promise.all(order.map(row => tx.objectStore('events').get(row.id)));
  return events.filter((event): event is Event => !!event && event.pubkey === pubkey && event.kind === kind);
}

// Replace only a delivery explicitly addressed to this same relay for this author and kind.
export async function queueHistoryDelivery(tx: HistoryTransaction, event: Event, row: Delivery) {
  const outbox = tx.objectStore('outbox');
  const slot: [string, number, string] = [event.pubkey, event.kind, row.relay];
  const prior = await outbox.index('historySlot').get(slot);
  if (prior && prior.id !== event.id) {
    const time = prior.created_at!;
    if (time > event.created_at || (time === event.created_at && prior.id < event.id)) return false;
    await outbox.delete([prior.id, row.relay]);
    if (await tx.objectStore('meta').get(['expiredHistory', prior.id])) await discardHistoryBody(tx, prior.id);
  }
  await outbox.put({...row, historySlot: slot, created_at: event.created_at}, [row.id, row.relay]);
  return true;
}

// A queued publication owns its original signed payload until its last relay acknowledges it.
export async function discardHistoryBody(tx: HistoryTransaction, id: string) {
  if (await tx.objectStore('outbox').getKey(IDBKeyRange.bound([id], [id, []]))) {
    await tx.objectStore('meta').put(true, ['expiredHistory', id]);
    return;
  }
  await Promise.all([
    tx.objectStore('events').delete(id),
    tx.objectStore('heldEvents').delete(id),
    tx.objectStore('meta').delete(['expiredHistory', id]),
    tx.objectStore('mediaRefs').delete(IDBKeyRange.bound([id], [id, []])),
  ]);
}

export async function pruneEventHistory(tx: HistoryTransaction, pubkey: string) {
  const versions = tx.objectStore('eventHistory');
  const rows = (await versions.index('pubkey').getAll(pubkey)).sort(newestFirst);
  const kept = { 0: 0, 3: 0 };
  let remaining = HISTORY_BYTE_LIMIT;
  let droppedBytes = 0;
  for (const row of rows) {
    if (!kept[row.kind]) {
      kept[row.kind]++;
    } else if (kept[row.kind] <= previousLimit[row.kind] && row.bytes <= remaining) {
      kept[row.kind]++;
      remaining -= row.bytes;
    } else {
      droppedBytes += row.bytes;
      await versions.delete(row.id);
      await discardHistoryBody(tx, row.id);
    }
  }
  return droppedBytes;
}
