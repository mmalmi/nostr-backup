import 'fake-indexeddb/auto';
import test from 'node:test';
import { PropertySymbol } from 'happy-dom';
import { signedInvoice, signedZap } from './tip-fixtures.ts';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { invoiceDetails, lightningAddress, matchingNote, tipInvoice, verifyTipInvoice } from '../src/x-tips.ts';

const secret = generateSecretKey(), tipper = generateSecretKey();
const profile = (content: object) => finalizeEvent({ kind: 0, created_at: 1, tags: [], content: JSON.stringify(content) }, secret);
const privateRoot = (element: Element) => Reflect.get(element, PropertySymbol.shadowRoot) as ShadowRoot;
function userClick(element: Element) {
  const event = new element.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true, composed: true });
  Object.defineProperty(event, 'isTrusted', { value: true });
  element.dispatchEvent(event);
}

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
    assert.equal(zap.content, '');
    assert.equal(zap.pubkey, getPublicKey(tipper));
    return Response.json({ pr: signedInvoice(url.searchParams.get('lie') ? 100 : 21, url.searchParams.get('nostr')!) });
  };
  const options = {
    profile: profile({ lud16: 'alice@wallet.example' }),
    sats: 21,
    relays: ['wss://relay.example/'],
    sign: (template: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(template, tipper),
    fetcher,
  };
  assert.equal(invoiceDetails((await tipInvoice(options)).invoice)?.msats, 21000);
  assert.equal(requests[0], 'https://wallet.example/.well-known/lnurlp/alice');
  // An invoice for a different amount than chosen is refused.
  await assert.rejects(tipInvoice({ ...options, fetcher: (i, init) => fetcher(String(i).includes('/pay') ? String(i) + '&lie=1' : i, init) }), /amount/);
  await assert.rejects(tipInvoice({ ...options, sats: 0 }), /amount/);
});

