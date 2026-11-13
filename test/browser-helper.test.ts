import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { HashTree, MemoryStore, LinkType, fromHex, nhashEncode, sha256, toHex } from '@hashtree/core';
import { npubEncode } from 'nostr-tools/nip19';
import { generateSecretKey, finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { Window } from 'happy-dom';
import { installBrowserHelper } from '../src/browser-helper.ts';
import { imageCache } from '../src/helper-cache.ts';
import { treeAddress, irisDriveURL, IRIS_APPS_ADDRESS, openSiteURL } from '../src/helper-links.ts';
import { resolveImage, imageDataURL } from '../src/helper-images.ts';
import { openArchive, append } from '../src/archive.ts';
import { backupMedia } from '../src/media-files.ts';
import type { Settings } from '../src/types.ts';

const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a6kAAAAASUVORK5CYII=', 'base64'));
const digest = toHex(await sha256(png));
const conf: Settings = { pubkey: '', handle: '', capture: false, relays: [], relaySync: false,
  blossomServers: ['https://first.example', 'http://127.0.0.1:8080'] };
const offline = async (): Promise<never> => { throw Error('Offline'); };

test('a failed source falls through to the configured peer node, verifies SHA-256 and caches independently of the archive', async () => {
  const urls: string[] = [];
  const name = crypto.randomUUID();
  const sources = { cache: imageCache(name), lookupRoot: offline, fetcher: async (url: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(url));
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.redirect, 'error');
    return new Response(String(url).startsWith(conf.blossomServers![0]) ? 'wrong bytes' : png);
  } };
  assert.deepEqual(await resolveImage('blossom:' + digest + '.png?xs=unsaved.example', conf, sources), png);
  assert.deepEqual(urls, conf.blossomServers!.map(s => s + '/' + digest));
  for (const url of ['blossom://' + digest, 'https://gone.example/' + digest + '.png'])
    assert.deepEqual(await resolveImage(url, conf, { ...sources, cache: imageCache(name), fetcher: offline }), png);
  assert.match(imageDataURL(png), /^data:image\/png;base64,/);
  assert.throws(() => imageDataURL(new TextEncoder().encode('<html>')), /format/);
  await assert.rejects(resolveImage('https://example.com/control', conf, sources), /hash-addressed/);
});

test('chunked keyed nhash files, immutable paths and named trees use verified ciphertext blocks', async () => {
  const store = new MemoryStore(), tree = new HashTree({ store, chunkSize: 24 });
  const file = await tree.putFile(png), root = await tree.putDirectory([{ ...file, name: 'a b.png', type: LinkType.File }]);
  const npub = npubEncode('b'.repeat(64));
  const sources = { cache: imageCache(crypto.randomUUID()), lookupRoot: async (pubkey: string, name: string) => {
    assert.equal(pubkey, 'b'.repeat(64)); assert.equal(name, 'my/photos'); return root.cid;
  }, fetcher: async (url: RequestInfo | URL) => {
    const block = await store.get(fromHex(new URL(String(url)).pathname.slice(1)));
    return new Response(block as Uint8Array<ArrayBuffer> | null, { status: block ? 200 : 404 });
  } };
  const path = 'htree://' + nhashEncode(root.cid) + '/a%20b.png';
  assert.deepEqual(await resolveImage(path, conf, sources), png);
  const queryKey = 'htree://' + nhashEncode(root.cid.hash) + '/a%20b.png?k=' + toHex(root.cid.key!);
  assert.deepEqual(await resolveImage(queryKey, conf, { ...sources, fetcher: offline }), png);
  assert.deepEqual(await resolveImage('htree://' + npub + '/my%2Fphotos/a%20b.png', conf, { ...sources, fetcher: offline }), png);
  assert.deepEqual(await resolveImage('htree://' + nhashEncode(file.cid) + '/photo.png', conf, { ...sources, fetcher: offline }), png);
  await assert.rejects(resolveImage(path + '/nope', conf, sources));
  await assert.rejects(resolveImage('htree://' + nhashEncode(root.cid), conf, sources), /file/);
});

test('an active archive serves a public attachment offline by digest and CID, and withholds local-only files', async () => {
  const key = generateSecretKey(), pubkey = getPublicKey(key), account = { ...conf, pubkey, archiveName: crypto.randomUUID() };
  const db = await openArchive(account.archiveName), url = 'blossom:' + digest + '.png';
  try {
    const event = finalizeEvent({ kind: 1, content: url, tags: [], created_at: 12 }, key);
    await append(db, [{ event }], pubkey);
    await backupMedia(db, { server: 'https://saved.example', fetcher: async () => new Response(png) });
    const file = (await db.get('mediaFiles', digest))!;
    const link = 'htree://' + nhashEncode({ hash: file.cid.hash, decryptKey: file.cid.key });
    const sources = { cache: imageCache(crypto.randomUUID()), fetcher: offline, lookupRoot: offline };
    const raw = 'htree://' + nhashEncode(digest);
    for (const ref of [url, link, raw]) assert.deepEqual(await resolveImage(ref, account, sources), png);
    await db.put('heldEvents', 'x:1', event.id);
    for (const ref of [url, link, raw]) await assert.rejects(resolveImage(ref, account, sources), /unavailable/);
  } finally { db.close(); }
});

