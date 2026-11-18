import type { Event } from 'nostr-tools/pure';
import type { CID, Store } from '@hashtree/core';
import { NostrEventStore } from '@hashtree/nostr';
import { HashtreeNostrEventReader } from '@hashtree/nostr-pubsub';
import {
  localIndexRoute,
  localIndexSource,
  NostrPubsubRouter,
  allowWithPriority,
  enqueueRelayPublication,
  verifyNostrEvent,
  SOURCE_PRIORITY_LOCAL_INDEX,
  type EventBus,
  type EventSource,
  type NostrFilter,
  type QueryOptions,
} from 'nostr-pubsub';
import type { Archive, Entry } from './types.ts';
import { compactHistoryIndex, INDEX_SWEEP_BYTES, reachableNewBlocks, readOnlyStore, readRoot, withIndexSnapshot } from './blocks.ts';
import { historyRow, isHistoryKind, pruneEventHistory, queueHistoryDelivery } from './event-history.ts';
import { mediaReferences } from './media-refs.ts';
import { hex, isOwnEvent, PUBLIC_POST_KINDS } from './model.ts';

export const localArchive = localIndexSource('archive');

// Foreground queries and single-event publications have one eligible route.
// The delivery worker consumes that route's committed outbox independently.
export function archiveRouter(db: Archive, owner: string, relays: readonly string[] = []) {
  const bus = new ArchiveEventBus(db, owner, relays);
  const route = localIndexRoute(localArchive.id);
  return new NostrPubsubRouter({
    policy: {
      checkSource: ({ candidate }) => allowWithPriority(candidate.priority),
      checkEvent: () => allowWithPriority(route.priority),
    },
    querySources: [{ route, reader: bus }],
    publishSources: [{ route, publisher: bus }],
  });
}

// Per-account nostr-pubsub backend. All relay delivery belongs to the durable
// outbox. An accepted local publish means the entire archive transaction committed.
export class ArchiveEventBus implements EventBus {
  private readonly db: Archive;
  private readonly owner: string;
  private readonly relays: readonly string[];
  private readonly reader: HashtreeNostrEventReader;

  constructor(db: Archive, owner: string, relays: readonly string[] = []) {
    this.db = db;
    this.owner = owner;
    this.relays = relays;
    this.reader = new HashtreeNostrEventReader({
      store: readOnlyStore(async (hash) => (await db.get('blocks', hex(hash))) ?? null),
      roots: { snapshot: async () => [{ partitionId: owner, root: (await readRoot(db)) ?? null }] },
      source: localArchive,
      priority: SOURCE_PRIORITY_LOCAL_INDEX,
    });
  }

  query(filters: NostrFilter[], options?: QueryOptions) {
    return withIndexSnapshot(this.db, () => this.reader.query(filters, options));
  }

  async publish(event: Event, source: EventSource) {
    await this.publishBatch([{ event }], source);
    return { accepted: true, remoteAccepted: false, priority: SOURCE_PRIORITY_LOCAL_INDEX };
  }

  // Batch extension to EventBus.publish: imports retain historical versions,
  // while local captures commit X source IDs and drafts with the signed events.
  async publishBatch(entries: Entry[], source: EventSource = localArchive) {
    const batch = entries.map((entry) => {
      const event = verifyNostrEvent(entry.event);
      if (!isOwnEvent(event, this.owner))
        throw Error('Invalid archive event or author.');
      return {
        event,
        source: entry.source,
        posters: entry.posters?.slice(),
        targets: source.kind === 'local-index' ? [...(entry.targets ?? this.relays)] : [],
        announce: entry.announce,
      };
    });
    const count = await withIndexSnapshot(this.db, async () => {
      for (;;) {
        const count = await commit(this.db, batch);
        if (count !== undefined) return count;
        // A concurrent publisher advanced the root. Rebuild against its committed snapshot.
      }
    });
    if (batch.some(({ event }) => isHistoryKind(event.kind))) await compactHistoryIndex(this.db);
    return count;
  }
}

