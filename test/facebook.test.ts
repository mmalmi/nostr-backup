import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import { captureFacebookPosts, createFacebookCollector, publicFacebookPost, facebookPermalink, facebookProfile } from '../src/facebook.ts';
import type { SocialCapture } from '../src/types.ts';

const handle = 'example.page', owner = '123456789', id = 'pfbidExample123';
const url = 'https://www.facebook.com/' + handle + '/';
const photo = 'https://scontent.xx.fbcdn.net/v/t39.42/photo.jpg?oh=abc';
const permalink = url + 'posts/' + id;
const story = {
  __typename: 'Story', id: 'story-id', post_id: '654321', creation_time: 1704164645,
  actors: [{id: owner, url}], permalink_url: permalink,
  comet_sections: {
    content: {story: {id: 'story-id', post_id: '654321', message: {text: 'Two lines\nof my own.'}}},
    context_layout: {story: {comet_sections: {metadata: [
      {__typename: 'CometFeedStoryAudienceStrategy', story: {id: 'story-id', privacy_scope: {icon_image: {name: 'everyone'}}}},
    ]}}},
  },
  attachments: [{styles: {attachment: {media: {__typename: 'Photo', photo_image: {uri: photo}}}}}],
};
function documentAt(html: string, page = url) {
  const w = new Window({url: page, settings: {disableCSSFileLoading: true, disableJavaScriptFileLoading: true,
    disableJavaScriptEvaluation: true, disableComputedStyleRendering: true}});
  w.document.body.innerHTML = html;
  return w.document as unknown as Document;
}
function script(node: unknown, profile = owner) {
  // Anonymized projection of the signed-out Facebook Page timeline. Comments and
  // embedded stories do not belong to timeline_list_feed_units.edges.
  const data = {user: {id: profile, timeline_list_feed_units: {edges: [{node}]}}};
  return '<script type="application/json">' + JSON.stringify({require: [[{__bbox: {result: {data}}}]]}) + '</script>';
}
function mounted(name = handle, postURL = permalink) {
  return '<div role="article"><div data-ad-rendering-role="profile_name"><h2><a href="/' + name +
    '">Page</a></h2></div><a href="' + postURL + '" aria-label="19h">19h</a>' +
    '<div data-ad-rendering-role="story_message">signed-in content</div></div>';
}
function embed(name = handle, postId = id) {
  return '<div data-testid="newsFeedStream"><div role="feed"><a href="/' + name +
    '"><img aria-label="Page"></a><a href="/' + name + '/posts/' + postId +
    '"><abbr data-utime="1704164645">19h</abbr></a><a href="/photo.php?fbid=13"><img src="' +
    photo + '"></a><div data-testid="post_message"><p>Public text.</p><p>Second line.</p></div></div></div>';
}
const response = (html: string) => new Response(html, {headers: {'content-type': 'text/html; charset=utf-8'}});
const settled = () => new Promise(resolve => setTimeout(resolve, 0));

test('Facebook profile and post URLs require the correct host, profile and supported route', () => {
  assert.equal(facebookProfile(url), handle);
  assert.equal(facebookProfile('https://facebook.com/Example.Page/?ref=profile'), handle);
  assert.equal(facebookProfile('https://www.facebook.com/profile.php?id=' + owner), owner);
  for (const path of ['/groups', '/login.php', '/watch', '/groups/Example.Page', '/example.page/?sk=about'])
    assert.equal(facebookProfile('https://www.facebook.com' + path), undefined);
  assert.equal(facebookPermalink(permalink + '?mibextid=123', handle), id);
  assert.equal(facebookPermalink('/story.php?story_fbid=98765&id=' + owner, owner), '98765');
  for (const candidate of [permalink.replace(handle, 'someone'), permalink.replace('www.facebook.com', 'evil.test'),
      permalink.replace('https:', 'http:'), permalink.replace('www.', 'user:pass@www.'), url + 'photos/' + id])
    assert.equal(facebookPermalink(candidate, handle), undefined);
});