test('a text-only Cashu mint invoice is explicitly reissued as ordinary Lightning and authenticated against its exact provider status', async () => {
  const address = 'alice@wallet.example', verifyUrl = 'https://wallet.example/status';
  let crossOrigin = false, badCommitment = false, latest = '', substituted = false, settled = false, preimage: string | null = null;
  const calls: string[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.redirect, 'error');
    if (url.pathname.startsWith('/.well-known/')) return Response.json({ tag: 'payRequest', callback: 'https://wallet.example/pay',
      minSendable: 1000, maxSendable: 100000, metadata: '[]', allowsNostr: true, nostrPubkey: getPublicKey(secret) });
    if (url.pathname === '/pay') {
      const zap = url.searchParams.has('nostr');
      calls.push(zap ? 'zap' : 'lightning');
      latest = signedInvoice(21, zap ? 'Mint quote one' : 'Mint quote two', undefined, !badCommitment);
      return Response.json({ pr: latest, verify: crossOrigin ? 'https://other.example/status' : verifyUrl });
    }
    assert.equal(url.href, verifyUrl);
    calls.push('verify');
    return Response.json({ status: 'OK', settled, preimage, pr: substituted ? signedInvoice(21, 'wrong invoice') : latest });
  };
  const options = { profile: profile({ lud16: address }), sats: 21, relays: [], fetcher,
    sign: (template: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(template, tipper) };
  const result = await tipInvoice(options);
  assert.deepEqual(result, { invoice: latest, kind: 'lightning', verifyUrl });
  assert.deepEqual(calls, ['zap', 'lightning', 'verify']);
  settled = true;
  assert.equal(await verifyTipInvoice(verifyUrl, latest, fetcher), true);
  preimage = '00'.repeat(32);
  await assert.rejects(verifyTipInvoice(verifyUrl, latest, fetcher), /invalid payment proof/);
  preimage = null;
  await assert.rejects(tipInvoice(options), /new unpaid invoice/);
  settled = false;
  substituted = true;
  await assert.rejects(tipInvoice(options), /confirm this invoice/);
  substituted = false;
  crossOrigin = true;
  await assert.rejects(tipInvoice(options), /signed zap request/);
  crossOrigin = false;
  badCommitment = true;
  calls.length = 0;
  await assert.rejects(tipInvoice(options), /signed zap request/);
  assert.deepEqual(calls, ['zap']);
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
    if (message.type === 'tipMarks') return { ok: true, value: message.targets.map(() => 0) };
    if (message.type === 'tipTargets') return { ok: true, value: { alice: target, bob: null, me: { ...target, lightning: 'me@wallet.example' } } };
    if (message.type === 'tipProfile') return { ok: true, value: { ...target, walletEnabled: true, lightning: message.handle === 'me' ? 'me@wallet.example' : target.lightning } };
    if (message.type === 'tipBalance') return { ok: true, value: 0 };
    if (message.type === 'tipRate') return { ok: true, value: 100000 };
    if (message.type === 'tipPost') return { ok: true, value: { note: 'ab'.repeat(32), sats: 1234, tips: 3, ownSats: 0, ownTips: 0 } };
    return { ok: true, value: { invoice: 'lnbc210n1pinvoice', kind: 'zap' } };
  }, doc);
  try {
    tips.scan('me');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const buttons = Array.from(doc.querySelectorAll('[data-social-backup-tip]'));
    // The user's own post gets no tip button.
    assert.deepEqual(buttons.map((b) => b.getAttribute('data-social-backup-tip')), ['alice']);
    // Like X's action bar: the Social Backup flower alone, named by its tooltip.
    assert.deepEqual(buttons.map((b) => b.textContent), ['']);
    assert.ok(buttons[0].querySelector('svg'));
    assert.equal(buttons[0].getAttribute('title'), 'Tip @alice with Bitcoin');
    assert.deepEqual(sent[0], { type: 'tipTargets', handles: ['alice', 'bob', 'me'] });
    // Scanning again adds nothing and asks about nothing new.
    tips.scan('me');
    assert.equal(doc.querySelectorAll('[data-social-backup-tip]').length, 1);
    assert.deepEqual(sent.map(m => m.type), ['tipTargets', 'tipMarks']);
    (buttons[0] as HTMLElement).click();
    assert.equal(sent.length, 2); // X cannot initiate a lookup with a synthetic click.
    userClick(buttons[0]);
    const box = () => privateRoot(doc.body.lastElementChild!).querySelector('.box')!;
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Amounts are in the page's currency, here 0.10 at 100,000 per bitcoin, with no secondary amount.
    assert.match(box().querySelector('.row button')!.textContent!, /^👍 \D?0[.,]10/);
    assert.equal(box().querySelector('.balance')!.textContent, 'Wallet balance · 0 sats');
    assert.equal(doc.body.textContent!.includes('Wallet balance'), false);
    userClick(box().querySelector('.balance')!);
    assert.deepEqual(sent.at(-1), {type: 'openTipWallet'});
    await new Promise(resolve => setTimeout(resolve, 0));
    userClick(buttons[0]);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.match(box().querySelector('.address')!.textContent!, /alice@wallet\.example/);
    // Opening the popover looks for this post's Nostr copy, with its time and opening text.
    const lookup = sent.find((m) => m.type === 'tipPost')!;
    assert.equal(lookup.post, '9');
    assert.equal(lookup.text, 'Great post');
    assert.equal(lookup.time, Math.floor(Date.parse('2024-01-02T03:04:05Z') / 1000));
    assert.match(box().querySelector('.onNostr')!.textContent!, /^\D?1[.,]23\D* from 3 other tips$/);
    // Once the popover found the post's tips, its button shows their total.
    assert.match(privateRoot(buttons[0].querySelector('span')!).textContent!, /^\D?1[.,]23\D*$/);
    (box().querySelector('.row button') as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(sent.find((m) => m.type === 'tipInvoice'), { type: 'tipInvoice', handle: 'alice', ...target, sats: 100, post: '9' });
    assert.match(box().querySelector('p b')!.textContent!, /^\D?0[.,]10\D*$/);
    assert.doesNotMatch(box().textContent!, /sats/i);
    assert.equal(box().querySelector('a')!.getAttribute('href'), 'lightning:lnbc210n1pinvoice');
    (box().querySelector('.cashu') as HTMLElement).click();
    assert.deepEqual(sent.at(-1), { type: 'openTipWallet', invoice: 'lnbc210n1pinvoice' });
    // A QR code lets a phone wallet pay the same invoice.
    assert.ok(box().querySelector('.qr svg'));
    // A click elsewhere closes the popover, which also ends its check for the payment.
    doc.body.click();
    assert.equal(doc.body.lastElementChild!.shadowRoot, null);
  } finally {
    tips.reset();
    await window.happyDOM.abort();
  }
});

