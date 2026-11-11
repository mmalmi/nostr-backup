import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { unzipSync, strFromU8 } from 'fflate';
import { NostrEventStore } from '@hashtree/nostr';
import { capturePosts } from '../src/x.js';
import { hex, unhex, xTemplate } from '../src/model.js';
import { append, dump, openArchive, stagePosts } from '../src/archive.js';
import { syncHistory } from '../src/relays.js';
import { profileHTML } from './fixtures.js';

async function check() {
  const result = document.querySelector('output');
  const check = (value, label) => {
    if (!value) throw Error(label);
    const li = document.createElement('li');
    li.textContent = label;
    document.querySelector('ol').append(li);
  };
  const key = generateSecretKey(),
    pubkey = getPublicKey(key),
    name = 'fixture-' + crypto.randomUUID();
  let db = await openArchive(name);
  try {
    const doc = new DOMParser().parseFromString(profileHTML, 'text/html');
    const posts = capturePosts(doc, 'https://x.com/alice', 'alice');
    check(
      posts.length === 1 && posts[0].text === 'Hello\nbackup 🌲',
      'Captured own post and excluded the foreign author',
    );
    await stagePosts(db, posts);
    db.close();
    db = await openArchive(name);
    const [draft] = await db.getAll('drafts');
    check(draft.id === '123', 'Recovered unsigned capture after reopening IndexedDB');
    const event = finalizeEvent(xTemplate(draft, 'alice'), key);
    await append(db, [{ event, source: 'x:123', targets: ['wss://test.invalid/'] }], pubkey);
    check(
      (await db.count('drafts')) === 0 && (await db.count('outbox')) === 1,
      'Signed the X post and retained pending delivery',
    );
    const native = finalizeEvent(
      { kind: 1, tags: [], content: 'Native note', created_at: 10 },
      key,
    );
    const url = 'wss://fixture.invalid/';
    await syncHistory({
      db,
      url,
      pubkey,
      save: (items, p) => append(db, items, p),
      read: async (_, filter) => ({
        events: [event, native].filter((e) => e.created_at <= filter.until),
        complete: true,
      }),
    });
    check((await db.count('events')) === 2, 'Imported relay history and deduplicated the X event');
    const archive = unzipSync(await dump(db, pubkey)),
      root = JSON.parse(strFromU8(archive['manifest.json'])).root;
    const store = new NostrEventStore({
      get: async (hash) => archive['blocks/' + hex(hash)] ?? null,
    });
    const notes = await store.query(
      { hash: unhex(root.hash), key: unhex(root.key) },
      { authors: pubkey },
      { strict: true },
    );
    check(
      notes.length === 2 && notes.some((n) => n.id === event.id),
      'Reopened the ZIP hashtree and queried both signed posts',
    );
    result.textContent = 'Passed all five browser checks';
  } finally {
    db.close();
    indexedDB.deleteDatabase(name);
  }
}
check().catch((e) => {
  document.querySelector('output').textContent = 'FAILED: ' + e.message;
});
