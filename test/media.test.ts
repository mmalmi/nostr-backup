import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDB } from 'idb';
import { sha256 } from '@hashtree/core';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { unzipSync, strFromU8 } from 'fflate';
import { append, dump, openArchive } from '../src/archive.ts';
import { backupMedia, readMediaFile, putBlossom } from '../src/media-files.ts';
import { mediaReferences } from '../src/media-refs.ts';
import { deliverBlossom, queueBlossom } from '../src/blossom-sync.ts';
import { shareableMediaHashes } from '../src/legacy-x.ts';
import { hex } from '../src/model.ts';

const key = generateSecretKey(),
  pubkey = getPublicKey(key);
const event = (content: string, tags: string[][] = [], kind = 1) =>
  finalizeEvent({ content, tags, kind, created_at: 5 }, key);
const photo = 'https://old.example/image.jpg';
const body = new Uint8Array(2 * 1024 * 1024 + 23).map((_, i) => i % 251);
const digest = hex(await sha256(body));
const imeta = ['imeta', 'url ' + photo, 'm image/jpeg', 'x ' + digest];
test('upgrading version 2 discovers existing media and preserves the signed event', async () => {
  const name = crypto.randomUUID(),
    note = event(photo, [imeta]);
  const old = await openDB(name, 2, {
    upgrade(db) {
      for (const store of ['blocks', 'meta', 'events', 'drafts', 'sources', 'outbox', 'cursors'])
        db.createObjectStore(store);
    },
  });
  await old.put('events', JSON.parse(JSON.stringify(note)), note.id);
  old.close();
  const db = await openArchive(name);
  assert.equal((await db.getAll('mediaRefs'))[0].expected, digest);
  assert.equal((await db.get('events', note.id))?.sig, note.sig);
  db.close();
});
test('a failed original falls back to Blossom, survives reopen and restores a multi-block file offline', async () => {
  const name = crypto.randomUUID();
  let db = await openArchive(name);
  const note = event(photo, [imeta]);
  await append(db, [{ event: note }], pubkey);
  const attempts: string[] = [];
  const server = 'https://mirror.example';
  const fetcher: typeof fetch = async (url, init) => {
    attempts.push(String(url));
    assert.equal(init?.cache, 'force-cache');
    assert.equal(init?.credentials, 'omit');
    return url === photo
      ? new Response('wrong')
      : new Response(body, { headers: { 'Content-Type': 'image/jpeg' } });
  };
  assert.deepEqual(await backupMedia(db, { fetcher, resolveServers: async () => [server] }), {
    saved: 1,
    unavailable: 0,
  });
  assert.deepEqual(attempts, [photo, server + '/' + digest]);
  db.close();
  db = await openArchive(name);
  const other = event('blossom:' + digest + '.jpg?xs=other.example');
  await append(db, [{ event: other }, { event: event('same URL ' + photo) }], pubkey);
  let attempted = false;
  assert.deepEqual(
    await backupMedia(db, {
      fetcher: async () => {
        attempted = true;
        throw Error('offline');
      },
    }),
    { saved: 2, unavailable: 0 },
  );
  assert.equal(attempted, false);
  const zip = unzipSync(await dump(db, pubkey));
  const { files, references } = JSON.parse(strFromU8(zip['media.json']));
  assert.equal(files.length, 1);
  assert.equal(references.length, 3);
  assert.ok(files[0].blocks.length > 1);
  assert.deepEqual(
    await readMediaFile({ get: async (hash) => zip['blocks/' + hex(hash)] }, files[0]),
    body,
  );
  assert.equal(JSON.parse(strFromU8(zip['manifest.json'])).mediaFiles, 1);
  assert.equal((await db.get('events', note.id))?.sig, note.sig);
  const auth = finalizeEvent({ content: '', kind: 24242, created_at: 7, tags: [] }, key);
  const authorize = async (hash: string, target: string) => {
    assert.equal(hash, digest);
    assert.equal(target, server);
    return auth;
  };
  await assert.rejects(
    putBlossom(server, digest, body, 'image/png', await authorize(digest,server), async () => Response.json({ sha256: 'wrong' })),
    /descriptor/,
  );
  assert.deepEqual((await db.get('mediaFiles', digest))?.copies, []);
  const uploaded = await putBlossom(server, digest, body, 'image/png', await authorize(digest,server), async (url, init) => {
    assert.equal(url, server + '/upload');
    assert.deepEqual(init?.body, body);
    assert.match(new Headers(init?.headers).get('Authorization') ?? '', /^Nostr /);
    return Response.json({ sha256: digest, size: body.length, url: server + '/' + digest });
  });
  assert.equal(uploaded, server + '/' + digest);
  db.close();
});
test('missing media retries, hash mismatch and streamed size limit leave no saved file', async () => {
  const db = await openArchive(crypto.randomUUID());
  await append(db, [{ event: event(photo, [imeta]) }], pubkey);
  for (const fetcher of [
    async () => new Response('404', { status: 404 }),
    async () => new Response('wrong'),
    async () => new Response(body),
  ]) {
    assert.equal((await backupMedia(db, { maxMiB: 1, fetcher })).unavailable, 1);
    assert.equal(await db.count('mediaFiles'), 0);
  }
  assert.match((await db.getAll('mediaRefs'))[0].error ?? '', /limit/);
  assert.equal((await backupMedia(db, { fetcher: async () => new Response(body) })).saved, 1);
  db.close();
});
test('discovers file metadata, rejects contradictory hashes, and labels X posters', () => {
  const hashed = 'https://example.com/' + digest;
  assert.equal(
    mediaReferences(event(hashed, [['imeta', 'url ' + hashed, 'x ' + 'f'.repeat(64)]]))[0]
      .invalidHash,
    true,
  );
  assert.equal(
    mediaReferences(
      event(
        '',
        [
          ['url', photo],
          ['x', digest],
        ],
        1063,
      ),
    )[0].expected,
    digest,
  );
  const refs = mediaReferences(
    event('https://pbs.twimg.com/ext_tw_video_thumb/12/a.jpg https://example.com/article'),
  );
  assert.equal(refs.length, 1);
  assert.equal(refs[0].poster, true);
  assert.deepEqual(
    mediaReferences(event('https://user:pw@example.com/img.png https://example.com/article')),
    [],
  );
});

