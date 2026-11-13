import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { relaySource } from 'nostr-pubsub';
import { ArchiveEventBus, archiveRouter, localArchive } from '../src/archive-event-bus.ts';
import { openArchive, queueBroadcast } from '../src/archive.ts';
import { deliverPending } from '../src/broadcast.ts';

const secret = generateSecretKey();
const owner = getPublicKey(secret);
const sign = (n: number) =>
  finalizeEvent({ kind: 1, created_at: n + 1, tags: [], content: String(n) }, secret);

test('a pubsub router can publish and query the local archive across concurrent connections', async () => {
  const name = crypto.randomUUID();
  const db = await openArchive(name),
    other = await openArchive(name);
  try {
    const url = 'wss://one.example/';
    const router = archiveRouter(db, owner, [url]);
    const local = sign(0),
      imported = sign(1);
    const separateConnection = new ArchiveEventBus(other, owner, [url]);
    const originalContent = local.content;
    const [report] = await Promise.all([
      router.publish(local, localArchive),
      separateConnection.publish(imported, relaySource(url)),
    ]);
    assert.ok(report.accepted);
    local.content = 'tampered after signing';
    assert.equal((await router.publish(local, localArchive)).accepted, false);
    const read = await router.query([{ authors: [owner], kinds: [1] }]);
    assert.ok(read.complete);
    assert.equal(
      read.events.find((row) => row.event.id === local.id)?.event.content,
      originalContent,
    );
    assert.deepEqual(
      read.events.map((row) => row.event.id),
      [imported.id, local.id],
    );
    assert.deepEqual(
      (await db.getAll('outbox')).map((row) => row.id),
      [local.id],
    );
  } finally {
    db.close();
    other.close();
  }
});

test('1,630 archived posts keep separate delivery records for two relays after reopening', async () => {
  const name = crypto.randomUUID();
  const relays = ['wss://first.example/', 'wss://second.example/'];
  let db = await openArchive(name);
  try {
    const backend = new ArchiveEventBus(db, owner);
    const events = Array.from({ length: 1630 }, (_, i) => sign(i));
    await backend.publishBatch(
      events.map((event) => ({ event })),
      relaySource(relays[0]),
    );
    assert.equal(await queueBroadcast(db, { relays, relaySync: false, pubkey: owner }), 1630);
    db.close();
    db = await openArchive(name);
    const queued = await db.getAll('outbox');
    assert.equal(queued.length, 3260);
    const first = queued.filter((row) => row.relay === relays[0]);
    // The comparison confirms the first relay already holds every queued ID.
    await deliverPending(
      db,
      relays[0],
      first,
      async () => ({
        pubkey: owner,
        relays,
        relaySync: false,
        handle: '',
        capture: false,
      }),
      owner,
      { have: new Set(), since: 0, until: 2000 },
    );
    db.close();
    db = await openArchive(name);
    const remaining = await db.getAll('outbox');
    assert.equal(remaining.length, 1630);
    assert.ok(remaining.every((row) => row.relay === relays[1]));
    assert.deepEqual(
      new Set(remaining.map((row) => row.id)),
      new Set(events.map((event) => event.id)),
    );
    const read = await new ArchiveEventBus(db, owner).query([
      { ids: [events[0].id, events[1629].id] },
    ]);
    assert.deepEqual(
      read.events.map((row) => row.event.id),
      [events[1629].id, events[0].id],
    );
  } finally {
    db.close();
  }
});
