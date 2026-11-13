import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { generateSecretKey, finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { unzipSync, strFromU8 } from 'fflate';
import { Window } from 'happy-dom';
import { confirmPublicXPost } from '../src/x-audience.ts';
import { capturePosts } from '../src/x.ts';
import { shareableMediaHashes } from '../src/legacy-x.ts';
import { openArchive, readPointer, inventory, queueBroadcast, dump } from '../src/archive.ts';
import { article } from './fixtures.ts';

const draft = { id: '321', author: 'alice', time: 1234, text: 'Line one\nLine two & three' };
const url = 'https://x.com/alice/status/321';
const embed = { url, author_url: 'https://x.com/alice', type: 'rich',
  html: '<blockquote class="twitter-tweet"><p>Line one<br>Line two &amp; three</p></blockquote>' };

test('X visibility needs matching public content and cannot be asserted by a signed-in capture', async () => {
  const fetcher: typeof fetch = async (input, options) => {
    assert.equal(new URL(String(input)).origin, 'https://publish.x.com');
    assert.equal(options?.credentials, 'omit');
    assert.equal(options?.cache, 'no-store');
    return Response.json(embed);
  };
  assert.equal(await confirmPublicXPost(draft, fetcher), true);
  for (const result of [{...embed, url: url + '5'}, {...embed, author_url: 'https://x.com/bob'},
    {...embed, html: '<blockquote class="twitter-tweet"><p>Public preview</p></blockquote>'}]) {
    assert.equal(await confirmPublicXPost({...draft, visibility: 'public'}, async () => Response.json(result)), false);
  }
  const window = new Window();
  try {
    const page = 'https://x.com/alice';
    window.document.body.innerHTML = article('alice', '321', 'Restricted', '<span data-testid="superFollowsLabel"></span>');
    const [restricted] = capturePosts(window.document as unknown as Document, page, 'alice');
    assert.equal(restricted.visibility, 'private');
    let requests = 0;
    assert.equal(await confirmPublicXPost(restricted, async () => { requests++; return Response.json(embed); }), false);
    assert.equal(requests, 0);
  } finally { await window.happyDOM.abort(); }
});

test('X media proof binds each attachment to the original post even with a matching preview', async () => {
  const photo = 'https://pbs.twimg.com/media/photo.jpg', other = 'https://pbs.twimg.com/media/hidden.jpg';
  const record = {data: {tweet_result_by_rest_id: {result: {
    __typename: 'Tweet', rest_id: '321', core: {user_results: {result: {core: {screen_name: 'alice'}}}},
    media_entities2: [{media_url_https: photo, expanded_url: url + '/photo/1'}],
  }}}};
  const html = '<meta property="og:url" content="' + url + '"><meta property="og:description" content="Caption">' +
    '<script>const data=' + JSON.stringify(JSON.stringify(record)) + '</script><img src="' + other + '">';
  const fetcher: typeof fetch = async () => {
    const response = new Response(html, {headers:{'Content-Type':'text/html'}});
    Object.defineProperty(response, 'url', {value:url});
    return response;
  };
  assert.equal(await confirmPublicXPost({...draft, text:'Caption\n\n' + photo},fetcher),true);
  assert.equal(await confirmPublicXPost({...draft, text:'Caption\n\n' + photo + '\n\n' + other},fetcher),false);
  assert.equal(await confirmPublicXPost({...draft, text:'Secret caption\n\n' + photo},fetcher),false);
});

test('a photo-only X post is confirmed by its media when the public page has a generic description', async () => {
  const photo = 'https://pbs.twimg.com/media/photo?format=jpg&name=small', other = 'https://pbs.twimg.com/media/hidden.jpg';
  const record = {data: {tweet_result_by_rest_id: {result: {
    __typename: 'Tweet', rest_id: '321', core: {user_results: {result: {core: {screen_name: 'alice'}}}},
    media_entities2: [{media_url_https: 'https://pbs.twimg.com/media/photo.jpg', expanded_url: url + '/photo/1'}],
  }}}};
  const html = '<meta property="og:url" content="' + url + '"><meta property="og:description" content="Alice (@alice) on X">' +
    '<script>const data=' + JSON.stringify(JSON.stringify(record)) + '</script>';
  const fetcher: typeof fetch = async () => {
    const response = new Response(html, {headers:{'Content-Type':'text/html'}});
    Object.defineProperty(response, 'url', {value:url});
    return response;
  };
  assert.equal(await confirmPublicXPost({...draft, text: photo}, fetcher), true);
  assert.equal(await confirmPublicXPost({...draft, text: photo + '\n\n' + other}, fetcher), false);
  assert.equal(await confirmPublicXPost({...draft, text: other}, fetcher), false);
});

test('old X backups preserve their contents locally and lose pending public sends and index deliveries', async () => {
  const key = generateSecretKey(), pubkey = getPublicKey(key), name = crypto.randomUUID();
  const event = (text: string) => JSON.parse(JSON.stringify(finalizeEvent({kind:1,content:text,created_at:10,tags:[]},key)));
  const held = event('Former X capture'), native = event('Independent Nostr note');
  const relay = 'wss://migration.example/';
  const old = await openDB(name, 5, {upgrade(db) {
    for (const store of ['blocks','meta','events','sources','drafts','outbox','xMedia','xMatches','mediaFiles','cursors']) {
      const s = db.createObjectStore(store);
      if (store === 'events') s.createIndex('created_at', 'created_at');
    }
    db.createObjectStore('mediaRefs',{keyPath:['eventId','url']}).createIndex('url','url');
  }});
  for (const [post, source] of [[held,'x:321'],[native,'x:654']] as const) {
    await old.put('events',post,post.id); await old.put('sources',post.id,source);
    await old.put('outbox',{id:post.id,relay},[post.id,relay]);
  }
  await old.put('xMatches',draft,'x:654');
  await old.put('drafts',draft,'x:100');
  await old.put('meta',{hash:'original',server:'https://example.com',pending:[relay],acknowledged:[],event:native},'indexPointer');
  old.close();
  const db = await openArchive(name);
  try {
    assert.equal(await db.get('heldEvents',held.id),'x:321');
    assert.equal(await db.get('heldEvents',native.id),undefined);
    assert.equal((await db.get('localCaptures','x:100'))?.visibility,'unknown');
    assert.deepEqual((await readPointer(db))?.pending,[]);
    assert.equal(await queueBroadcast(db,{pubkey,relays:[relay],relaySync:false}),1);
    assert.deepEqual((await db.getAll('outbox')).map(row=>row.id),[native.id]);
    assert.deepEqual((await inventory(db,0,100))?.map(row=>row.id),[native.id]);
    const zip = unzipSync(await dump(db,pubkey));
    assert.match(strFromU8(zip['events.jsonl']), /Former X capture/);
    const hashes = ['a','b','c'].map(s => s.repeat(64));
    for (const [i,id] of [native.id, held.id, 'facebook:123'].entries())
      await db.put('mediaRefs',{eventId:id,url:'https://photo.example/'+i,sha256:hashes[i],fallbacks:[],servers:[],poster:false,status:'saved',invalidHash:false});
    assert.deepEqual(await shareableMediaHashes(db),new Set([hashes[0]]));
  } finally { db.close(); }
});
