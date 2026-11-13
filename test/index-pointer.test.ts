import { readOnlyStore } from '../src/blocks.ts';
import type { EventTemplate } from 'nostr-tools/pure';
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { createNostrRefResolver, parseHashtreeRootEvent, NostrEventStore } from '@hashtree/nostr';
import * as nip19 from 'nostr-tools/nip19';
import { sha256 } from '@hashtree/core';
import { hex } from '../src/model.ts';
import { append, openArchive, readPointer } from '../src/archive.ts';
import { queueIndexPointer, deliverIndexPointer } from '../src/index-pointer.ts';
import { storageStats } from '../src/storage-stats.ts';

test('published my-events can be queried from Blossom alone and retain independent relay receipts', async (t) => {
  const db = await openArchive(crypto.randomUUID());
  const key = generateSecretKey(),
    pubkey = getPublicKey(key),
    sign = (data: EventTemplate) => finalizeEvent(data, key);
  const event = (kind: number, content: string, time: number) =>
    sign({ kind, content, created_at: time, tags: [] });
  const profile = event(0, '{"name":"新版"}', 2),
    note = event(1, 'héllö', 3);
  await append(
    db,
    [{ event: event(0, '{"name":"old"}', 1) }, { event: profile }, { event: note }],
    pubkey,
  );
  const conf = {
    pubkey,
    relays: ['wss://a/', 'wss://b/'],
    blossomServer: 'https://mirror.example',
  };
  const remote = new Map<string, Uint8Array>(),
    tree = new NostrEventStore(readOnlyStore(async (hash) => remote.get(hex(hash)) ?? null));
  let failNext = true;
  const fetcher: typeof fetch = async (url, init) => {
    if (init?.method === 'HEAD')
      return new Response(null, {
        status: remote.has(new URL(String(url)).pathname.slice(1)) ? 200 : 404,
      });
    if (failNext) {
      failNext = false;
      return new Response(null, { status: 500 });
    }
    assert.ok(init?.body instanceof Blob);
    const bytes = new Uint8Array(await init.body.arrayBuffer());
    const hash = hex(await sha256(bytes));
    const token = JSON.parse(atob(new Headers(init.headers).get('Authorization')!.slice(6)));
    assert.ok(verifyEvent(token));
    assert.ok(token.tags.some((t) => t[0] === 'x' && t[1] === hash));
    assert.ok(token.tags.some((t) => t[0] === 'server' && t[1] === 'mirror.example'));
    remote.set(hash, bytes);
    return Response.json({
      sha256: hash,
      size: bytes.length,
      url: conf.blossomServer + '/' + hash,
    });
  };
  t.mock.method(globalThis, 'fetch', fetcher);
  await assert.rejects(
    queueIndexPointer(db, conf, sign, async () => {}),
    /500/,
  );
  assert.equal(await readPointer(db), undefined);
  await queueIndexPointer(db, conf, sign, async () => {});
  const pointer = await readPointer(db);
  assert.ok(pointer);
  assert.ok(verifyEvent(pointer.event));
  const parsed = parseHashtreeRootEvent(pointer.event);
  assert.ok(parsed?.rootCid);
  assert.equal(parsed.treeName, 'my-events');
  assert.equal(parsed.visibility, 'public');
  const reader = createNostrRefResolver({
    nip19,
    getPubkey: () => null,
    publish: async () => false,
    subscribe(filter, receive) {
      assert.deepEqual(filter.authors, [pubkey]);
      assert.ok(filter.kinds?.includes(pointer.event.kind));
      assert.deepEqual(filter['#d'], ['my-events']);
      receive(pointer.event);
      return () => {};
    },
  });
  const resolved = await reader.resolve(nip19.npubEncode(pubkey) + '/my-events');
  assert.deepEqual(resolved, parsed.rootCid);
  reader.stop?.();
  assert.equal((await tree.getById(parsed.rootCid, note.id))?.content, note.content);
  assert.equal((await tree.getById(parsed.rootCid, profile.id))?.id, profile.id);
  const stats = await storageStats(db);
  assert.equal(stats.retained, 3);
  assert.deepEqual(
    stats.kinds.map((row) => [row.kind, row.events.length, row.bytes]),
    [
      [0, 1, tree.encodeEvent(profile).length],
      [1, 1, tree.encodeEvent(note).length],
    ],
  );
  await assert.rejects(
    deliverIndexPointer(db, conf.relays[0], async () => {
      throw Error('relay offline');
    }),
    /relay offline/,
  );
  assert.deepEqual((await readPointer(db))?.pending, conf.relays);
  await Promise.all(
    conf.relays.map((relay) =>
      deliverIndexPointer(db, relay, async (_, e) => assert.equal(e.id, pointer.event.id)),
    ),
  );
  assert.deepEqual(new Set((await readPointer(db))?.acknowledged), new Set(conf.relays));
  const next = event(1, 'next', 4);
  const held = event(1, 'Unverified legacy X post', 5);
  await append(db, [{ event: next }, { event: held }], pubkey);
  await db.put('heldEvents', 'x:42', held.id);
  await queueIndexPointer(db, conf, sign, async () => {});
  const updated = await readPointer(db);
  assert.ok(updated);
  assert.ok(updated.event.created_at > pointer.event.created_at);
  assert.notEqual(updated.hash, pointer.hash);
  const nextRoot = parseHashtreeRootEvent(updated.event)?.rootCid;
  assert.ok(nextRoot);
  assert.equal((await tree.getById(nextRoot, next.id))?.id, next.id);
  assert.equal(await tree.getById(nextRoot, held.id), null);
  assert.notEqual(updated.localHash, updated.hash);
  db.close();
});
