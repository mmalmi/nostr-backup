import { readOnlyStore } from '../src/blocks.ts';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { backupMedia, readMediaFile } from '../src/media-files.ts';
import { DexieStore } from '@hashtree/dexie';
import { unzipSync, strFromU8 } from 'fflate';
import { NostrEventStore } from '@hashtree/nostr';
import { capturePosts } from '../src/x.ts';
import { hex, unhex, xTemplate } from '../src/model.ts';
import { append, dump, openArchive, stagePosts } from '../src/archive.ts';
import { syncHistory } from '../src/relays.ts';
import { profileHTML } from './fixtures.ts';

async function check() {
  const result = document.querySelector('output')!;
  const check = (value: unknown, label: string) => {
    if (!value) throw Error(label);
    const li = document.createElement('li');
    li.textContent = label;
    document.querySelector('ol')!.append(li);
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
    await stagePosts(db, posts.map(post => ({ ...post, visibility: 'public' })));
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
      { kind: 1, tags: [], content: 'https://fixture.invalid/image.png', created_at: 10 },
      key,
    );
    const url = 'wss://fixture.invalid/';
    await syncHistory({
      db,
      url,
      pubkey,
      save: (items, p) => append(db, items, p),
      read: async (_, filter) => ({
        events: [event, native].filter((e) => e.created_at <= (filter.until ?? Infinity)),
        complete: true,
      }),
    });
    check((await db.count('events')) === 2, 'Imported relay history and deduplicated the X event');
    const media = new Uint8Array([1, 5, 7]);
    const stats = await backupMedia(db, {
      fetcher: async () => new Response(media, { headers: { 'Content-Type': 'image/png' } }),
    });
    check(stats.saved === 1, 'Saved attachment bytes in Hashtree IndexedDB');
    const archive = unzipSync(await dump(db, pubkey)),
      root = JSON.parse(strFromU8(archive['manifest.json'])).root;
    const store = new NostrEventStore(
      readOnlyStore(async (hash) => archive['blocks/' + hex(hash)] ?? null),
    );
    const notes = await store.query(
      { hash: unhex(root.hash), key: unhex(root.key) },
      { authors: pubkey },
      { strict: true },
    );
    check(
      notes.length === 2 && notes.some((n) => n.id === event.id),
      'Reopened the ZIP hashtree and queried both signed posts',
    );
    const [file] = JSON.parse(strFromU8(archive['media.json'])).files;
    const restored = await readMediaFile(
      { get: async (hash) => archive['blocks/' + hex(hash)] ?? null },
      file,
    );
    check(hex(restored) === hex(media), 'Restored the exact media bytes from the ZIP offline');
    result.textContent = 'Passed all seven browser checks';
  } finally {
    db.close();
    indexedDB.deleteDatabase(name);
    await DexieStore.deleteDatabase(name + '-media');
  }
}
check().catch((e) => {
  document.querySelector('output')!.textContent = 'FAILED: ' + e.message;
});
