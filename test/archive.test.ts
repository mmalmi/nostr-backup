import { readOnlyStore } from '../src/blocks.ts';
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { unzipSync, strFromU8 } from 'fflate';
import { NostrEventStore } from '@hashtree/nostr';
import { append, dump, inventory, openArchive, stagePosts } from '../src/archive.ts';
import { openDB } from 'idb';
import { hex, unhex } from '../src/model.ts';
import { syncHistory } from '../src/relays.ts';
const key = generateSecretKey(),
  pubkey = getPublicKey(key);
const sign = (content: string, time = 100) =>
  finalizeEvent({ kind: 1, created_at: time, content, tags: [] }, key);
test('upgrading a v1 archive indexes existing posts for reconciliation', async () => {
  const name = crypto.randomUUID();
  const old = await openDB(name, 1, {
    upgrade(db) {
      for (const store of ['blocks', 'meta', 'events', 'drafts', 'sources', 'outbox', 'cursors'])
        db.createObjectStore(store);
    },
  });
  const event = sign('before upgrade', 12);
  await old.put('events', JSON.parse(JSON.stringify(event)), event.id);
  old.close();
  const db = await openArchive(name);
  assert.deepEqual(await inventory(db, 12, 12), [{ id: event.id, created_at: 12 }]);
  assert.deepEqual(await inventory(db, 13, 100), []);
  db.close();
});
test('locked capture survives reopen; signing indexes, dequeues and exports in one transaction', async () => {
  const name = crypto.randomUUID(),
    draft = { id: '123', author: 'alice', text: 'hi', time: 100 };
  let db = await openArchive(name);
  await stagePosts(db, [draft, draft]);
  db.close();
  db = await openArchive(name);
  assert.equal(await db.count('drafts'), 1);
  const event = sign('hi'),
    relay = 'wss://example.org/';
  assert.equal(await append(db, [{ event, source: 'x:123', targets: [relay] }], pubkey), 1);
  assert.equal(await append(db, [{ event }], pubkey), 0);
  await stagePosts(db, [draft]);
  assert.equal(await db.count('drafts'), 0);
  assert.deepEqual(await db.getAll('outbox'), [{ id: event.id, relay }]);
  const zip = unzipSync(await dump(db, pubkey));
  assert.equal(JSON.parse(strFromU8(zip['events.jsonl'])).id, event.id);
  assert.equal(JSON.parse(strFromU8(zip['x-sources.json']))['x:123'], event.id);
  const { root } = JSON.parse(strFromU8(zip['manifest.json']));
  const restored = new NostrEventStore(
    readOnlyStore(async (hash) => zip['blocks/' + hex(hash)] ?? null),
  );
  const found = await restored.getById({ hash: unhex(root.hash), key: unhex(root.key) }, event.id);
  assert.equal(found?.content, 'hi');
  assert.equal(strFromU8(zip['manifest.json']).includes(hex(key)), false);
});
test('foreign authors, forged signatures, unsupported kinds and tampering rejected atomically', async () => {
  const db = await openArchive(crypto.randomUUID()),
    good = sign('yes');
  for (const invalid of [
    JSON.parse(JSON.stringify({ ...good, content: 'altered' })),
    JSON.parse(JSON.stringify({ ...good, sig: '0'.repeat(128) })),
    finalizeEvent({ kind: 1, created_at: 3, tags: [], content: 'other' }, generateSecretKey()),
    finalizeEvent({ kind: 4, created_at: 3, tags: [], content: 'private' }, key),
  ]) {
    await assert.rejects(append(db, [{ event: good }, { event: invalid }], pubkey));
    assert.equal(await db.count('events'), 0);
    assert.equal(await db.count('blocks'), 0);
  }
});
test('per-relay cursor resumes after interruption, deduplicates and rescans the boundary second', async () => {
  const db = await openArchive(crypto.randomUUID()),
    url = 'wss://r.example/';
  const all = [sign('one', 80), sign('two', 80), sign('old', 69)];
  let fail = true;
  const seen: number[] = [];
  const read: typeof import('../src/relays.ts').readPage = async (relay, f) => {
    assert.equal(relay, url);
    assert.deepEqual(f.authors, [pubkey]);
    assert.ok(f.until !== undefined);
    const until = f.until;
    seen.push(until);
    const events = all.filter((e) => e.created_at <= until).slice(0, f.limit);
    if (fail) {
      fail = false;
      return { events: events.slice(0, 1), complete: false, reason: 'lost connection' };
    }
    return { events, complete: true };
  };
  const opt: Parameters<typeof syncHistory>[0] = {
    db,
    url,
    pubkey,
    now: 100,
    read,
    save: (e, p) => append(db, e, p),
  };
  await assert.rejects(syncHistory(opt), /lost connection/);
  assert.equal(await db.count('events'), 1);
  assert.equal(await db.count('cursors'), 0);
  assert.equal(await syncHistory({ ...opt, pageBudget: 1 }), 'More history queued');
  assert.equal(await syncHistory(opt), 'Up to date');
  assert.deepEqual(seen, [100, 100, 69, 68]);
  assert.equal(await db.count('events'), 3);
  assert.equal(await db.count('outbox'), 0);
  assert.equal((await db.get('cursors', [pubkey, url]))?.through, 100);
});
test('a full second grows the page limit without skipping tied events', async () => {
  const db = await openArchive(crypto.randomUUID()),
    url = 'wss://tie.example/';
  const events = Array.from({ length: 101 }, (_, i) => sign(String(i), 100));
  const limits: number[] = [],
    saved = new Set();
  await syncHistory({
    db,
    url,
    pubkey,
    now: 100,
    read: async (_, f) => {
      assert.ok(f.limit !== undefined);
      limits.push(f.limit);
      return { events: f.until === 100 ? events.slice(0, f.limit) : [], complete: true };
    },
    save: async (entries) => {
      entries.forEach((e) => saved.add(e.event.id));
      return entries.length;
    },
  });
  assert.equal(saved.size, 101);
  assert.deepEqual(limits, [100, 200, 100]);
});
