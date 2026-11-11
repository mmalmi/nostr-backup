import type { Archive } from './types.ts';
import type { CID } from '@hashtree/core';
import { readOnlyStore } from './blocks.ts';
import { NostrEventStore } from '@hashtree/nostr';
import { openMediaBlocks } from './media-files.ts';
import { hex } from './model.ts';

export interface KindStats {
  kind: number;
  bytes: number;
  events: { id: string; createdAt: number; bytes: number }[];
}

export async function storageStats(db: Archive) {
  const tx = db.transaction(['events', 'blocks', 'meta', 'mediaFiles', 'drafts', 'outbox']);
  const [root, retained, files, drafts, pending] = await Promise.all([
    tx.objectStore('meta').get('root') as Promise<CID | undefined>,
    tx.objectStore('events').count(),
    tx.objectStore('mediaFiles').getAll(),
    tx.objectStore('drafts').count(),
    tx.objectStore('outbox').count(),
  ]);
  let blockBytes = 0,
    blocks = 0;
  for (let c = await tx.objectStore('blocks').openCursor(); c; c = await c.continue()) {
    blocks++;
    blockBytes += c.value.byteLength;
  }
  const kinds = new Map<number, KindStats>();
  const index = new NostrEventStore(
    readOnlyStore(async (hash) => (await db.get('blocks', hex(hash))) ?? null),
  );
  if (root) {
    for await (const event of index.streamQuery(root, {}, { strict: true })) {
      const row = kinds.get(event.kind) ?? { kind: event.kind, events: [], bytes: 0 };
      const bytes = index.encodeEvent(event).byteLength;
      row.events.push({ id: event.id, createdAt: event.created_at, bytes });
      row.bytes += bytes;
      kinds.set(event.kind, row);
    }
  }
  const media = openMediaBlocks(db);
  try {
    return {
      retained,
      blocks,
      blockBytes,
      drafts,
      pending,
      mediaFiles: files.length,
      mediaBytes: files.reduce((sum, file) => sum + file.size, 0),
      mediaBlockBytes: await media.totalBytes(),
      kinds: [...kinds.values()].sort((a, b) => a.kind - b.kind),
    };
  } finally {
    media.close();
  }
}