test('Blossom sync recovers missing public and loopback copies from local Hashtree across restart', async () => {
  const name = crypto.randomUUID(),
    remote = 'https://mirror.example',
    local = 'http://127.0.0.1:8081';
  const servers = [remote, local];
  let db = await openArchive(name);
  const note = event(photo, [imeta]);
  await append(db, [{ event: note }], pubkey);
  await backupMedia(db, {
    fetcher: async () => new Response(body, { headers: { 'content-type': 'image/jpeg' } }),
  });
  const allowed = await shareableMediaHashes(db);
  assert.deepEqual([...allowed], [digest]);
  assert.equal(await queueBlossom(db, allowed, servers, true), 2);
  const missing = new Set(servers),
    writes: string[] = [],
    checks: string[] = [];
  let offline = true;
  const fetcher: typeof fetch = async (url, init) => {
    const server = new URL(String(url)).origin;
    if (init?.method === 'HEAD') {
      checks.push(server);
      if (server === remote && offline) return new Response(null, { status: 503 });
      return new Response(null, { status: missing.has(server) ? 404 : 200 });
    }
    assert.equal(init?.method, 'PUT');
    assert.deepEqual(init.body, body);
    writes.push(server);
    missing.delete(server);
    return Response.json({
      sha256: digest,
      size: body.length,
      url: server + '/' + digest + '.jpg',
    });
  };
  const opts = {
    signal: new AbortController().signal,
    fetcher,
    authorize: async () => event('upload'),
  };
  try {
    await deliverBlossom(db, servers, opts);
    assert.deepEqual(writes, [local]);
    const failed = await db.get('blossomOutbox', [digest, remote]);
    assert.ok(failed?.retryAt && failed.retryAt > Date.now());
    assert.match(failed.error!, /503/);
    db.close();
    db = await openArchive(name);
    await deliverBlossom(db, servers, opts);
    assert.equal(checks.length, 2);
    offline = false;
    // Simulate the next scheduled pass after the stored deadline.
    await db.put('blossomOutbox', { ...failed, retryAt: Date.now() - 1 });
    await db.put('meta', Date.now() - 1, ['blossomRetry', remote]);
    await deliverBlossom(db, servers, opts);
    assert.deepEqual(writes, [local, remote]);
    missing.add(remote);
    await queueBlossom(db, allowed, servers, true);
    await deliverBlossom(db, servers, opts);
    assert.deepEqual(writes, [local, remote, remote]);
    assert.equal(await db.count('blossomOutbox'), 0);
    const file = await db.get('mediaFiles', digest);
    assert.equal(file?.copyUrls?.[local], local + '/' + digest + '.jpg');
    assert.equal(file?.copyUrls?.[remote], remote + '/' + digest + '.jpg');
    assert.equal((await db.get('events', note.id))?.sig, note.sig);
    await db.put('heldEvents', 'x:1', note.id);
    assert.equal((await shareableMediaHashes(db)).size, 0);
    await queueBlossom(db, [digest], servers, true);
    const before = checks.length;
    await deliverBlossom(db, servers, opts);
    assert.equal(checks.length, before);
  } finally {
    db.close();
  }
});
