import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { incomingQuotes, receivingMint } from '../src/npub-incoming.ts';
import { updateReceivingAddress, receivingAddress } from '../src/receiving-address.ts';
const key = generateSecretKey();
const owner = getPublicKey(key);
const sign = (e: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(e, key);

test('npub.cash scopes authorization to the path, paginates paid quotes, and refuses incomplete history', async () => {
  const offsets: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'npub.cash');
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.redirect, 'error');
    const auth = new Headers(init?.headers).get('Authorization')!;
    const event = JSON.parse(atob(auth.slice(6)));
    assert.ok(verifyEvent(event));
    assert.equal(event.pubkey, owner);
    assert.equal(event.kind, 27235);
    assert.deepEqual(event.tags, [
      ['u', url.origin + url.pathname],
      ['method', 'GET'],
    ]);
    offsets.push(url.searchParams.get('offset')!);
    return Response.json({
      error: false,
      data: {
        quotes: [
          {
            quoteId: offsets.join('-'),
            mintUrl: 'https://mint.example',
            amount: 21,
            state: 'PAID',
            locked: false,
          },
        ],
      },
      metadata: { total: 2 },
    });
  };
  let count = 0;
  for await (const page of incomingQuotes(sign, fetcher)) count += page.length;
  assert.equal(count, 2);
  assert.deepEqual(offsets, ['0', '1']);
  await assert.rejects(async () => {
    for await (const _ of incomingQuotes(sign, async () =>
      Response.json({ error: false, data: { quotes: [] }, metadata: { total: 1 } }),
    )) {
    }
  }, /incomplete/);
  assert.equal(
    await receivingMint(owner, sign, async () =>
      Response.json({ error: false, data: { user: { pubkey: owner, mintUrl: 'https://mint.example/' } } }),
    ),
    'https://mint.example',
  );
  await assert.rejects(
    receivingMint(owner, sign, async () =>
      Response.json({ error: false, data: { user: { pubkey: 'other', mintUrl: 'https://mint.example' } } }),
    ),
  );
});

test('publishing or removing the default address preserves existing metadata and protects other Lightning addresses', () => {
  const content = { name: 'Ada', picture: 'https://example.org/p.png', custom: { a: 1 } };
  const event = sign({
    kind: 0,
    created_at: 2000000000,
    tags: [['client', 'test']],
    content: JSON.stringify(content),
  });
  const added = updateReceivingAddress(event, true);
  assert.deepEqual(JSON.parse(added.content), { ...content, lud16: receivingAddress(owner) });
  assert.deepEqual(added.tags, event.tags);
  assert.ok(added.created_at > event.created_at);
  assert.deepEqual(JSON.parse(updateReceivingAddress(sign(added), false).content), content);
  for (const custom of [{ lud16: 'alice@example.org' }, { lud06: 'lnurl1test' }]) {
    const current = sign({ ...added, content: JSON.stringify({ ...content, ...custom }) });
    assert.throws(() => updateReceivingAddress(current, true));
    assert.throws(() => updateReceivingAddress(current, false));
  }
});
