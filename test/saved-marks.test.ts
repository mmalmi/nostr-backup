import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { article } from './fixtures.ts';
import { createSavedMarks } from '../src/saved-marks.ts';

const MARK = '[data-social-backup-saved]';
// Elements are compared with ===: printing one in a failed assertion walks the whole document.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
function page(t: TestContext, url: string, html: string) {
  const window = new Window({ url, settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, disableJavaScriptEvaluation: true } });
  t.after(() => window.happyDOM.abort());
  window.document.body.innerHTML = html;
  return window.document as unknown as Document;
}
/** A backup holding `saved`, and the IDs each lookup asked about. */
function backup(saved: string[]) {
  const asked: string[][] = [];
  const ask = async (ids: string[]) => {
    asked.push(ids);
    return { ok: true, value: ids.filter((id) => saved.includes(id)) };
  };
  return { asked, ask, saved };
}

test('X marks only the user’s own saved posts, and joins the mark to their tip button', async (t) => {
  const bar = '<div role="group"><button>Like</button></div>';
  const doc = page(t, 'https://x.com/home', article('me', '1', 'Saved', bar) + article('me', '2', 'Not yet', bar) + article('bob', '3', 'Theirs', bar));
  const store = backup(['1', '3']);
  const marks = createSavedMarks('x', store.ask, doc);
  marks.scan('me');
  await settle();
  // Other people's posts are never asked about.
  assert.deepEqual(store.asked, [['1', '2']]);
  const found = Array.from(doc.querySelectorAll(MARK));
  assert.equal(found.length, 1);
  assert.equal(found[0].getAttribute('data-social-backup-saved'), '1');
  assert.ok(found[0].parentElement === doc.querySelector('article [role="group"]'));
  assert.equal(found[0].getAttribute('aria-label'), 'Saved in your backup');
  assert.equal(found[0].querySelectorAll('svg').length, 2);
  // Scanning again changes nothing and asks nothing new.
  marks.scan('me');
  await settle();
  assert.equal(store.asked.length, 1);
  assert.ok(doc.querySelector(MARK) === found[0]);
  // Once the second post is captured, its mark appears.
  store.saved.push('2');
  marks.refresh(['2']);
  marks.scan('me');
  await settle();
  assert.deepEqual(store.asked[1], ['2']);
  assert.equal(doc.querySelectorAll(MARK).length, 2);
  // The user's own tip button already shows the flower, so only the check joins it and its label survives.
  const tip = doc.createElement('button');
  tip.setAttribute('data-social-backup-tip', 'me');
  tip.innerHTML = '<svg></svg><span>$5</span>';
  doc.querySelector('article [role="group"]')!.append(tip);
  marks.scan('me');
  const joined = tip.querySelector(MARK)!;
  assert.equal(joined.querySelectorAll('svg').length, 1);
  assert.ok(joined.nextElementSibling === tip.querySelector('span'));
  assert.equal(tip.querySelector('span')!.textContent, '$5');
  assert.equal(doc.querySelectorAll(MARK).length, 2);
  // X reuses a row for someone else's post: the mark goes away.
  doc.querySelectorAll('article')[1].querySelector('a')!.setAttribute('href', '/bob/status/9');
  marks.scan('me');
  assert.equal(doc.querySelectorAll(MARK).length, 1);
  marks.reset();
  assert.equal(doc.querySelectorAll(MARK).length, 0);
});

test('a failed lookup leaves the page alone and is not repeated at once', async (t) => {
  const doc = page(t, 'https://x.com/me', article('me', '1', 'Saved', '<div role="group"></div>'));
  let asked = 0;
  const marks = createSavedMarks('x', async () => {
    asked++;
    throw Error('Extension reloaded');
  }, doc);
  marks.scan('me');
  await settle();
  marks.scan('me');
  await settle();
  assert.equal(asked, 1);
  assert.equal(doc.querySelectorAll(MARK).length, 0);
});

test('Instagram marks saved profile tiles and an open post’s date', async (t) => {
  const tile = (path: string) => '<div style="position:relative"><a href="' + path + '"><div style="position:relative"><img src="https://scontent.cdninstagram.com/a.jpg"></div></a></div>';
  const doc = page(t, 'https://www.instagram.com/me.example/', '<main>' + tile('/me.example/p/AAA111/') + tile('/me.example/reel/BBB222/') + tile('/other/p/CCC333/') + tile('/p/DDD444/') +
    '<div><a href="/me.example/p/AAA111/"><span><time datetime="2026-11-15T12:38:16.000Z">4 minutes ago</time></span></a></div></main>');
  const store = backup(['AAA111']);
  const marks = createSavedMarks('instagram', store.ask, doc);
  marks.scan('me.example');
  await settle();
  assert.deepEqual(store.asked, [['AAA111', 'BBB222']]);
  const found = Array.from(doc.querySelectorAll(MARK));
  assert.deepEqual(found.map((node) => node.getAttribute('data-kind')), ['tile', 'date']);
  // The tile's mark sits in the tile's own box; the date's mark follows the date, on its line.
  assert.ok(found[0].parentElement === doc.querySelector('a[href="/me.example/p/AAA111/"] > div'));
  assert.match(found[0].getAttribute('style') ?? '', /position:\s*absolute/);
  assert.equal(found[1].previousElementSibling?.tagName, 'TIME');
  marks.scan('me.example');
  assert.equal(doc.querySelectorAll(MARK).length, 2);
});

test('an Instagram tile without a box of its own gets no mark', async (t) => {
  const doc = page(t, 'https://www.instagram.com/me.example/', '<main><div><a href="/me.example/p/AAA111/"><div><img src="https://scontent.cdninstagram.com/a.jpg"></div></a></div></main>');
  const marks = createSavedMarks('instagram', backup(['AAA111']).ask, doc);
  marks.scan('me.example');
  await settle();
  assert.equal(doc.querySelectorAll(MARK).length, 0);
});

test('Facebook marks a saved post beside its date', async (t) => {
  const post = (name: string, id: string) => '<div role="article"><div data-ad-rendering-role="profile_name"><h2><a href="/' + name + '">Page</a></h2></div>' +
    '<span><a href="https://www.facebook.com/' + name + '/posts/' + id + '">19h</a></span><div data-ad-rendering-role="story_message">Text</div></div>';
  const doc = page(t, 'https://www.facebook.com/example.page/', post('example.page', 'pfbidSaved123') + post('example.page', 'pfbidOther123') + post('someone.else', 'pfbidTheirs123'));
  const store = backup(['pfbidSaved123', 'pfbidTheirs123']);
  const marks = createSavedMarks('facebook', store.ask, doc);
  marks.scan('example.page');
  await settle();
  assert.deepEqual(store.asked, [['pfbidSaved123', 'pfbidOther123']]);
  const found = Array.from(doc.querySelectorAll(MARK));
  assert.equal(found.length, 1);
  assert.equal(found[0].parentElement?.getAttribute('href'), 'https://www.facebook.com/example.page/posts/pfbidSaved123');
  assert.equal(found[0].parentElement?.textContent, '19h');
});