test('custom amounts use whole sats and the ordinary menu respects the chosen payment method and available balance', async () => {
  const { Window } = await import('happy-dom');
  const { article } = await import('./fixtures.ts');
  const { createTipButtons } = await import('../src/x-tip-buttons.ts');
  const window = new Window({ url: 'https://x.com/home' }), doc = window.document as unknown as Document;
  doc.body.innerHTML = article('alice', '9');
  const pubkey = getPublicKey(secret), invoice = 'lnbc210n1pinvoice';
  const invoices: number[] = [], opened: string[] = [];
  let balance: number | Promise<number> = 200;
  const tips = createTipButtons(async msg => {
    switch (msg.type) {
      case 'tipTargets': return {ok:true,value:{alice:{pubkey,proof:'23'}}};
      case 'tipMarks': return {ok:true,value:[0]};
      case 'tipProfile': return {ok:true,value:{pubkey,lightning:'alice@wallet.example',walletEnabled:true}};
      case 'tipBalance': return {ok:true,value:await balance};
      case 'tipRate': return {ok:true,value:100000};
      case 'tipPost': return {ok:true,value:{sats:0,tips:0,ownSats:0,ownTips:0}};
      case 'tipInvoice': invoices.push(msg.sats); return {ok:true,value:{invoice,kind:'lightning'}};
      case 'openTipWallet': if (msg.invoice) opened.push(msg.invoice); return {ok:true};
      default: return {ok:false};
    }
  }, doc);
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  const open = async () => {
    userClick(doc.querySelector('[data-social-backup-tip]')!);
    await tick();
    return privateRoot(doc.body.lastElementChild!).querySelector('.box')!;
  };
  const submit = async (box: Element, value: string) => {
    box.querySelector('input')!.value = value;
    box.querySelector('form')!.dispatchEvent(new doc.defaultView!.Event('submit', {bubbles:true,cancelable:true}));
    await tick();
  };
  try {
    tips.scan(); await tick();
    let box = await open();
    assert.equal(box.querySelector('select')!.value, 'cashu');
    for (const bad of ['', '-5', '0', '1.5', '1e2', 'abc', '1000001']) {
      await submit(box, bad);
      assert.equal(box.querySelector('input')!.getAttribute('aria-invalid'), 'true');
    }
    assert.equal(invoices.length, 0);
    await submit(box, '137');
    assert.deepEqual(invoices, [137]);
    assert.deepEqual(opened, [invoice]);
    assert.equal(box.querySelector('p b')?.textContent, '137 sats');
    box = await open();
    box.querySelector('select')!.value = 'external';
    (box.querySelector('.row button') as HTMLElement).click();
    await tick();
    assert.equal(opened.length, 1);
    assert.ok(box.querySelector('.qr'));
    assert.equal(box.querySelector('a')!.getAttribute('href'), 'lightning:' + invoice);
    assert.equal(box.querySelector('.cashu'), null);
    box = await open();
    await submit(box, '201'); // Greater than the funded balance.
    assert.equal(opened.length, 1);
    assert.ok(box.querySelector('.qr'));
    balance = 0;
    box = await open();
    assert.equal(box.querySelector('select'), null);
    await submit(box, '200');
    assert.equal(opened.length, 1);
    let release!: (v:number) => void;
    balance = new Promise(resolve => {release = resolve;});
    box = await open();
    assert.ok(box.querySelector('.row button'));
    await submit(box, '21');
    release(500);
    await tick();
    assert.equal(opened.length, 1); // Late balance cannot change the selected method.
    assert.deepEqual(invoices, [137,100,201,200,21]);
  } finally { tips.reset(); await window.happyDOM.abort(); }
});