async function commit(
  db: Archive,
  entries: (Omit<Entry, 'targets'> & { targets: readonly string[] })[],
) {
  const oldRoot = await readRoot(db);
  const fresh = new Map<string, Event>(),
    blocks = new Map<string, Uint8Array>();
  for (const { event } of entries) {
    if (!fresh.has(event.id) && !(await db.getKey('events', event.id))) fresh.set(event.id, event);
  }
  const store: Store = {
    async delete() {
      throw Error('Index blocks are immutable.');
    },
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
  const root = fresh.size
    ? await new NostrEventStore(store).build(oldRoot ?? null, [...fresh.values()])
    : oldRoot;
  const history = [...fresh.values()].find(event => isHistoryKind(event.kind));
  const committedBlocks = history && root ? await reachableNewBlocks(root, blocks) : blocks;
  const tx = db.transaction(
    ['blocks', 'meta', 'events', 'eventHistory', 'sources', 'drafts', 'outbox', 'mediaRefs', 'mediaFiles', 'heldEvents'],
    'readwrite',
  );

  const current = (await tx.objectStore('meta').get('root')) as CID | undefined;
  if ((current && hex(current.hash)) !== (oldRoot && hex(oldRoot.hash))) {
    await tx.done;
    return;
  }
  for (const [key, bytes] of committedBlocks) tx.objectStore('blocks').put(bytes, key);
  if (root) tx.objectStore('meta').put(root, 'root');
  const announced = new Set(entries.filter((entry) => entry.announce).map((entry) => entry.event.id));
  for (const [id, event] of fresh) {
    tx.objectStore('events').put(JSON.parse(JSON.stringify(event)), id);
    const row = historyRow(event);
    if (row) tx.objectStore('eventHistory').put(row);
    if (!PUBLIC_POST_KINDS.includes(event.kind) && !announced.has(id))
      tx.objectStore('heldEvents').put('local-only kind', id);
  }
  for (const { event, source, targets, posters, announce } of entries) {
    if (fresh.has(event.id)) {
      for (const ref of mediaReferences(event, posters)) {
        if (source && ref.expected && !ref.invalidHash && await tx.objectStore('mediaFiles').getKey(ref.expected)) {
          ref.sha256 = ref.expected;
          ref.status = ref.poster ? 'poster only' : 'saved';
        }
        tx.objectStore('mediaRefs').put(ref);
      }
    }
    if (source) {
      if (await tx.objectStore('heldEvents').get(event.id) === source &&
          (await tx.objectStore('drafts').get(source))?.visibility === 'public')
        await tx.objectStore('heldEvents').delete(event.id);
      tx.objectStore('sources').put(event.id, source);
      tx.objectStore('drafts').delete(source);
    }
    if (!PUBLIC_POST_KINDS.includes(event.kind) && !announce) continue;
    const outbox = tx.objectStore('outbox');
    await enqueueRelayPublication(
      event,
      targets,
      async (row) => {
        const key: [string, string] = [row.id, row.relay];
        if (!(await outbox.getKey(key))) {
          const network = source?.startsWith('instagram:') ? 'instagram' :
            source?.startsWith('facebook:') ? 'facebook' : undefined;
          if (isHistoryKind(event.kind)) await queueHistoryDelivery(tx, event, row);
          else await outbox.put(network ? { ...row, network } : row, key);
        }
      },
      { broadcast: !source },
    );
  }
  if (history) {
    const dropped = await pruneEventHistory(tx, history.pubkey);
    if ((blocks.size && oldRoot) || dropped) {
      const meta = tx.objectStore('meta');
      const allocated = [...committedBlocks.values()].reduce((n, block) => n + block.byteLength, 0);
      const growth = Number(await meta.get('historyIndexGrowth') ?? 0) + allocated + dropped;
      await meta.put(growth, 'historyIndexGrowth');
      if (growth >= INDEX_SWEEP_BYTES) await meta.put(true, 'compactHistoryIndex');
    }
  }
  await tx.done;
  return fresh.size;
}
