import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { unzipSync, strFromU8 } from 'fflate';
import { NostrEventStore } from '@hashtree/nostr';
import { append, dump, openArchive, stagePosts } from '../src/archive.js';
import { hex, unhex } from '../src/model.js';
import { syncHistory } from '../src/relays.js';
const key = generateSecretKey(),
  pubkey = getPublicKey(key);
const sign = (content, time = 100) =>
  finalizeEvent({ kind: 1, created_at: time, content, tags: [] }, key);
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
  const restored = new NostrEventStore({ get: async (hash) => zip['blocks/' + hex(hash)] ?? null });
  const found = await restored.getById({ hash: unhex(root.hash), key: unhex(root.key) }, event.id);
  assert.equal(found.content, 'hi');
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
  const seen = [];
  const read = async (relay, f) => {
    assert.equal(relay, url);
    assert.deepEqual(f.authors, [pubkey]);
    seen.push(f.until);
    const events = all.filter((e) => e.created_at <= f.until).slice(0, f.limit);
    if (fail) {
      fail = false;
      return { events: events.slice(0, 1), complete: false, reason: 'lost connection' };
    }
    return { events, complete: true };
  };
  const opt = { db, url, pubkey, now: 100, read, save: (e, p) => append(db, e, p) };
  await assert.rejects(syncHistory(opt), /lost connection/);
  assert.equal(await db.count('events'), 1);
  assert.equal(await db.count('cursors'), 0);
  assert.equal(await syncHistory({ ...opt, pageBudget: 1 }), 'More history queued');
  assert.equal(await syncHistory(opt), 'Up to date');
  assert.deepEqual(seen, [100, 100, 69, 68]);
  assert.equal(await db.count('events'), 3);
  assert.equal(await db.count('outbox'), 0);
  assert.equal((await db.get('cursors', [pubkey, url])).through, 100);
});
test('a full second grows the page limit without skipping tied events', async () => {
  const db = await openArchive(crypto.randomUUID()),
    url = 'wss://tie.example/';
  const events = Array.from({ length: 101 }, (_, i) => sign(String(i), 100));
  const limits = [],
    saved = new Set();
  await syncHistory({
    db,
    url,
    pubkey,
    now: 100,
    read: async (_, f) => {
      limits.push(f.limit);
      return { events: f.until === 100 ? events.slice(0, f.limit) : [], complete: true };
    },
    save: async (entries) => entries.forEach((e) => saved.add(e.event.id)),
  });
  assert.equal(saved.size, 101);
  assert.deepEqual(limits, [100, 200, 100]);
});
