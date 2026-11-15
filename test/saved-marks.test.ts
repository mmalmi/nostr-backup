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
/** A backup holding `saved`, of which `shared` have a public copy, with the IDs each lookup asked about and the posts opened. */
function backup(saved: string[], shared = saved) {
  const asked: string[][] = [];
  const opened: string[] = [];
  const ask = async (ids: string[]) => {
    asked.push(ids);
    return { ok: true, value: ids.filter((id) => saved.includes(id)).map((id) => ({ id, onNostr: shared.includes(id) })) };
  };
  return { asked, ask, saved, shared, opened, open: (id: string) => void opened.push(id) };
}
function fire(node: Element, type: 'click' | 'keydown', key?: string) {
  const view = node.ownerDocument.defaultView as unknown as { MouseEvent: typeof MouseEvent; KeyboardEvent: typeof KeyboardEvent };
  const event = type === 'click' ? new view.MouseEvent(type, { bubbles: true, cancelable: true }) :
    new view.KeyboardEvent(type, { key, bubbles: true, cancelable: true });
  node.dispatchEvent(event);
  return event;
}

test('X marks only the user’s own saved posts, and a click on the mark opens the public copy', async (t) => {
  const bar = '<div role="group"><button>Like</button></div>';
  const doc = page(t, 'https://x.com/home', article('me', '1', 'Saved', bar) + article('me', '2', 'Not yet', bar) + article('bob', '3', 'Theirs', bar));
  const store = backup(['1', '3']);
  const marks = createSavedMarks('x', store.ask, store.open, doc);
  marks.scan('me');
  await settle();
  // Other people's posts are never asked about.
  assert.deepEqual(store.asked, [['1', '2']]);
  const found = Array.from(doc.querySelectorAll(MARK));
  assert.equal(found.length, 1);
  assert.equal(found[0].getAttribute('data-social-backup-saved'), '1');
  assert.ok(found[0].parentElement === doc.querySelector('article [role="group"]'));
  assert.equal(found[0].getAttribute('aria-label'), 'Backed up. See it on Iris');
  assert.equal(found[0].getAttribute('title'), 'Backed up. See it on Iris');
  assert.equal(found[0].getAttribute('role'), 'link');
  assert.equal(found[0].querySelectorAll('svg').length, 2);
  // The page holds no link to the copy. A click or Enter asks the extension to open it and stays off the page's own handlers.
  assert.equal(doc.querySelector('a[href*="iris.to"], a[href*="note1"]'), null);
  let reached = 0;
  doc.addEventListener('click', () => reached++);
  doc.addEventListener('keydown', () => reached++);
  assert.equal(fire(found[0].querySelector('svg')!, 'click').defaultPrevented, true);
  fire(found[0], 'keydown', 'Tab');
  assert.equal(fire(found[0], 'keydown', 'Enter').defaultPrevented, true);
  assert.deepEqual(store.opened, ['1', '1']);
  assert.equal(reached, 1);
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
  }, () => {}, doc);
  marks.scan('me');
  await settle();
  marks.scan('me');
  await settle();
  assert.equal(asked, 1);
  assert.equal(doc.querySelectorAll(MARK).length, 0);
});

test('a post kept on this device gets a mark that is not a link, until it has a public copy', async (t) => {
  const doc = page(t, 'https://x.com/me', article('me', '1', 'Mine', '<div role="group"></div>'));
  const store = backup(['1'], []);
  const marks = createSavedMarks('x', store.ask, store.open, doc);
  marks.scan('me');
  await settle();
  const local = doc.querySelector(MARK)!;
  assert.equal(local.getAttribute('role'), 'img');
  assert.equal(local.getAttribute('title'), 'Backed up on this device');
  assert.equal(local.hasAttribute('tabindex'), false);
  assert.equal(fire(local, 'click').defaultPrevented, false);
  assert.deepEqual(store.opened, []);
  // It is not asked about again at once, only after the post was captured again.
  marks.scan('me');
  await settle();
  assert.equal(store.asked.length, 1);
  // A post deleted from the backup loses its mark at the next lookup.
  store.saved.length = 0;
  marks.refresh(['1']);
  marks.scan('me');
  await settle();
  assert.equal(store.asked.length, 2);
  assert.equal(doc.querySelectorAll(MARK).length, 0);
  // Saved again with a public copy, its mark is a link.
  store.saved.push('1');
  store.shared.push('1');
  marks.refresh(['1']);
  marks.scan('me');
  await settle();
  assert.equal(store.asked.length, 3);
  assert.equal(doc.querySelectorAll(MARK).length, 1);
  assert.equal(doc.querySelector(MARK)!.getAttribute('role'), 'link');
});