test('only an intentional short gesture on the same visible untipped post requests one quick tip', async t => {
  const { Window } = await import('happy-dom');
  const { article } = await import('./fixtures.ts');
  const { createTipButtons } = await import('../src/x-tip-buttons.ts');
  const window = new Window({url:'https://x.com/home'}), doc = window.document as unknown as Document;
  doc.body.innerHTML = article('alice','9');
  const pubkey = getPublicKey(secret), account = getPublicKey(tipper);
  const quick: unknown[] = [];
  let marks = 0, menus = 0, fail = false;
  const tips = createTipButtons(async m => {
    switch(m.type) {
      case 'tipTargets': return {ok:true,value:{alice:{pubkey,proof:'23'}}};
      case 'tipMarks': return {ok:true,value:[marks]};
      case 'tipProfile': menus++; return {ok:true,value:{pubkey,lightning:'alice@wallet.example'}};
      case 'tipPost': return {ok:true,value:{sats:marks,ownSats:marks,tips:Number(!!marks),ownTips:Number(!!marks)}};
      case 'quickTip':
        quick.push(m);
        return fail ? {ok:false,error:'Wallet balance is too low.'} : {ok:true,value:{state:'opened'}};
      default: return {ok:false};
    }
  },doc);
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  let flower: HTMLElement;
  const rectangle = {left:10,top:10,right:30,bottom:30,width:20,height:20} as DOMRect;
  const prepare = async (sats: number) => {
    tips.useQuickTip({account,sats}); tips.scan(); await tick();
    flower = doc.querySelector('[data-social-backup-tip]')!;
    const svg = flower.querySelector('svg')!;
    svg.getBoundingClientRect = () => rectangle;
    svg.checkVisibility = () => true;
    doc.elementFromPoint = () => svg;
    flower.closest('article')!.getBoundingClientRect = () => rectangle;
  };
  const pointer = (name:string, init: PointerEventInit = {}, trusted = true) => {
    const e = new doc.defaultView!.PointerEvent(name, {bubbles:true,cancelable:true,composed:true,pointerType:'mouse',
      isPrimary:true,pointerId:1,clientX:20,clientY:20,button:0,buttons:name === 'pointerdown' ? 1 : 0,detail:1,...init});
    if (trusted) Object.defineProperty(e,'isTrusted',{value:true});
    flower.dispatchEvent(e);
  };
  const tap = (detail=1) => { pointer('pointerdown'); pointer('pointerup'); pointer('click',{detail}); };
  t.mock.timers.enable({apis:['setTimeout']});
  try {
    await prepare(21);
    pointer('pointerdown',{},false); pointer('pointerup',{},false); pointer('click',{},false);
    t.mock.timers.tick(550);
    assert.equal(quick.length,0);
    // A click event without its trusted down/up pair cannot spend.
    pointer('click'); t.mock.timers.tick(550);
    assert.equal(quick.length,0);
    const cancel = (interrupt:()=>void) => {
      pointer('pointerdown'); interrupt(); pointer('pointerup'); pointer('click'); t.mock.timers.tick(550);
    };
    cancel(()=>pointer('pointermove',{clientX:50}));
    cancel(()=>pointer('pointercancel'));
    cancel(()=>doc.dispatchEvent(new doc.defaultView!.Event('scroll')));
    tap(); tap(2); t.mock.timers.tick(550);
    assert.equal(menus,0); assert.equal(quick.length,0);
    pointer('pointerdown'); t.mock.timers.tick(510); await tick();
    assert.equal(menus,1);
    pointer('pointerup'); pointer('click'); t.mock.timers.tick(550);
    assert.equal(menus,1); assert.equal(quick.length,0);
    pointer('click',{shiftKey:true}); userClick(flower!); await tick();
    assert.equal(menus,3);
    tap(); tips.useQuickTip({account,sats:22}); t.mock.timers.tick(550);
    assert.equal(quick.length,0);
    await prepare(22);
    pointer('pointerdown');
    const link = flower!.closest('article')!.querySelector('time')!.closest('a')!;
    link.setAttribute('href','/bob/status/9');
    pointer('pointerup'); pointer('click'); t.mock.timers.tick(550);
    assert.equal(quick.length,0);
    link.setAttribute('href','/alice/status/9');
    tap(); t.mock.timers.tick(510); await tick();
    assert.deepEqual(quick,[{type:'quickTip',account,sats:22,handle:'alice',pubkey,post:'9'}]);
    marks=21; await prepare(23); tap(); t.mock.timers.tick(550); await tick();
    assert.equal(quick.length,1);
    assert.ok(privateRoot(doc.body.lastElementChild!).querySelector('form'));
    marks=0; fail=true; await prepare(24); tap(); t.mock.timers.tick(550); await tick();
    assert.equal(quick.length,2);
    const box = privateRoot(doc.body.lastElementChild!).querySelector('.box')!;
    assert.match(box.querySelector('[role=alert]')!.textContent!,/balance is too low/);
    assert.ok(box.querySelector('form'));
    t.mock.timers.tick(3000); assert.equal(quick.length,2);
  } finally { tips.reset(); t.mock.timers.reset(); await window.happyDOM.abort(); }
});

