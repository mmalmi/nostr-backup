import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';
import { checkXProof, contactsTemplate, findXMatches, identityTemplate, proofText, XRateLimited, xClaims } from '../src/x-identity.ts';
import { publicTweetHTML } from './fixtures.ts';

const secret = generateSecretKey(), pubkey = getPublicKey(secret);
const page = (author: string, id: string, text: string, status = 200) => {
  const response = new Response(status === 200 ? publicTweetHTML(author, id, text, 1700000000) : '', {
    status, headers: { 'Content-Type': 'text/html' },
  });
  Object.defineProperty(response, 'url', { value: 'https://x.com/' + author + '/status/' + id });
  return response;
};

test('claims come from NIP-39 i tags in kind 10011 and older kind 0 profiles', () => {
  const event = (kind: number, tags: string[][]) => finalizeEvent({ kind, created_at: 1, tags, content: '' }, secret);
  assert.deepEqual(xClaims(event(10011, [['i', 'twitter:Alice', '123'], ['i', 'github:alice', 'abc']])), [
    { pubkey, handle: 'alice', proof: '123', created_at: 1 },
  ]);
  assert.deepEqual(xClaims(event(0, [['i', 'twitter:bob', '456']])).map((c) => c.handle), ['bob']);
  // A proof must be a tweet ID, and the handle a valid X username.
  assert.deepEqual(xClaims(event(10011, [['i', 'twitter:alice', 'allsocial.me'], ['i', 'twitter:not valid!', '1']])), []);
  assert.deepEqual(xClaims(event(1, [['i', 'twitter:alice', '123']])), []);
});

test('a proof tweet must be by the claimed handle and name the claimant key', async () => {
  const claim = { pubkey, handle: 'alice', proof: '99', created_at: 1 };
  assert.equal(await checkXProof(claim, async () => page('alice', '99', proofText(pubkey))), true);
  // nostr.directory's older proofs use the hex key.
  assert.equal(await checkXProof(claim, async () => page('alice', '99', 'Verifying my account on nostr My Public Key: ' + pubkey)), true);
  // Someone copying another person's proof tweet ID fails: the tweet names a different key.
  const other = getPublicKey(generateSecretKey());
  assert.equal(await checkXProof(claim, async () => page('alice', '99', proofText(other))), false);
  assert.equal(await checkXProof(claim, async () => page('alice', '99', '', 404)), false);
  await assert.rejects(checkXProof(claim, async () => page('alice', '99', '', 429)), XRateLimited);
});

test('linking replaces only the X claim and following keeps existing contacts', () => {
  const previous = finalizeEvent({ kind: 10011, created_at: 1, content: '', tags: [
    ['i', 'github:alice', 'gist'], ['i', 'twitter:old', '1'],
  ] }, secret);
  assert.deepEqual(identityTemplate(previous, 'alice', '42').tags, [['i', 'github:alice', 'gist'], ['i', 'twitter:alice', '42'], ['client', 'Social Backup']]);
  assert.equal(identityTemplate(undefined, 'alice', '42').kind, 10011);
  const a = getPublicKey(generateSecretKey()), b = getPublicKey(generateSecretKey());
  const contacts = finalizeEvent({ kind: 3, created_at: 1, content: '{"relay":true}', tags: [['p', a, 'wss://r/'], ['t', 'nostr']] }, secret);
  const next = contactsTemplate(contacts, [a, b]);
  assert.equal(next.kind, 3);
  assert.equal(next.content, '{"relay":true}');
  assert.deepEqual(next.tags, [['p', a, 'wss://r/'], ['t', 'nostr'], ['p', b]]);
  assert.ok(proofText(pubkey).endsWith(npubEncode(pubkey)));
});

test('matching checks each claim once, ignores copied proofs and stops when X limits checks', async () => {
  const keys = [generateSecretKey(), generateSecretKey(), generateSecretKey()];
  const claim = (key: Uint8Array, kind: number, handle: string, proof: string, created_at = 1) =>
    finalizeEvent({ kind, created_at, content: kind === 0 ? '{"name":"Real Alice"}' : '', tags: [['i', 'twitter:' + handle, proof]] }, key);
  const events = [
    claim(keys[0], 0, 'alice', '1'),
    claim(keys[1], 10011, 'alice', '1'), // copies Alice's proof
    claim(keys[2], 10011, 'carol', '3'),
  ];
  const remembered = new Map<string, boolean>();
  const checked: string[] = [];
  const run = (limitAfter = Infinity) =>
    findXMatches(['Alice', 'carol'], {
      query: async (identities) => events.filter((e) => e.tags.some(([, id]) => identities.includes(id))),
      remembered: async (c) => remembered.get(c.pubkey + c.handle),
      remember: async (c, ok) => void remembered.set(c.pubkey + c.handle, ok),
      check: async (c) => {
        if (checked.length >= limitAfter) throw new XRateLimited();
        checked.push(c.handle);
        return c.pubkey === getPublicKey(keys[0]);
      },
    });
  const limited = await run(1);
  // The first check passes, the second is limited, and the rest wait for the next run.
  assert.equal(limited.unchecked, 2);
  const result = await run();
  assert.deepEqual(result.matches, [{ handle: 'alice', pubkey: getPublicKey(keys[0]), name: 'Real Alice' }]);
  assert.equal(result.unchecked, 0);
  assert.deepEqual(checked, ['alice', 'alice', 'carol']);
  assert.equal((await run()).matches.length, 1);
  assert.equal(checked.length, 3);
});
