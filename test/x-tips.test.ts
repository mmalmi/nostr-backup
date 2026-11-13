import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { lightningAddress, tipInvoice } from '../src/x-tips.ts';

const secret = generateSecretKey(), tipper = generateSecretKey();
const profile = (content: object) => finalizeEvent({ kind: 0, created_at: 1, tags: [], content: JSON.stringify(content) }, secret);
// A 21 sat invoice: amount 210n in the human-readable part. The rest only needs the right length.
const invoice = (amount: string) => 'lnbc' + amount + '1p' + 'q'.repeat(60);

test('a lightning address must look like name@domain', () => {
  assert.equal(lightningAddress(profile({ lud16: 'Alice@Wallet.example' })), 'alice@wallet.example');
  assert.equal(lightningAddress(profile({ lud16: 'not an address' })), undefined);
  assert.equal(lightningAddress(profile({ name: 'x' })), undefined);
});

test('a tip zaps the recipient with a signed request and checks the invoice amount', async () => {
  const requests: string[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(url.href);
    assert.equal(init?.credentials, 'omit');
    if (url.pathname === '/.well-known/lnurlp/alice')
      return Response.json({ tag: 'payRequest', callback: 'https://wallet.example/pay', minSendable: 1000, maxSendable: 1e9, allowsNostr: true, nostrPubkey: getPublicKey(secret) });
    const zap = JSON.parse(url.searchParams.get('nostr')!);
    assert.equal(url.searchParams.get('amount'), '21000');
    assert.deepEqual(zap.tags.find(([t]: string[]) => t === 'p'), ['p', getPublicKey(secret)]);
    assert.equal(zap.content, 'https://x.com/alice/status/9');
    assert.equal(zap.pubkey, getPublicKey(tipper));
    return Response.json({ pr: invoice(url.searchParams.get('lie') ? '1000n' : '210n') });
  };
  const options = {
    profile: profile({ lud16: 'alice@wallet.example' }),
    sats: 21,
    comment: 'https://x.com/alice/status/9',
    relays: ['wss://relay.example/'],
    sign: (template: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(template, tipper),
    fetcher,
  };
  assert.equal(await tipInvoice(options), invoice('210n'));
  assert.equal(requests[0], 'https://wallet.example/.well-known/lnurlp/alice');
  // An invoice for a different amount than chosen is refused.
  await assert.rejects(tipInvoice({ ...options, fetcher: (i, init) => fetcher(String(i).includes('/pay') ? String(i) + '&lie=1' : i, init) }), /amount/);
  await assert.rejects(tipInvoice({ ...options, sats: 0 }), /amount/);
});

test('tip buttons appear only for verified accounts and open the wallet with a checked invoice', async () => {
  const { Window } = await import('happy-dom');
  const { article } = await import('./fixtures.ts');
  const { createTipButtons } = await import('../src/x-tip-buttons.ts');
  const window = new Window({ url: 'https://x.com/home' });
  const doc = window.document as unknown as Document;
  const bar = '<div role="group"><button>Like</button></div>';
  doc.body.innerHTML = article('alice', '9', 'Great post', bar) + article('bob', '10', 'Hi', bar) + article('me', '11', 'Mine', bar);
  const sent: Record<string, unknown>[] = [];
  const target = { pubkey: getPublicKey(secret), lightning: 'alice@wallet.example' };
  const tips = createTipButtons(async (message) => {
    sent.push(message as Record<string, unknown>);
    if (message.type === 'tipTargets') return { ok: true, value: { alice: target, bob: null, me: { ...target, lightning: 'me@wallet.example' } } };
    if (message.type === 'tipRate') return { ok: true, value: 100000 };
    return { ok: true, value: 'lnbc210n1pinvoice' };
  }, doc);
  try {
    tips.scan('me');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const buttons = Array.from(doc.querySelectorAll('[data-social-backup-tip]'));
    assert.deepEqual(buttons.map((b) => b.getAttribute('data-social-backup-tip')), ['alice', 'me']);
    assert.deepEqual(sent[0], { type: 'tipTargets', handles: ['alice', 'bob', 'me'] });
    // Scanning again adds nothing and asks about nothing new.
    tips.scan('me');
    assert.equal(doc.querySelectorAll('[data-social-backup-tip]').length, 2);
    assert.equal(sent.length, 1);
    (buttons[0] as HTMLElement).click();
    const box = () => doc.body.lastElementChild!.shadowRoot!.querySelector('.box')!;
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Amounts show a fiat estimate from the page's currency.
    assert.match(box().querySelector('button small')!.textContent!, /^(≈|<) /);
    (box().querySelector('button') as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(sent.find((m) => m.type === 'tipInvoice'), { type: 'tipInvoice', handle: 'alice', sats: 21, post: '9' });
    assert.equal(box().querySelector('a')!.getAttribute('href'), 'lightning:lnbc210n1pinvoice');
    // Your own posts show where tips go instead of amounts.
    (buttons[1] as HTMLElement).click();
    assert.match(box().textContent!, /me@wallet\.example/);
    assert.equal(box().querySelectorAll('button').length, 0);
  } finally {
    await window.happyDOM.abort();
  }
});