test('your own profile keeps a Tip button that pays your own wallet, and your posts get none', async () => {
  const { Window } = await import('happy-dom');
  const { article } = await import('./fixtures.ts');
  const { createTipButtons } = await import('../src/x-tip-buttons.ts');
  const window = new Window({ url: 'https://x.com/me' });
  const doc = window.document as unknown as Document;
  doc.body.innerHTML = '<div data-testid="UserName"><div><span>Me</span></div></div>' + article('me', '11', 'Mine', '<div role="group"><button>Like</button></div>');
  const target = { pubkey: getPublicKey(secret), lightning: 'me@wallet.example' };
  const sent: Record<string, unknown>[] = [];
  const tips = createTipButtons(async (message) => {
    sent.push(message as Record<string, unknown>);
    if (message.type === 'tipTargets') return { ok: true, value: { me: target } };
    if (message.type === 'tipProfile') return { ok: true, value: target };
    if (message.type === 'tipRate') return { ok: true, value: 100000 };
    if (message.type === 'tipPost') return { ok: true, value: { sats: 0, tips: 0, ownSats: 0, ownTips: 0 } };
    return { ok: true, value: { invoice: 'lnbc210n1pinvoice', kind: 'zap' } };
  }, doc);
  try {
    tips.scan('me');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const buttons = Array.from(doc.querySelectorAll('[data-social-backup-tip]'));
    assert.deepEqual(buttons.map((b) => b.textContent), ['Tip']);
    assert.ok(buttons[0].closest('[data-testid="UserName"]'));
    assert.equal(buttons[0].getAttribute('title'), 'Tip @me with Bitcoin');
    userClick(buttons[0]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const box = () => privateRoot(doc.body.lastElementChild!).querySelector('.box')!;
    assert.equal(box().querySelector('.balance'), null);
    assert.equal(sent.some(m => m.type === 'tipBalance'), false);
    assert.match(box().querySelector('.address')!.textContent!, /me@wallet\.example/);
    (box().querySelector('.row button') as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(sent.find((m) => m.type === 'tipInvoice'), { type: 'tipInvoice', handle: 'me', ...target, sats: 100 });
    assert.equal(box().querySelector('.cashu'), null);
    assert.ok(box().querySelector('.qr svg'));
    assert.equal(box().querySelector('.alt')!.textContent, 'Copy invoice');
    assert.equal(box().querySelector('a')!.getAttribute('href'), 'lightning:lnbc210n1pinvoice');
  } finally {
    tips.reset();
    await window.happyDOM.abort();
  }
});

test('a verified profile links to its Nostr profile once the proof is checked again', async () => {
  const { Window } = await import('happy-dom');
  const { createTipButtons } = await import('../src/x-tip-buttons.ts');
  const { npubEncode } = await import('nostr-tools/nip19');
  const window = new Window({ url: 'https://x.com/alice' });
  const doc = window.document as unknown as Document;
  doc.body.innerHTML = '<div data-testid="UserName"><div><span>Alice</span></div></div>';
  const pubkey = getPublicKey(secret);
  let linked = true;
  const tips = createTipButtons(async (message) => {
    if (message.type === 'tipTargets') return { ok: true, value: { alice: { pubkey, lightning: 'alice@wallet.example' } } };
    if (message.type === 'nostrLink') return linked ? { ok: true, value: { pubkey } } : { ok: false, error: 'The Nostr link changed. Try again.' };
    return { ok: false, error: 'unexpected' };
  }, doc);
  try {
    tips.scan('me');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const pills = Array.from(doc.querySelectorAll('[data-testid="UserName"] button'));
    assert.deepEqual(pills.map((b) => b.textContent), ['Tip', 'Nostr ↗']);
    // Both pills are the same height, whether or not they have an icon.
    assert.deepEqual(pills.map((b) => (b as HTMLElement).style.height), ['28px', '28px']);
    const box = () => privateRoot(doc.body.lastElementChild!).querySelector('.box')!;
    userClick(pills[1]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const link = box().querySelector('a')!;
    assert.equal(link.getAttribute('href'), 'https://iris.to/' + npubEncode(pubkey));
    assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
    // A revoked or changed link shows why instead of linking.
    linked = false;
    userClick(pills[1]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(box().querySelector('a'), null);
    assert.match(box().textContent!, /changed/);
  } finally {
    tips.reset();
    await window.happyDOM.abort();
  }
});

test('tip amounts use the currency chosen in the Tips settings', async () => {
  const { Window } = await import('happy-dom');
  const { createTipButtons } = await import('../src/x-tip-buttons.ts');
  const window = new Window({ url: 'https://x.com/alice' });
  const doc = window.document as unknown as Document;
  doc.body.innerHTML = '<div data-testid="UserName"><div><span>Alice</span></div></div>';
  const target = { pubkey: getPublicKey(secret), lightning: 'alice@wallet.example' };
  const rates: string[] = [];
  const tips = createTipButtons(async (message) => {
    if (message.type === 'tipTargets') return { ok: true, value: { alice: target } };
    if (message.type === 'tipProfile') return { ok: true, value: target };
    if (message.type === 'tipRate') return (rates.push(message.currency as string), { ok: true, value: 10000000 });
    return { ok: false, error: 'unexpected' };
  }, doc);
  try {
    tips.useCurrency('JPY');
    tips.scan('me');
    await new Promise((resolve) => setTimeout(resolve, 10));
    userClick(doc.querySelector('[data-testid="UserName"] button')!);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const box = privateRoot(doc.body.lastElementChild!).querySelector('.box')!;
    // Yen presets are scaled: about ¥10, ¥100 and ¥500.
    assert.match(box.querySelector('.row button')!.textContent!, /¥\s?10\b/);
    assert.deepEqual(rates, ['JPY']);
  } finally {
    tips.reset();
    await window.happyDOM.abort();
  }
});

test('tip buttons still appear if X drops its test IDs and action bar', async () => {
  const { Window } = await import('happy-dom');
  const { createTipButtons } = await import('../src/x-tip-buttons.ts');
  const window = new Window({ url: 'https://x.com/home' });
  const doc = window.document as unknown as Document;
  doc.body.innerHTML = '<article><a href="/alice/status/9"><time datetime="2024-01-02T03:04:05Z">Jan 2</time></a><p>Hi</p></article>';
  const asked: unknown[] = [];
  const tips = createTipButtons(async (message) => {
    asked.push(message);
    return message.type === 'tipTargets' ? { ok: true, value: { alice: { pubkey: getPublicKey(secret), proof: '1' } } } : { ok: false, error: 'no' };
  }, doc);
  try {
    tips.scan('me');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(asked[0], { type: 'tipTargets', handles: ['alice'] });
    // With no action bar, the button goes at the end of the post.
    assert.equal(doc.querySelector('article > button[data-social-backup-tip]')?.getAttribute('data-social-backup-tip'), 'alice');
  } finally {
    tips.reset();
    await window.happyDOM.abort();
  }
});

test('a settled tip marks only its own flower on a new page; scrolling stays local and account changes clear it', async () => {
  const { Window } = await import('happy-dom');
  const { article } = await import('./fixtures.ts');
  const { createTipButtons } = await import('../src/x-tip-buttons.ts');
  const window = new Window({ url: 'https://x.com/home' });
  const doc = window.document as unknown as Document;
  doc.body.innerHTML = article('alice', '9', 'Tipped once') + article('alice', '10', 'Another post');
  const pubkey = getPublicKey(secret);
  const actions: string[] = [];
  let paid = true;
  const tips = createTipButtons(async message => {
    actions.push(message.type);
    if (message.type === 'tipTargets') return { ok: true, value: { alice: { pubkey, proof: '1' } } };
    if (message.type === 'tipMarks') return { ok: true, value: message.targets.map(t => paid && t.post === '9' ? 21 : 0) };
    return { ok: false };
  }, doc);
  const label = (post: string) => privateRoot(doc.querySelector('[data-social-backup-post="' + post + '"] span')!);
  try {
    tips.scan();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(label('9').textContent, '✓');
    assert.equal(label('9').firstElementChild!.getAttribute('title'), 'You tipped 21 sats');
    assert.equal(label('10').textContent, '');
    assert.doesNotMatch(doc.body.innerHTML, /You tipped|✓/);
    tips.reset();
    paid = false;
    tips.scan();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(label('9').textContent, '');
    assert.deepEqual(actions, ['tipTargets', 'tipMarks', 'tipTargets', 'tipMarks']);
  } finally { tips.reset(); await window.happyDOM.abort(); }
});

test('a post matches its tagged Nostr copy, or one from the same minute with the same opening text', () => {
  const url = 'https://x.com/alice/status/9';
  const note = (content: string, created_at: number, tags: string[][] = []) =>
    finalizeEvent({ kind: 1, created_at, content, tags }, secret);
  const tagged = note('anything', 5, [['i', url]]);
  const near = note('Great post about Nostr https://t.co/x', 1030);
  assert.equal(matchingNote([near, tagged], url, 1000, 'Great post about Nostr'), tagged);
  assert.equal(matchingNote([near], url, 1000, 'Great post about Nostr https://t.co/abc'), near);
  assert.equal(matchingNote([near], url, 1200, 'Great post about Nostr'), undefined);
  assert.equal(matchingNote([near], url, 1000, 'Something else entirely'), undefined);
  assert.equal(matchingNote([near], url, 1000, 'Great'), undefined);
});

test('verified own receipts and Cashu settlements merge by payment hash and persist offline', async () => {
  const { openArchive } = await import('../src/archive.ts');
  const { readTipMarks, settleOwnTip, summarizeTips } = await import('../src/tip-history.ts');
  const name = 'tip-test-' + crypto.randomUUID();
  let db = await openArchive(name);
  const owner = getPublicKey(tipper), pubkey = getPublicKey(secret), provider = generateSecretKey(), note = 'ab'.repeat(32);
  const target = { pubkey, post: '9', note };
  const own = signedZap(tipper, provider, pubkey, 21, note), other = signedZap(secret, provider, pubkey, 5, note);
  const forged = signedZap(tipper, generateSecretKey(), pubkey, 10, note).receipt;
  const mismatched = finalizeEvent({ ...own.receipt, tags: own.receipt.tags.map(tag =>
    tag[0] === 'bolt11' ? ['bolt11', other.invoice] : tag) }, provider);
  const missingRequest = finalizeEvent({ ...own.receipt, tags: own.receipt.tags.filter(t => t[0] !== 'description') }, provider);
  try {
    let result = await summarizeTips(db, { ...target, invoice: own.invoice }, owner, [other.receipt, forged, mismatched, missingRequest], getPublicKey(provider));
    assert.deepEqual(result, { note, tips: 1, sats: 5, ownSats: 0, ownTips: 0, paid: false });
    const tip = { ...target, paymentHash: invoiceDetails(own.invoice)!.paymentHash, sats: 21 };
    await Promise.all([settleOwnTip(db, tip), settleOwnTip(db, tip)]);
    result = await summarizeTips(db, { ...target, invoice: own.invoice }, owner, [own.receipt, other.receipt, own.receipt, other.receipt], getPublicKey(provider));
    assert.deepEqual(result, { note, tips: 2, sats: 26, ownSats: 21, ownTips: 1, paid: true });
    db.close();
    db = await openArchive(name);
    assert.deepEqual(await readTipMarks(db, [target, { pubkey, post: '10' }, { pubkey }]), [21, 0, 0]);
    const profileZap = signedZap(tipper, provider, pubkey, 3);
    const issued = async () => ({ pubkey, post: '10' });
    const profile = await summarizeTips(db, { pubkey }, owner, [profileZap.receipt], getPublicKey(provider), issued);
    assert.equal(profile.ownTips, 0);
    assert.deepEqual(await readTipMarks(db, [{ pubkey, post: '10' }]), [3]);
    // A profile receipt by somebody else must not mark a post without a matching Nostr copy.
    assert.equal((await summarizeTips(db, { pubkey, post: '11' }, owner, [profileZap.receipt], getPublicKey(provider))).tips, 0);
  } finally { db.close(); }
});

test('external invoice checks rotate across outstanding payments and bind their account and exact target', async () => {
  const { openArchive } = await import('../src/archive.ts');
  const { rememberInvoice, reconcileTipInvoices } = await import('../src/wallet-intent.ts');
  const { readTipMarks } = await import('../src/tip-history.ts');
  const db = await openArchive('tip-pending-' + crypto.randomUUID());
  const account = getPublicKey(tipper), pubkey = getPublicKey(secret);
  const target = { account, pubkey, post: '9' };
  const invoices: string[] = [], seen: number[] = [];
  const fetcher = async (input: RequestInfo | URL) => {
    const index = Number(new URL(String(input)).pathname.slice(1));
    seen.push(index);
    return Response.json({ status: 'OK', settled: index === 0, pr: invoices[index], preimage: null });
  };
  try {
    for (let i = 0; i < 9; i++) {
      const invoice = signedInvoice(21, 'invoice-' + i);
      invoices.push(invoice);
      await rememberInvoice(db, invoiceDetails(invoice)!.paymentHash, { ...target, tab: 1, handle: 'alice', lightning: 'alice@wallet.example',
        sats: 21, invoice, verifyUrl: 'https://wallet.example/' + i });
    }
    await reconcileTipInvoices(db, { ...target, post: '10', invoice: invoices[0] }, fetcher);
    await reconcileTipInvoices(db, { ...target, account: pubkey, invoice: invoices[0] }, fetcher);
    assert.equal(seen.length, 0);
    await reconcileTipInvoices(db, { ...target, invoice: invoices[8] }, fetcher);
    assert.deepEqual(seen, [8]);
    seen.length = 0;
    await reconcileTipInvoices(db, target, fetcher);
    assert.equal(seen.length, 6);
    await reconcileTipInvoices(db, target, fetcher);
    assert.equal(new Set(seen).size, 9);
    assert.deepEqual(await readTipMarks(db, [target]), [21]);
  } finally { db.close(); }
});

test('Firefox tips need payment consent, including after revocation', async t => {
  const { paymentConsent } = await import('../src/tip-consent.ts');
  let granted = false;
  const permissions = {
    contains: async () => granted,
    request: async (details: object) => {
      assert.deepEqual(details, { data_collection: ['financialAndPaymentInfo'] });
      return granted;
    },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'browser');
  Object.defineProperty(globalThis, 'browser', { configurable: true, value: {
    runtime: { getManifest: () => ({ browser_specific_settings: { gecko: {} } }) }, permissions,
  } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'browser', previous);
    else Reflect.deleteProperty(globalThis, 'browser');
  });
  assert.equal(await paymentConsent(true), false);
  granted = true;
  assert.equal(await paymentConsent(true), true);
  assert.equal(await paymentConsent(), true);
  granted = false;
  assert.equal(await paymentConsent(), false);
});
