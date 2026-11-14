import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { generateSecretKey } from 'nostr-tools/pure';
import { instagramViewer, xProfileLink } from '../src/signed-in.ts';
import { expiringImage, withCopiedImages } from '../src/profile-images.ts';

function inPage<T>(html: string, read: () => T) {
  const window = new Window({ url: 'https://example.test/' });
  window.document.body.innerHTML = html;
  const previous = globalThis.document;
  globalThis.document = window.document as unknown as Document;
  try {
    return read();
  } finally {
    globalThis.document = previous;
    void window.happyDOM.abort();
  }
}

test('the signed-in X and Instagram accounts are read from their own page data', () => {
  assert.equal(inPage('<nav><a data-testid="AppTabBar_Profile_Link" href="/Alice">Profile</a></nav>', xProfileLink), '/Alice');
  assert.equal(inPage('<a href="/bob">Bob</a>', xProfileLink), null);
  // Instagram nests the viewer deep inside its page data.
  const data = { require: [['ScheduledServerJS', 'handle', null, [{ __bbox: { define: [['PolarisViewer', [], {
    data: { username: 'alice.ig', full_name: 'Alice', biography: 'Hi', external_url: 'https://alice.example/',
      profile_pic_url_hd: 'https://scontent.cdninstagram.com/a.jpg', has_phone_number: true },
  }, 1]] } }]]] };
  const html = '<script type="application/json">{"other":1}</script><script type="application/json">' + JSON.stringify(data) + '</script>';
  // Only public profile fields leave the page.
  assert.deepEqual(inPage(html, instagramViewer), {
    username: 'alice.ig', name: 'Alice', about: 'Hi', website: 'https://alice.example/', picture: 'https://scontent.cdninstagram.com/a.jpg',
  });
  assert.equal(inPage('<script type="application/json">{"PolarisViewer":1}</script>', instagramViewer), null);
});

test('profile pictures are copied to Blossom, and expiring ones are dropped if the copy fails', async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const uploads: string[] = [];
  let failUploads = false;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://blossom.example/upload') {
      if (failUploads) return new Response('', { status: 503 });
      const hash = (init?.headers as Record<string, string>)['X-SHA-256'];
      uploads.push(hash);
      return Response.json({ url: 'https://blossom.example/' + hash + '.jpg', sha256: hash, size: jpeg.byteLength });
    }
    assert.equal(init?.credentials, 'omit');
    return new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } });
  }) as typeof fetch;
  const key = generateSecretKey();
  const profile = { name: 'Alice', picture: 'https://pbs.twimg.com/profile_images/1/a_400x400.jpg', banner: 'https://scontent.cdninstagram.com/b.jpg' };
  const copied = await withCopiedImages(profile, key, 'https://blossom.example', fetcher);
  assert.equal(uploads.length, 2);
  assert.match(copied.picture!, /^https:\/\/blossom\.example\/[0-9a-f]{64}\.jpg$/);
  assert.match(copied.banner!, /^https:\/\/blossom\.example\//);
  failUploads = true;
  assert.deepEqual(await withCopiedImages(profile, key, 'https://blossom.example', fetcher), {
    name: 'Alice', picture: profile.picture,
  });
  assert.equal(expiringImage('https://instagram.fqlf1-2.fna.fbcdn.net/v/a.jpg'), true);
  assert.equal(expiringImage('https://pbs.twimg.com/a.jpg'), false);
});
