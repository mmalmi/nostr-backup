import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDB } from 'idb';
import { HASHTREE_ROOT_KIND } from '@hashtree/nostr';
import { HashTree, toHex } from '@hashtree/core';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { append, inventory, openArchive, queueBroadcast } from '../src/archive.ts';
import { compactHistoryIndex, readOnlyStore, readRoot, withIndexSnapshot } from '../src/blocks.ts';
import { deliverPending } from '../src/broadcast.ts';
import { HISTORY_BYTE_LIMIT, readEventHistory } from '../src/event-history.ts';
import { ArchiveEventBus } from '../src/archive-event-bus.ts';

const key = generateSecretKey(), pubkey = getPublicKey(key);
function sign(kind: number, created_at: number, content = '{}', tags: string[][] = []) {
  return finalizeEvent({kind, created_at, content, tags}, key);
}

test('history keeps ten profiles and three follow lists besides the current editions, across reopened and concurrent writes', async () => {
  const name = crypto.randomUUID();
  let db = await openArchive(name);
  const note = sign(1, 1, 'keep me');
  const profiles = Array.from({length: 18}, (_, i) => sign(0, i));
  const follows = Array.from({length: 12}, (_, i) => sign(3, i));
  const tie = sign(0, 17, '{"another":true}');
  const events = [...profiles, ...follows, tie, note];
  await Promise.all([
    append(db, events.slice(0, 14).map(event => ({event})), pubkey),
    append(db, events.slice(14).map(event => ({event})), pubkey),
  ]);
  await append(db, [{event: profiles[0]}], pubkey);
  db.close();
  db = await openArchive(name);
  try {
    const history = await readEventHistory(db, pubkey, 0);
    assert.equal(history.length, 11);
    assert.equal(history[0].id, [tie.id, profiles[17].id].sort()[0]);
    assert.equal(history[10].created_at, 8);
    assert.deepEqual((await readEventHistory(db, pubkey, 3)).map(e => e.created_at), [11, 10, 9, 8]);
    assert.deepEqual(await readEventHistory(db, getPublicKey(generateSecretKey()), 0), []);
    assert.equal(await db.count('events'), 16);
    assert.equal(await db.getKey('events', profiles[0].id), undefined);
    assert.equal(await db.getKey('heldEvents', profiles[0].id), undefined);
    assert.equal((await inventory(db, 0, 50))?.some(row => row.id === note.id), true);
  } finally { db.close(); }
});

test('byte budget is shared, never displaces the current edition, and preserves active delivery bodies until the last relay receipt', async () => {
  const db = await openArchive(crypto.randomUUID());
  const urls = ['wss://first.example/', 'wss://second.example/'];
  const old = sign(0, 1, 'a'.repeat(HISTORY_BYTE_LIMIT / 2 + 1));
  const current = sign(0, 3, 'b'.repeat(HISTORY_BYTE_LIMIT + 1));
  const priorList = sign(3, 2, 'c'.repeat(HISTORY_BYTE_LIMIT / 2 + 1));
  const latestList = sign(3, 4);
  try {
    await append(db, [{event: old, targets: urls, announce: true}, {event: current}, {event: priorList}, {event: latestList}], pubkey);
    assert.deepEqual((await readEventHistory(db, pubkey, 0)).map(e => e.id), [current.id]);
    assert.deepEqual((await readEventHistory(db, pubkey, 3)).map(e => e.id), [latestList.id, priorList.id]);
    assert.equal(await db.getKey('events', old.id), old.id);
    const settings = async () => ({pubkey, relays: urls, relaySync: false, handle: '', capture: false});
    assert.equal(await queueBroadcast(db, {...await settings(), relays:['wss://third.example/']}), 1);
    assert.deepEqual((await db.getAll('outbox')).map(r => r.id).sort(), [current.id, old.id, old.id].sort());
    for (const [i, url] of urls.entries()) {
      await deliverPending(db, url, [{id: old.id, relay: url, broadcast: true, created_at: 1}], settings, pubkey,
        {since: 0, until: 100, have: new Set()});
      assert.equal(await db.getKey('events', old.id), i ? undefined : old.id);
    }
    assert.deepEqual((await db.getAll('outbox')).map(r => r.id), [current.id]);
  } finally { db.close(); }
});

