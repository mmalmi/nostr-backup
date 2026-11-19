import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { generateSecretKey, finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { unzipSync, strFromU8 } from 'fflate';
import { Window } from 'happy-dom';
import { readPublicXOriginal } from '../src/x-audience.ts';
import { capturePosts } from '../src/x.ts';
import { xTemplate } from '../src/model.ts';
import { shareableMediaHashes } from '../src/legacy-x.ts';
import { openArchive, readPointer, inventory, queueBroadcast, dump } from '../src/archive.ts';
import { article, publicTweetHTML } from './fixtures.ts';

const draft = { id: '321', author: 'alice', time: 1234, text: 'Line one\nLine two & three' };
const url = 'https://x.com/alice/status/321';
test('X signing fields come from the anonymous permalink and its author-scoped record', async () => {
  const fetchPost = async (body: string, resultURL = url) =>
    readPublicXOriginal('alice', draft.id, async (input, options) => {
      assert.equal(input, url);
      assert.equal(options?.credentials, 'omit');
      assert.equal(options?.cache, 'no-store');
      const response = new Response(body, { headers: { 'content-type': 'text/html' } });
      Object.defineProperty(response, 'url', { value: resultURL });
      return response;
    });
  const html = publicTweetHTML('alice', '321', draft.text, draft.time);
  const original = await fetchPost(html);
  assert.deepEqual(original, { ...draft, visibility: 'public' });
  const reply = { reply_to_results: { rest_id: '456' }, reply_to_user_results: { result: { core: { screen_name: 'Bob' } } } };
  const verified = await fetchPost(publicTweetHTML('alice', '321', draft.text, draft.time, [], reply));
  assert.ok(verified);
  const comment = xTemplate(verified, 'alice');
  assert.equal(comment.kind, 1111);
  assert.deepEqual(comment.tags.slice(0, 5), [['r', url], ['I', 'https://x.com/bob/status/456'],
    ['K', 'web'], ['i', 'https://x.com/bob/status/456'], ['k', 'web']]);
  assert.equal(await fetchPost(publicTweetHTML('alice', '321', draft.text, draft.time, [],
    { reply_to_results: { rest_id: '456' } })), undefined);
  assert.equal(await fetchPost(publicTweetHTML('bob', '321', draft.text, draft.time)), undefined);
  assert.equal(await fetchPost(publicTweetHTML('alice', '123', draft.text, draft.time)), undefined);
  assert.equal(await fetchPost(html, url + '5'), undefined);
  assert.equal(await fetchPost('<meta property="og:description" content="Public preview">'), undefined);
  const window = new Window();
  try {
    window.document.body.innerHTML = article('alice', '321', 'Restricted', '<span data-testid="superFollowsLabel"></span>');
    assert.equal(capturePosts(window.document as unknown as Document, 'https://x.com/alice', 'alice')[0].visibility, 'private');
  } finally { await window.happyDOM.abort(); }
});

test('X replies to your own posts reply to their Nostr copies instead of their X URLs', () => {
  const secret = generateSecretKey(), owner = getPublicKey(secret);
  const link = (id: string) => 'https://x.com/alice/status/' + id;
  const sign = (id: string, replyTo?: { author: string; id: string }, parent?: Parameters<typeof xTemplate>[2]) =>
    finalizeEvent(xTemplate({ id, author: 'alice', time: 1234, text: 'Post ' + id, ...(replyTo && { replyTo }) }, 'alice', parent), secret);
  const linkTags = (event: { tags: string[][] }) => event.tags.filter(([name]) => 'eEpPiIkKr'.includes(name));
  const head = sign('100');
  const second = sign('101', { author: 'alice', id: '100' }, head);
  const third = sign('102', { author: 'alice', id: '101' }, second);
  assert.equal(second.kind, 1);
  assert.deepEqual(linkTags(second), [['r', link('101')], ['i', link('101')], ['k', 'web'],
    ['e', head.id, '', 'root', owner], ['p', owner]]);
  assert.equal(third.kind, 1);
  assert.deepEqual(linkTags(third), [['r', link('102')], ['i', link('102')], ['k', 'web'],
    ['e', head.id, '', 'root', owner], ['e', second.id, '', 'reply', owner], ['p', owner]]);

  // A follow-up to your own comment on someone else's post stays in that post's comment thread.
  const comment = sign('200', { author: 'bob', id: '50' });
  const followUp = sign('201', { author: 'alice', id: '200' }, comment);
  assert.equal(followUp.kind, 1111);
  assert.deepEqual(linkTags(followUp), [['r', link('201')], ['I', 'https://x.com/bob/status/50'], ['K', 'web'],
    ['e', comment.id, '', owner], ['k', '1111'], ['p', owner]]);

  const reaction = finalizeEvent({ kind: 7, created_at: 1, tags: [], content: '+' }, secret);
  const reply = { id: '300', author: 'alice', time: 1234, text: 'Reply', replyTo: { author: 'alice', id: '100' } };
  assert.throws(() => xTemplate(reply, 'alice', reaction), /reply parent/);
  assert.throws(() => xTemplate({ ...reply, replyTo: { author: 'bob', id: '100' } }, 'alice', head), /reply parent/);
});

test('X media and photo-only posts use only the attachments belonging to the public original', async () => {
  const photo = 'https://pbs.twimg.com/media/photo.jpg';
  for (const caption of ['', 'Caption']) {
    for (const parent of [url, 'https://x.com/alice/status/123']) {
      const media = [{ type: 'photo', media_url_https: photo, expanded_url: parent + '/photo/1' }];
      const html = publicTweetHTML('alice', '321', caption, draft.time, media) +
        '<img src="https://pbs.twimg.com/media/other.jpg">';
      const original = await readPublicXOriginal('alice', draft.id, async () => {
        const response = new Response(html, { headers: { 'content-type': 'text/html' } });
        Object.defineProperty(response, 'url', {value: url});
        return response;
      });
      assert.equal(original?.text, parent === url ? [caption, photo].filter(Boolean).join('\n\n') : undefined);
    }
  }
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
