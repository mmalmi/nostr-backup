import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { capturePosts } from '../src/x.ts';
import { xTemplate, relayList } from '../src/model.ts';
import { profileHTML, article } from './fixtures.ts';
function capture(html: string, url = 'https://x.com/alice', handle = 'alice') {
  const win = new Window({
    url,
    settings: {
      disableCSSFileLoading: true,
      disableJavaScriptFileLoading: true,
      disableComputedStyleRendering: true,
    },
  });
  win.document.body.innerHTML = html;
  const posts = capturePosts(win.document as unknown as Document, url, handle);
  win.happyDOM.abort();
  return posts;
}
test('configured profile and outer permalink must agree regardless of the viewing account', () => {
  assert.equal(capture(profileHTML).length, 1);
  for (const path of ['/bob', '/home', '/alice/status/123', '/alice/likes', '/search?q=alice'])
    assert.deepEqual(capture(profileHTML, 'https://x.com' + path), []);
  assert.deepEqual(capture(profileHTML).map(post => post.author), ['alice']);
  assert.deepEqual(
    capture(profileHTML.replace('href="/alice/status/', 'href="https://evil.test/alice/status/')),
    [],
  );
  assert.deepEqual(capture(profileHTML, 'https://evil.test/alice'), []);
});
test('text, emoji, timestamp, case and canonical permalink', () => {
  const [post] = capture(profileHTML, 'https://x.com/ALICE/with_replies');
  assert.equal(post.text, 'Hello\nbackup 🌲');
  const note = xTemplate(post, 'alice');
  assert.equal(note.created_at, 1704164645);
  assert.equal(note.kind, 1);
  assert.deepEqual(note.tags, [
    ['r', 'https://x.com/alice/status/123'],
    ['i', 'https://x.com/alice/status/123'],
    ['k', 'web'],
    ['client', 'Social Backup'],
  ]);
});
test('skip truncated text, foreign reposts and nested quotations', () => {
  const nested = '<div role="link">' + article('alice', '222', 'quoted body') + '</div>';
  const html =
    profileHTML +
    article('bob', '111', null, nested) +
    article(
      'alice',
      '333',
      'partial',
      '<button data-testid="tweet-text-show-more-link">Show more</button>',
    );
  assert.deepEqual(
    capture(html).map((p) => p.id),
    ['123'],
  );
});
test('media-only post retains its image URL', () => {
  const html =
    profileHTML +
    article(
      'alice',
      '333',
      null,
      '<div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/abc.jpg"></div>',
    );
  assert.equal(capture(html).at(-1)?.text, 'https://pbs.twimg.com/media/abc.jpg');
});
test('all mounted X photos need a source before signing the post', () => {
  const photo = '<div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/a.jpg"></div>';
  const waiting = '<div data-testid="tweetPhoto"><img></div>';
  assert.deepEqual(capture(article('alice', '456', 'Two photos', photo + waiting)), []);
  assert.equal(
    capture(article('alice', '456', 'Two photos', photo + photo.replace('a.jpg', 'b.jpg')))[0].text,
    'Two photos\n\nhttps://pbs.twimg.com/media/a.jpg\n\nhttps://pbs.twimg.com/media/b.jpg',
  );
});
test('relay validation and deduplication', () => {
  assert.deepEqual(relayList('wss://example.org\nwss://example.org/'), ['wss://example.org/']);
  for (const url of [
    'https://x.com',
    'ws://example.org',
    'wss://user:pw@example.org',
    'wss://example.org/#x',
  ])
    assert.throws(() => relayList(url));
});
test('anonymized live X profile DOM preserves the exact date behind the abbreviated UI', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('./live-profile.html', import.meta.url), 'utf8');
  const [post] = capture(html, 'https://x.com/Alice');
  assert.deepEqual(post, {
    id: '123',
    author: 'alice',
    time: 1704164645,
    text: Array(7).fill('sample').join(' '),
  });
});
test('signed ms tag preserves source precision and cross-checks Snowflake timestamps', () => {
  const ms = 1704164645789;
  const id = (((BigInt(ms) - 1288834974657n) << 22n) + 32n).toString();
  const [p] = capture(profileHTML.replace('/alice/status/123', '/alice/status/' + id));
  const event = xTemplate(p, 'alice');
  assert.equal(event.created_at, 1704164645);
  assert.deepEqual(event.tags.at(-1), ['ms', String(ms)]);
  const [legacy] = capture(profileHTML.replace('03:04:05Z', '03:04:05.123Z'));
  assert.deepEqual(xTemplate(legacy, 'alice').tags.at(-1), ['ms', '1704164645123']);
  assert.ok(!xTemplate({ ...p, time: p.time + 2 }, 'alice').tags.some((t) => t[0] === 'ms'));
});

test('video capture prefers a direct MP4 and identifies a poster-only capture', () => {
  const video = 'https://video.twimg.com/ext_tw_video/123/clip.mp4?tag=1';
  const image = 'https://pbs.twimg.com/media/poster.jpg';
  const player = (src: string) =>
    article(
      'alice',
      '333',
      null,
      '<video poster="' + image + '"><source src="' + src + '"></video>',
    );
  const direct = capture(profileHTML + player(video)).at(-1);
  assert.ok(direct);
  assert.equal(direct.text, video);
  assert.equal(direct.posters, undefined);
  const poster = capture(profileHTML + player('blob:https://x.com/123')).at(-1);
  assert.ok(poster);
  assert.deepEqual(poster.posters, [image]);
  assert.equal(poster.text, image);
});

test('scroll keeps recycled rows while a previous capture batch is saving', async (t) => {
  const win = new Window({ url: 'https://x.com/alice' });
  t.after(() => win.happyDOM.abort());
  const holding = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const done = Promise.withResolvers<void>();
  const captured: string[] = [];
  Object.assign(win, {
    chrome: {
      storage: { onChanged: { addListener() {} } },
      runtime: {
        id: 'fixture',
        async sendMessage(msg: { type: string; posts?: { id: string }[] }) {
          if (msg.type === 'captureConfig')
            return { ok: true, value: { capture: true, handle: 'alice', pubkey: 'owner' } };
          const ids = msg.posts!.map((post) => post.id);
          if (!captured.length) {
            started.resolve();
            await holding.promise;
          }
          captured.push(...ids);
          if (captured.includes('3')) done.resolve();
          return { ok: true };
        },
      },
    },
  });
  const { build } = await import('esbuild');
  const bundle = await build({
    entryPoints: ['src/content.ts'],
    bundle: true,
    format: 'iife',
    write: false,
  });
  win.document.body.innerHTML = article('alice', '1');
  win.eval(bundle.outputFiles[0].text);
  await started.promise;
  for (const id of ['2', '3']) {
    win.document.body.innerHTML = article('alice', id);
    win.dispatchEvent(new win.Event('scroll'));
    await new Promise<void>((resolve) => win.requestAnimationFrame(() => resolve()));
  }
  holding.resolve();
  await done.promise;
  assert.deepEqual(captured, ['1', '2', '3']);
});

test('a quote card points to its own permalink, separate from the outer commentary', () => {
  const quote =
    '<div data-testid="quoteTweet" role="link"><span data-testid="tweetText">Original text</span><a href="/alice/status/10"><time>Earlier</time></a></div>';
  const [post] = capture(article('alice', '20', 'Commentary', quote));
  assert.equal(post.text, 'Commentary\n\nhttps://x.com/alice/status/10');
  assert.equal(post.hasQuoteCard, true);
});
