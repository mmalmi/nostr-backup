import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nsecEncode, npubEncode, noteEncode } from 'nostr-tools/nip19';
import { append, openArchive } from '../src/archive.ts';
import { readProfile } from '../src/profile.ts';
import { loginKey } from '../src/model.ts';

test('login validates encoded keys and rejects bad checksums and invalid private scalars', () => {
  const secret = generateSecretKey(),
    owner = getPublicKey(secret);
  const npub = npubEncode(owner),
    nsec = nsecEncode(secret);
  assert.deepEqual(loginKey('  ' + npub.toUpperCase() + '\n'), { type: 'watch', key: owner });
  assert.deepEqual(loginKey(nsec), { type: 'login', key: nsec });
  for (const key of [
    npub.slice(0, -1),
    nsec.slice(0, -1) + '!',
    nsecEncode(new Uint8Array(32)),
    '0'.repeat(64),
    'f'.repeat(64),
    noteEncode(owner),
  ]) {
    assert.throws(() => loginKey(key), { message: 'Invalid key.' });
  }
});

test('profile uses the latest replaceable metadata and tolerates malformed profile fields', async () => {
  const db = await openArchive(crypto.randomUUID());
  const secret = generateSecretKey(),
    owner = getPublicKey(secret);
  const profile = (created_at: number, content: string) =>
    finalizeEvent({ kind: 0, created_at, content, tags: [] }, secret);
  try {
    assert.equal(await readProfile(db, owner), undefined);
    await append(
      db,
      [
        {
          event: profile(
            2,
            JSON.stringify({
              name: 'new',
              display_name: 'Newest',
              picture: 'https://images.example/avatar.png',
            }),
          ),
        },
        { event: profile(1, '{"name":"old"}') },
      ],
      owner,
    );
    assert.deepEqual(await readProfile(db, owner), {
      name: 'new',
      displayName: 'Newest',
      picture: 'https://images.example/avatar.png',
    });
    assert.equal(await readProfile(db, getPublicKey(generateSecretKey())), undefined);
    await append(
      db,
      [
        {
          event: profile(3, '{"name":42,"display_name":[],"picture":"javascript:alert(1)"}'),
        },
      ],
      owner,
    );
    assert.deepEqual(await readProfile(db, owner), {
      name: '',
      displayName: '',
      picture: undefined,
    });
    await append(db, [{ event: profile(4, '{broken') }], owner);
    assert.equal(await readProfile(db, owner), undefined);
    await append(db, [{ event: profile(5, 'null') }], owner);
    assert.equal(await readProfile(db, owner), undefined);
  } finally {
    db.close();
  }
});
