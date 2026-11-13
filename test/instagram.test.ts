import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import { captureInstagramPosts, createInstagramCollector, instagramPermalink, instagramProfile } from '../src/instagram.ts';
import type { SocialCapture } from '../src/types.ts';

const profile = 'https://www.instagram.com/alice/';
const post = 'https://www.instagram.com/p/A_b-7/';
const image = 'https://scontent.cdninstagram.com/v/photo.jpg';
const video = 'https://video.fna.fbcdn.net/v/clip.mp4';
const byline = '<div class="Header"><a class="Username" href="' + profile + '">alice</a></div>';
const photo = '<a class="EmbeddedMedia" href="' + post + '"><img class="EmbeddedMediaImage" src="' + image + '"></a>';
const caption = '<div class="Caption"><a class="CaptionUsername" href="' + profile + '">alice</a><br>First<br>Second <a>#hello</a><div class="CaptionComments">Other user comment</div></div>';
function embed(type = 'GraphImage', content = photo, rich?: unknown) {
  const script = rich ? '<script>PolarisEmbedSimple.init(' + JSON.stringify({ contextJSON: JSON.stringify({ gql_data: { shortcode_media: rich } }) }) + ')</script>' : '';
  return '<div class="Embed" data-permalink="' + post + '" data-media-type="' + type + '">' + byline +
    '<div class="Content">' + content + '</div>' + caption + '</div>' + script;
}
function metadata(url = post) {
  return '<link rel="canonical" href="' + url + '"><meta property="og:url" content="' + url +
    '"><meta property="og:type" content="article"><meta property="og:description" content="First - @alice on January 2, 2025">';
}
function fixture(t: { after(fn: () => unknown): void }, html: string) {
  const win = new Window({ url: profile, settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  t.after(() => win.happyDOM.abort());
  win.document.body.innerHTML = html;
  return win.document as unknown as Document;
}
function response(html: string, url: string) {
  const result = new Response(html, { headers: { 'content-type': 'text/html' } });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}
const links = '<main><a href="/alice/p/A_b-7/?tracking=one"><img></a><a href="/p/A_b-7/"></a>' +
  '<a href="/bob/p/foreign/"></a><a href="https://evil.test/p/foreign/"></a></main>';

test('Instagram accepts owned profile and post paths and strips tracking from capture', () => {
  assert.equal(instagramProfile(profile + 'reels/'), 'alice');
  assert.equal(instagramProfile('https://www.instagram.com/A.B_/p/Example/'), 'a.b_');
  assert.equal(instagramPermalink('https://www.instagram.com/alice/reel/A_b-7/', 'alice'), 'A_b-7');
  assert.equal(instagramPermalink(post, 'alice'), 'A_b-7');
  for (const url of ['https://www.instagram.com/bob/p/A_b-7/', post + 'embed/', 'https://evil.test/p/A_b-7/', post.replace('https:', 'http:')])
    assert.equal(instagramPermalink(url, 'alice'), undefined);
  for (const url of ['https://www.instagram.com/accounts/', 'https://evil.test/alice', 'https://user@www.instagram.com/alice/'])
    assert.equal(instagramProfile(url), undefined);
});

test('mounted Instagram records can back up private media but cannot authorize publication', t => {
  const node = { code: 'A_b-7', media_type: 8, user: { username: 'alice', is_private: true }, taken_at: 1735771234,
    caption: { text: 'Private text' }, carousel_media: [
      { media_type: 1, display_uri: image }, { media_type: 2, video_versions: [{ url: video }] },
    ] };
  const html = links + '<script type="application/json">' + JSON.stringify({ payload: [{ ...node, code: 'unused' }, node] }) + '</script>';
  const doc = fixture(t, html);
  const [capture] = captureInstagramPosts(doc, profile, 'alice');
  assert.deepEqual(capture, { source: 'instagram', id: 'A_b-7', author: 'alice', visibility: 'private',
    time: 1735771234, url: post, text: 'Private text', media: [image, video] });
  assert.deepEqual(captureInstagramPosts(doc, profile, 'bob'), []);
  assert.deepEqual(captureInstagramPosts(doc, 'https://evil.test/alice/', 'alice'), []);
  const publicProfile = fixture(t, html.replace('"is_private":true', '"is_private":false').replace('"is_private":true', '"is_private":false'));
  assert.equal(captureInstagramPosts(publicProfile, post, 'alice')[0].visibility, 'unknown');
});

test('anonymous embed is the source of the published caption, ordered media and post date', async t => {
  const doc = fixture(t, links);
  for (const kind of ['GraphImage', 'GraphSidecar', 'GraphVideo']) {
    const graph = { __typename: kind, shortcode: 'A_b-7', owner: { username: 'alice' }, is_video: true,
      video_url: video, edge_media_to_caption: { edges: [{ node: { text: 'Official embed caption' } }] },
      edge_sidecar_to_children: { edges: [{ node: { is_video: false, display_url: image } },
        { node: { is_video: true, video_url: video } }] } };
    const calls: string[] = [];
    const done = Promise.withResolvers<SocialCapture>(); let received = 0;
    const collector = createInstagramCollector(posts => { received += posts.length; done.resolve(posts[0]); }, async (url, init) => {
      assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error'); assert.equal(init?.referrerPolicy, 'no-referrer');
      calls.push(String(url));
      return response(calls.length === 1 ? embed(kind, photo, graph) : metadata(), String(url));
    });
    t.after(() => collector.stop());
    collector.collect(doc, profile, 'alice');
    collector.collect(doc, profile, 'alice');
    const saved = await done.promise;
    collector.collect(doc, profile, 'alice');
    assert.equal(received, 1);
    assert.deepEqual(calls, [post + 'embed/captioned/', post]);
    assert.deepEqual(saved.media, kind === 'GraphImage' ? [image] : kind === 'GraphVideo' ? [video] : [image, video]);
    assert.equal(saved.text, kind === 'GraphImage' ? 'First\nSecond #hello' : 'Official embed caption');
    assert.equal(saved.visibility, 'public');
    assert.equal(saved.time, Date.UTC(2025, 0, 2) / 1000); assert.equal(saved.timePrecision, 'day');
    collector.stop();
  }
});

test('a login wall, foreign owner, incomplete carousel, redirect, or unknown date cannot authorize public delivery', async t => {
  const doc = fixture(t, links);
  for (const [first, second, redirected] of [
    ['<main>Log in</main>', metadata(), false],
    [embed().replaceAll(profile, 'https://www.instagram.com/bob/'), metadata(), false],
    [embed('GraphSidecar'), metadata(), false],
    [embed().replace(image, 'https://attacker.test/a.jpg'), metadata(), false],
    [embed(), metadata('https://www.instagram.com/p/different/'), false],
    [embed(), metadata().replace('January 2, 2025', 'a Thursday'), false],
    [embed(), metadata(), true],
  ] as const) {
    let calls = 0, captured = false;
    const collector = createInstagramCollector(() => { captured = true; }, async url => {
      calls++;
      return response(calls === 1 ? first : second, redirected ? 'https://www.instagram.com/accounts/login/' : String(url));
    });
    collector.collect(doc, profile, 'alice');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(captured, false);
    const before = calls;
    collector.collect(doc, profile, 'alice');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, before);
    collector.stop();
  }
});

test('stopping capture discards even a late public response', async t => {
  const doc = fixture(t, links);
  const waiting = Promise.withResolvers<Response>();
  let captured = false;
  const collector = createInstagramCollector(() => { captured = true; }, async url =>
    String(url) === post ? response(metadata(), post) : waiting.promise);
  collector.collect(doc, profile, 'alice');
  collector.stop();
  waiting.resolve(response(embed(), post + 'embed/captioned/'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(captured, false);
});
