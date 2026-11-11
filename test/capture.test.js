import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { capturePosts } from '../src/x.js';
import { xTemplate, relayList } from '../src/model.js';
import { profileHTML, article } from './fixtures.js';
function capture(html, url = 'https://x.com/alice', handle = 'alice') {
  const win = new Window({
    url,
    settings: {
      disableCSSFileLoading: true,
      disableJavaScriptFileLoading: true,
      disableComputedStyleRendering: true,
    },
  });
  win.document.body.innerHTML = html;
  const posts = capturePosts(win.document, url, handle);
  win.happyDOM.abort();
  return posts;
}
test('signed-in profile, current route and outer permalink must agree', () => {
  assert.equal(capture(profileHTML).length, 1);
  for (const path of ['/bob', '/home', '/alice/status/123', '/alice/likes', '/search?q=alice'])
    assert.deepEqual(capture(profileHTML, 'https://x.com' + path), []);
  assert.deepEqual(capture(profileHTML.replace('href="/alice"', 'href="/bob"')), []);
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
  assert.equal(capture(html).at(-1).text, 'https://pbs.twimg.com/media/abc.jpg');
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