test('the browsing cache serializes concurrent inserts, deduplicates and evicts to its byte limit', async () => {
  const cache = imageCache(crypto.randomUUID(), 520);
  await Promise.all(['a', 'a', 'b'].map(key => cache.put(key, Uint8Array.of(1, 2, 3))));
  await cache.put('c', Uint8Array.of(3, 2, 1));
  assert.equal(await cache.get('a'), undefined);
  assert.ok(await cache.get('b'));
  assert.ok(await cache.get('c'));
});

test('Iris Drive URLs preserve path, query and fragment and give different site roots separate origins', () => {
  const npub = npubEncode('b'.repeat(64));
  assert.equal(irisDriveURL('htree://' + npub + '/site/assets/?theme=dark#start'),
    'http://site.' + npub + '.iris.localhost:17321/assets/?theme=dark#start');
  assert.equal(irisDriveURL('htree://' + npub + '/release%2Fapp/test.txt'),
    'http://iris.localhost:17321/' + npub + '/release%2Fapp/test.txt');
  const nhash = nhashEncode({ hash: '00'.repeat(32), decryptKey: 'aa'.repeat(32) });
  const link = new URL(irisDriveURL('htree://' + nhash + '/index.html?test=1#intro'));
  assert.equal(link.hostname, 'a'.repeat(52) + '.sites.iris.localhost');
  assert.equal(link.searchParams.get('k'), 'aa'.repeat(32));
  assert.equal(link.hash, '#intro');
  assert.notEqual(new URL(irisDriveURL('htree://' + nhashEncode('ab'.repeat(32)))).origin, link.origin);
  for (const url of ['htree://self/drive', 'htree://invalid', 'htree://' + npub + '/a/%2e%2e/b',
    'htree://' + npub + '/a/b%2Fc', 'htree://' + nhash + '@example.com/x']) assert.throws(() => treeAddress(url));
});

test('the site opener accepts named paths and immutable roots without losing their identity', () => {
  const owner = npubEncode('b'.repeat(64));
  const named = owner + '/apps%2Fphotos/my%20album/';
  assert.equal(openSiteURL(named, false), 'https://apps.iris.to/#/' + named + 'index.html?htree=1');
  assert.match(openSiteURL(IRIS_APPS_ADDRESS, true), /^http:\/\/sites\.npub1[^.]+\.iris\.localhost:17321\/$/);
  assert.throws(() => openSiteURL(named, true), /Choose Browser/);
  assert.throws(() => openSiteURL(owner + '/site/a?b=c#d', false), /Iris Drive/);
  assert.equal(openSiteURL(owner + '/site/a?b=c#d', true),
    'http://site.' + owner + '.iris.localhost:17321/a?b=c#d');
  const root = nhashEncode(fromHex('ab'.repeat(32)));
  const keyed = nhashEncode({ hash: 'ab'.repeat(32), decryptKey: 'cd'.repeat(32) });
  assert.equal(openSiteURL(root + '/img.png?k=' + 'cd'.repeat(32), false),
    'https://apps.iris.to/#/' + keyed + '/img.png?htree=1');
  for (const invalid of ['https://example.com', owner, owner + '/site/%2e%2e/index.html'])
    assert.throws(() => openSiteURL(invalid, false));
});

test('dynamic image changes win over pending requests and links retain normal browser navigation', async () => {
  const win = new Window({ url: 'https://reader.example/' });
  const doc = win.document as unknown as Document;
  const old = globalThis.MutationObserver;
  globalThis.MutationObserver = win.MutationObserver as unknown as typeof MutationObserver;
  let finish!: (value: string) => void;
  const first = 'blossom:' + digest + '.png';
  doc.body.innerHTML = '<img src="' + first + '">';
  try {
    const reads: string[] = [];
    installBrowserHelper(doc, async src => {
      reads.push(src);
      if (src === first) return new Promise(resolve => { finish = resolve; });
      return imageDataURL(png);
    });
    const img = doc.querySelector('img')!;
    img.src = 'https://ordinary.example/image.png';
    finish(imageDataURL(png));
    await win.happyDOM.waitUntilComplete();
    assert.equal(img.getAttribute('src'), 'https://ordinary.example/image.png');
    const a = doc.createElement('a');
    a.href = 'htree://' + npubEncode('b'.repeat(64)) + '/site/';
    a.target = '_blank'; doc.body.append(a);
    img.src = 'blossom://' + digest;
    await win.happyDOM.waitUntilComplete();
    assert.equal(img.src, imageDataURL(png));
    assert.deepEqual(reads, [first, 'blossom://' + digest]);
    assert.equal(new URL(a.href).hostname, 'site.' + npubEncode('b'.repeat(64)) + '.iris.localhost');
    assert.equal(a.target, '_blank');
  } finally { globalThis.MutationObserver = old; await win.happyDOM.abort(); }
});
