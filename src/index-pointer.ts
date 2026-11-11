import type { Archive, Settings, IndexPointer, Sign } from './types.ts';
import type { CID } from '@hashtree/core';
import type { Event } from 'nostr-tools/pure';
import { readPointer, readRoot } from './archive.ts';
import { readOnlyStore } from './blocks.ts';
import { BlossomStore, HashTree, toHex } from '@hashtree/core';
import { createNostrRefResolver } from '@hashtree/nostr';
import * as nip19 from 'nostr-tools/nip19';
import { normalizeServerTag } from 'nostr-tools/nipb7';

type IndexSettings = Pick<Settings, 'pubkey' | 'relays' | 'blossomServer'>;
export const indexName = (pubkey: string) => nip19.npubEncode(pubkey) + '/my-events';

async function signIndexRoot(
  conf: IndexSettings,
  root: CID,
  previous: IndexPointer | undefined,
  sign: Sign,
) {
  let event: Event | undefined;
  const resolver = createNostrRefResolver({
    nip19,
    getPubkey: () => conf.pubkey,
    subscribe(_filter, receive) {
      if (previous) receive(previous.event);
      return () => {};
    },
    async publish(template) {
      event = await sign({
        ...template,
        created_at: template.created_at ?? Math.floor(Date.now() / 1000),
        tags: [...template.tags, ['server', conf.blossomServer!]],
      });
      return true;
    },
  });
  // Let the resolver see the last signed root after a worker restart. It assigns
  // the next replaceable timestamp and constructs the public root's protocol tags.
  const unsubscribe = resolver.list!(nip19.npubEncode(conf.pubkey), () => {});
  try {
    const result = await resolver.publish!(indexName(conf.pubkey), root, { visibility: 'public' });
    if (!result.success || !event) throw Error('Could not sign the public index pointer.');
    return event;
  } finally {
    unsubscribe();
  }
}

// Push exactly the immutable snapshot captured at the start of the operation.
export async function queueIndexPointer(
  db: Archive,
  conf: IndexSettings,
  sign: Sign,
  checkActive: () => Promise<unknown>,
  signal?: AbortSignal,
) {
  const server = conf.blossomServer;
  if (!server || !conf.relays.length)
    throw Error('Save a Blossom server and at least one relay first.');
  const root = await readRoot(db);
  if (!root) throw Error('The event index is empty.');
  const tree = new HashTree({
    store: readOnlyStore(async (hash) => {
      signal?.throwIfAborted();
      const bytes = await db.get('blocks', toHex(hash));
      if (!bytes) throw Error('The local index is missing block ' + toHex(hash) + '.');
      return bytes;
    }),
  });
  const blossom = new BlossomStore({
    servers: [{ url: server, write: true }],
    signer: async (template) =>
      sign({
        ...template,
        created_at: template.created_at ?? Math.floor(Date.now() / 1000),
        tags: [...template.tags, ['server', normalizeServerTag(server)]],
      }),
  });
  // An authorized PUT may already be on the wire. Stop waiting on logout, and
  // let the library drain those requests without retaining the archive handle.
  signal?.throwIfAborted();
  let cancel!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    cancel = () => reject(signal?.reason);
    signal?.addEventListener('abort', cancel, { once: true });
  });
  let result;
  try {
    result = await Promise.race([tree.push(root, blossom, { signal }), stopped]);
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
  signal?.throwIfAborted();
  if (result.failed) throw result.errors[0].error;
  if (result.cancelled) throw Error('Index upload cancelled.');
  await checkActive();
  const previous = await readPointer(db);
  const hash = toHex(root.hash);
  const same = previous?.hash === hash && previous.server === server;
  const event = same ? previous.event : await signIndexRoot(conf, root, previous, sign);
  await checkActive();
  await db.put(
    'meta',
    {
      hash,
      server,
      event,
      pending: [...conf.relays],
      acknowledged: same ? previous.acknowledged.filter((url) => !conf.relays.includes(url)) : [],
    },
    'indexPointer',
  );
}

export async function deliverIndexPointer(
  db: Archive,
  relay: string,
  publish: (relay: string, event: Event) => Promise<unknown>,
) {
  const pointer = await readPointer(db);
  if (!pointer?.pending.includes(relay)) return;
  await publish(relay, pointer.event);
  const tx = db.transaction('meta', 'readwrite');
  const current = (await tx.store.get('indexPointer')) as IndexPointer | undefined;
  if (current?.event.id === pointer.event.id) {
    current.pending = current.pending.filter((url) => url !== relay);
    if (!current.acknowledged.includes(relay)) current.acknowledged.push(relay);
    await tx.store.put(current, 'indexPointer');
  }
  await tx.done;
  return 'Index pointer acknowledged';
}