test('signed-out story data supplies original time, message, single author, attachment and its own audience', () => {
  const captured = captureFacebookPosts(documentAt(script(story)), url, handle);
  assert.deepEqual(captured, [{id, source: 'facebook', url: permalink, author: handle, time: story.creation_time,
    text: story.comet_sections.content.story.message.text, media: [photo], visibility: 'public'}]);
  const numericURL = 'https://www.facebook.com/profile.php?id=' + owner;
  const [numeric] = captureFacebookPosts(documentAt(script(story), numericURL), numericURL, owner);
  assert.equal(facebookPermalink(numeric.url, owner), id);
});

test('Facebook restricts unknown, friends-only, missing and mismatched audience data to local captures', () => {
  for (const [scope, visibility] of [['friends', 'private'], ['custom', 'private'], ['', 'unknown']]) {
    const copy = structuredClone(story);
    copy.comet_sections.context_layout.story.comet_sections.metadata[0].story.privacy_scope.icon_image.name = scope;
    assert.equal(captureFacebookPosts(documentAt(script(copy)), url, handle)[0].visibility, visibility);
  }
  const wrong = structuredClone(story);
  wrong.comet_sections.context_layout.story.comet_sections.metadata[0].story.id = 'unrelated';
  assert.equal(captureFacebookPosts(documentAt(script(wrong)), url, handle)[0].visibility, 'unknown');
});

test('foreign actors, wrong archive, nested stories, unready media and a logged-out login wall do not create posts', () => {
  for (const node of [{...story, actors: [{id: '456', url}]}, {...story, attached_story: story},
    {...story, actors: [...story.actors, ...story.actors]}, {...story, permalink_url: permalink.replace(handle, 'other')},
    {...story, creation_time: 0}, {...story, attachments: [{media: {__typename: 'Photo'}}]}, {...story, sponsored_data: {}}])
    assert.deepEqual(captureFacebookPosts(documentAt(script(node)), url, handle), []);
  assert.deepEqual(captureFacebookPosts(documentAt(script(story, 'different')), url, handle), []);
  assert.deepEqual(captureFacebookPosts(documentAt('<form>Log in</form>'), url, handle), []);
});

test('scroll fallback only uses anonymous, author-checked public embeds and retains no signed-in text', async () => {
  const captures: SocialCapture[] = [], calls: string[] = [];
  const collector = createFacebookCollector(posts => captures.push(...posts), async (link, options) => {
    const endpoint = new URL(String(link)); calls.push(endpoint.pathname);
    assert.equal(endpoint.searchParams.get('href'), permalink);
    assert.equal(options?.credentials, 'omit'); assert.equal(options?.redirect, 'error');
    assert.equal(options?.referrerPolicy, 'no-referrer');
    return response(embed());
  });
  const doc = documentAt(mounted() + mounted() + mounted('third.party'));
  collector.collect(doc, url, handle); await settled();
  collector.collect(doc, url, handle); await settled();
  assert.deepEqual(calls, ['/plugins/post.php']);
  assert.deepEqual(captures.map(p => [p.id, p.text, p.media, p.visibility]),
    [[id, 'Public text.\nSecond line.', [photo], 'public']]);
  collector.stop();
});

test('public embed preserves external links and marks video previews as posters', async () => {
  const html = embed().replace('Public text.', 'Read <a href="https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.org%2Fstory">the story</a>.')
    .replace('<div data-testid="post_message">', '<video poster="' + photo + '"></video><div data-testid="post_message">');
  const captures: SocialCapture[] = [];
  const collector = createFacebookCollector(posts => captures.push(...posts), async () => response(html));
  collector.collect(documentAt(mounted()), url, handle); await settled();
  assert.equal(captures[0].text, 'Read the story (https://example.org/story).\nSecond line.');
  assert.deepEqual(captures[0].posters, [photo]); collector.stop();
});