test('index compaction waits for active snapshots and retains every block needed by the current index', async () => {
  const db = await openArchive(crypto.randomUUID());
  try {
    const note = sign(1, 1, 'persist');
    await append(db, [{event: note}, {event: sign(0, 1)}], pubkey);
    const before = await readRoot(db);
    assert.ok(before);
    await withIndexSnapshot(db, async () => {
      await append(db, [{event: sign(0, 2)}], pubkey);
      await db.put('meta', true, 'compactHistoryIndex');
      await compactHistoryIndex(db);
      assert.ok(await db.getKey('blocks', toHex(before.hash)));
    });
    const pointer = sign(HASHTREE_ROOT_KIND, 1, '', [['d','my-events'],['hash', toHex(before.hash)], ['key',toHex(before.key!)]]);
    await db.put('meta', {event: pointer, hash: toHex(before.hash), server:'https://example.org', acknowledged:[], pending:['wss://example.org']}, 'indexPointer');
    await compactHistoryIndex(db);
    assert.ok(await db.getKey('blocks', toHex(before.hash)));
    await db.delete('meta', 'indexPointer');
    await db.put('meta', true, 'compactHistoryIndex');
    await compactHistoryIndex(db);
    const current = await readRoot(db);
    assert.ok(current);
    const tree = new HashTree({store: readOnlyStore(async hash => await db.get('blocks', toHex(hash)) ?? null)});
    const reachable = [];
    for await (const {hash} of tree.walkBlocks(current)) reachable.push(toHex(hash));
    assert.deepEqual(await db.getAllKeys('blocks'), reachable.sort());
    assert.equal(await db.getKey('blocks', toHex(before.hash)), undefined);
    assert.equal((await new ArchiveEventBus(db, pubkey).query([{ids:[note.id]}])).events[0].event.id, note.id);
  } finally { db.close(); }
});

test('existing signed events are indexed and bounded during an archive upgrade', async () => {
  const name = crypto.randomUUID();
  const old = await openDB(name, 1, {upgrade(db) {
    for (const store of ['blocks', 'meta', 'events', 'drafts', 'sources', 'outbox', 'cursors']) db.createObjectStore(store);
  }});
  const relay = 'wss://legacy.example/';
  let latest = '';
  for (let i = 0; i < 14; i++) {
    const event = sign(0, i);
    await old.put('events', JSON.parse(JSON.stringify(event)), event.id);
    await old.put('outbox', {id: event.id, relay}, [event.id, relay]);
    latest = event.id;
  }
  old.close();
  const db = await openArchive(name);
  try {
    assert.equal(await db.count('events'), 11);
    assert.deepEqual(await db.getAllKeys('outbox'), [[latest, relay]]);
    assert.deepEqual((await readEventHistory(db, pubkey, 0)).map(e => e.created_at), [13,12,11,10,9,8,7,6,5,4,3]);
  } finally { db.close(); }
});

test('repeated follow changes bound physical index growth as well as saved event rows', async () => {
  const db = await openArchive(crypto.randomUUID());
  try {
    const people = Array.from({length: 84}, (_, i) => ['p', i.toString(16).padStart(64, '0'), '', 'Friend ' + i]);
    for (let i = 1; i <= 18; i++) await append(db, [{event: sign(3, i, '', people.slice(0, 65 + i))}], pubkey);
    const root = await readRoot(db);
    assert.ok(root);
    const tree = new HashTree({store: readOnlyStore(async hash => await db.get('blocks', toHex(hash)) ?? null)});
    let live = 0;
    for await (const block of tree.walkBlocks(root)) live += block.data.byteLength;
    const stored = (await db.getAll('blocks')).reduce((sum, block) => sum + block.byteLength, 0);
    assert.ok(stored - live <= 512 * 1024, 'Obsolete index blocks exceed the compaction threshold.');
    assert.equal(await db.count('events'), 4);
  } finally { db.close(); }
});

test('offline relay queues keep one explicitly addressed edition of each kind and preserve other targets and posts', async () => {
  const db = await openArchive(crypto.randomUUID());
  const [first, second] = ['wss://first.example/', 'wss://second.example/'];
  try {
    const original = sign(3, 1), note = sign(1, 1), profile = sign(0, 1);
    await append(db, [original, note, profile].map(event => ({event, targets:[first,second], announce:true})), pubkey);
    const lists = Array.from({length:12}, (_, i) => sign(3, i + 2));
    // An out-of-order local retry does not replace a newer queued event.
    const tie = sign(3, 13, '', [['p', '0'.repeat(64)]]);
    const winner = [lists[11], tie].sort((a,b) => a.id.localeCompare(b.id))[0];
    await append(db, [...lists.reverse(), tie].map(event => ({event, targets:[first], announce:true})), pubkey);
    assert.ok(await db.getKey('events', original.id));
    assert.deepEqual((await db.getAll('outbox')).filter(r => r.relay === first).map(r => r.id).sort(),
      [winner.id, note.id, profile.id].sort());
    assert.deepEqual((await db.getAll('outbox')).filter(r => r.relay === second).map(r => r.id).sort(),
      [original.id, note.id, profile.id].sort());
    // Observing a different client's later edition during sync leaves both explicitly queued editions alone.
    await append(db, [{event: sign(3, 20)}], pubkey);
    assert.ok(await db.getKey('outbox', [original.id, second]));
    assert.ok(await db.getKey('outbox', [winner.id, first]));
    const elected = sign(3, 21);
    await append(db, [{event: elected, targets:[second], announce:true}], pubkey);
    assert.equal(await db.getKey('events', original.id), undefined);
    assert.equal(await db.count('outbox'), 6);
    assert.ok(await db.getKey('outbox', [elected.id, second]));
    assert.ok(await db.getKey('outbox', [winner.id, first]));
  } finally { db.close(); }
});