test('without drawing, a scan still tells which of the user’s posts the backup lacks', async (t) => {
  const tile = (id: string) => '<div><a href="/me.example/p/' + id + '/"><div><img src="https://scontent.cdninstagram.com/a.jpg"></div></a></div>';
  const doc = page(t, 'https://www.instagram.com/me.example/', '<main>' + tile('AAA111') + tile('BBB222') + '</main>');
  const store = backup(['AAA111']);
  const marks = createSavedMarks('instagram', store.ask, store.open, doc);
  assert.deepEqual(marks.unsaved(), []);
  marks.scan('me.example', false);
  // Until the backup has answered, both posts count as not saved, with no time of an answer.
  assert.deepEqual(marks.unsaved(), [{ id: 'AAA111', checked: undefined }, { id: 'BBB222', checked: undefined }]);
  const before = Date.now();
  await settle();
  assert.equal(doc.querySelectorAll(MARK).length, 0);
  const missing = marks.unsaved();
  assert.deepEqual(missing.map((post) => post.id), ['BBB222']);
  assert.ok(missing[0].checked! >= before);
  // Once it is saved it is no longer missing. Tiles without a box of their own count too.
  store.saved.push('BBB222');
  marks.refresh(['BBB222']);
  marks.scan('me.example', false);
  await settle();
  assert.deepEqual(marks.unsaved(), []);
  marks.reset();
  assert.deepEqual(marks.unsaved(), []);
});

test('Instagram marks saved profile tiles and an open post’s date', async (t) => {
  const tile = (path: string) => '<div style="position:relative"><a href="' + path + '"><div style="position:relative"><img src="https://scontent.cdninstagram.com/a.jpg"></div></a></div>';
  const doc = page(t, 'https://www.instagram.com/me.example/', '<main>' + tile('/me.example/p/AAA111/') + tile('/me.example/reel/BBB222/') + tile('/other/p/CCC333/') + tile('/p/DDD444/') +
    '<div><a href="/me.example/p/AAA111/"><span><time datetime="2026-11-15T12:38:16.000Z">4 minutes ago</time></span></a></div></main>');
  const store = backup(['AAA111']);
  const marks = createSavedMarks('instagram', store.ask, store.open, doc);
  marks.scan('me.example');
  await settle();
  assert.deepEqual(store.asked, [['AAA111', 'BBB222']]);
  const found = Array.from(doc.querySelectorAll(MARK));
  assert.deepEqual(found.map((node) => node.getAttribute('data-kind')), ['tile', 'date']);
  // The tile's mark sits in the tile's own box; the date's mark follows the date, on its line.
  assert.ok(found[0].parentElement === doc.querySelector('a[href="/me.example/p/AAA111/"] > div'));
  assert.match(found[0].getAttribute('style') ?? '', /position:\s*absolute/);
  assert.equal(found[1].previousElementSibling?.tagName, 'TIME');
  // Both marks sit inside Instagram's link to the post. A click on a mark opens the copy and does not follow that link.
  assert.equal(fire(found[0], 'click').defaultPrevented, true);
  assert.equal(fire(found[1], 'click').defaultPrevented, true);
  assert.deepEqual(store.opened, ['AAA111', 'AAA111']);
  marks.scan('me.example');
  assert.equal(doc.querySelectorAll(MARK).length, 2);
});

test('an Instagram tile without a box of its own gets no mark', async (t) => {
  const doc = page(t, 'https://www.instagram.com/me.example/', '<main><div><a href="/me.example/p/AAA111/"><div><img src="https://scontent.cdninstagram.com/a.jpg"></div></a></div></main>');
  const marks = createSavedMarks('instagram', backup(['AAA111']).ask, () => {}, doc);
  marks.scan('me.example');
  await settle();
  assert.equal(doc.querySelectorAll(MARK).length, 0);
});

test('Facebook marks a saved post beside its date', async (t) => {
  const post = (name: string, id: string) => '<div role="article"><div data-ad-rendering-role="profile_name"><h2><a href="/' + name + '">Page</a></h2></div>' +
    '<span><a href="https://www.facebook.com/' + name + '/posts/' + id + '">19h</a></span><div data-ad-rendering-role="story_message">Text</div></div>';
  const doc = page(t, 'https://www.facebook.com/example.page/', post('example.page', 'pfbidSaved123') + post('example.page', 'pfbidOther123') + post('someone.else', 'pfbidTheirs123'));
  const store = backup(['pfbidSaved123', 'pfbidTheirs123']);
  const marks = createSavedMarks('facebook', store.ask, store.open, doc);
  marks.scan('example.page');
  await settle();
  assert.deepEqual(store.asked, [['pfbidSaved123', 'pfbidOther123']]);
  const found = Array.from(doc.querySelectorAll(MARK));
  assert.equal(found.length, 1);
  assert.equal(found[0].parentElement?.getAttribute('href'), 'https://www.facebook.com/example.page/posts/pfbidSaved123');
  assert.equal(found[0].parentElement?.textContent, '19h');
});