test('unavailable embeds, wrong authors or IDs, and cancelled in-flight reads never publish', async () => {
  const numeric = url + 'posts/654321';
  for (const result of ['<form>Log in</form>', embed('another.page'), embed(handle, '111111'),
      embed(handle, '654321').replace('Public text.', '<span class="text_exposed_hide">See more</span>')]) {
    const captures: SocialCapture[] = [];
    const collector = createFacebookCollector(posts => captures.push(...posts), async () => response(result));
    collector.collect(documentAt(mounted(handle, numeric)), url, handle); await settled();
    assert.deepEqual(captures, []); collector.stop();
  }
  let complete!: (reply: Response) => void;
  const captures: SocialCapture[] = [];
  const collector = createFacebookCollector(posts => captures.push(...posts), () => new Promise(resolve => {complete = resolve;}));
  collector.collect(documentAt(mounted()), url, handle); collector.stop(); complete(response(embed()));
  await settled(); assert.deepEqual(captures, []);
});

test('opaque post IDs require independent canonical proof when an embed has a numeric timestamp link', async () => {
  for (const [canonical, expected] of [[url + 'posts/sample-post/654321/', 1], [url + 'posts/sample-post/98765/', 0],
    ['https://evil.test/' + handle + '/posts/sample-post/654321/', 0], [url.replace(handle, 'another.page') + 'posts/sample-post/654321/', 0],
    ['', 0]] as const) {
    const posts: SocialCapture[] = [], calls: string[] = [];
    const collector = createFacebookCollector(batch => posts.push(...batch), async (link, options) => {
      calls.push(String(link)); assert.equal(options?.credentials, 'omit'); assert.equal(options?.redirect, 'error');
      return response(String(link) === permalink ? '<link rel="canonical" href="' + canonical + '">' : embed(handle, '654321'));
    });
    collector.collect(documentAt(mounted()), url, handle); await settled();
    assert.equal(calls.length, 2); assert.equal(calls[1], permalink);
    assert.equal(posts.length, expected); collector.stop();
  }
});

test('structured story wins over an embed and repeat scans do not redeliver it', async () => {
  let reads = 0; const captures: SocialCapture[] = [];
  const doc = documentAt(script(story) + mounted());
  const collector = createFacebookCollector(posts => captures.push(...posts), async () => {reads++; return response(embed());});
  collector.collect(doc, url, handle); collector.collect(doc, url, handle); await settled();
  assert.equal(reads, 0); assert.equal(captures.length, 1); collector.stop();
});

test('an own attached story preserves its own author and audience separately from the quoting post', () => {
  const childId = '12345';
  const child = {
    ...story,
    id: 'child',
    post_id: childId,
    permalink_url: url + 'posts/' + childId,
    comet_sections: {
      content: { story: { id: 'child', post_id: childId, message: { text: 'Quoted caption' } } },
      context_layout: {
        story: {
          comet_sections: {
            metadata: [
              {
                __typename: 'CometFeedStoryAudienceStrategy',
                story: { id: 'child', privacy_scope: { icon_image: { name: 'friends' } } },
              },
            ],
          },
        },
      },
    },
    attachments: [],
  };
  const parsed = captureFacebookPosts(
    documentAt(script({ ...story, attached_story: child })),
    url,
    handle,
  );
  assert.deepEqual(
    parsed.map((p) => [p.id, p.visibility]),
    [
      [childId, 'private'],
      [id, 'public'],
    ],
  );
  assert.ok(parsed[1].text.includes(child.permalink_url));
  assert.ok(!parsed[1].text.includes('Quoted caption'));
});

test('public Facebook embed separates nested own quote text, media, and original permalink', async () => {
  const nested = '<article><a href="/' + handle + '"><img aria-label="Page"></a><a href="/' + handle +
    '/posts/100"><abbr data-utime="1500000000"></abbr></a><div data-testid="post_message">Quoted only</div></article>';
  const body = embed().replace('<div role="feed">','<div role="feed"><article>').replace('</div></div></div>',
    '</div>' + nested + '</article></div></div>');
  const parsed = await publicFacebookPost(documentAt(''),permalink,handle,async()=>response(body),new AbortController().signal);
  assert.equal(parsed?.text, 'Public text.\nSecond line.\n\nhttps://www.facebook.com/' + handle + '/posts/100');
});
