import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { Window, type HTMLInputElement } from 'happy-dom';
import { svelte } from '../scripts/svelte.ts';
import type { Message } from '../src/types.ts';

const bundle = await build({ entryPoints: ['src/wallet-page.ts'], bundle: true, minify: true, write: false, format: 'iife', plugins: [svelte] });
const owner = 'ab'.repeat(32), id = '7590d25e-edc2-4511-b13b-0930c5618122';

async function until(check: () => boolean) {
  for (let n = 0; n < 50; n++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail('Wallet UI did not reach the expected state');
}

test('the wallet quotes on open, confirms the displayed fee only on click and recovers a pending payment on reopen', async t => {
  let state: 'ready' | 'pending' | 'paid' | undefined;
  let active = owner;
  const requests: Message[] = [];
  function mount() {
    const page = new Window({ url: 'https://extension.test/wallet.html#' + id });
    t.after(() => page.happyDOM.abort());
    page.document.body.innerHTML = '<main><div id="app"></div></main>';
    const payment = () => ({ id, invoice: 'test-invoice', sats: 21, fee: 2, state });
    Object.defineProperty(page, 'chrome', { value: {
      storage: { onChanged: { addListener() {} } },
      runtime: {
        async sendMessage(msg: Message) {
          requests.push(structuredClone(msg));
          if (msg.type === 'walletIdentity') return { ok: true, value: { pubkey: active, enabled: true, unlocked: true, autoReceive: false } };
          assert.equal(msg.account, owner);
          switch (msg.type) {
            case 'walletStatus':
              return { ok: true, value: { mint: 'https://mint.example', balance: 500, funding: [], payments: state ? [payment()] : [] } };
            case 'walletReview':
              return { ok: true, value: { account: owner, id, handle: 'alice', lightning: 'alice@example.com', sats: 21 } };
            case 'walletPrepare': state = 'ready'; break;
            case 'walletConfirm': state = 'pending'; break;
            case 'walletRefresh': state = 'paid'; break;
            default: throw Error('Unexpected wallet action ' + msg.type);
          }
          return { ok: true, value: payment() };
        },
      },
    } });
    page.eval(bundle.outputFiles[0].text);
    return page;
  }
  const page = mount();
  const button = (win: Window, name: string) => [...win.document.querySelectorAll('button')].find(b => b.textContent.trim() === name);
  await until(() => !!button(page, 'Confirm tip') && !button(page, 'Confirm tip')!.disabled);
  assert.match(page.document.body.textContent, /Maximum fee2 sats/);
  assert.match(page.document.body.textContent, /Maximum total23 sats/);
  assert.match(page.document.body.textContent, /alice@example.com/);
  assert.equal(requests.filter(r => r.type === 'walletConfirm').length, 0);
  button(page, 'Confirm tip')!.click();
  await until(() => !!button(page, 'Check payment'));
  assert.deepEqual(requests.filter(r => r.type === 'walletConfirm'), [{ type: 'walletConfirm', account: owner, id, maxFee: 2 }]);
  const reopened = mount();
  await until(() => !!button(reopened, 'Check payment'));
  assert.equal(requests.filter(r => r.type === 'walletPrepare').length, 1);
  button(reopened, 'Check payment')!.click();
  await until(() => reopened.document.body.textContent.includes('Payment complete'));
  assert.equal(requests.filter(r => r.type === 'walletConfirm').length, 1);
  active = 'cd'.repeat(32);
  reopened.dispatchEvent(new reopened.Event('focus'));
  await until(() => !!button(reopened, 'Reload wallet'));
  assert.ok(!reopened.document.body.textContent.includes('alice@example.com'));
});

test('a new wallet waits for consent and chosen mint before funding or inbox checks', async t => {
  const page = new Window({ url: 'https://extension.test/wallet.html' });
  t.after(() => page.happyDOM.abort());
  page.document.body.innerHTML = '<main><div id="app"></div></main>';
  const requests: Message[] = [];
  let enabled = false, mint: string | null = null, autoReceive = false, quickTipSats = 0;
  Object.defineProperty(page, 'chrome', { value: {
    storage: { onChanged: { addListener() {} } },
    runtime: {
      async sendMessage(msg: Message) {
        requests.push(structuredClone(msg));
        switch (msg.type) {
          case 'walletPreferences': enabled = msg.enabled; autoReceive = msg.autoReceive; break;
          case 'walletIdentity': return { ok: true, value: { pubkey: owner, unlocked: true, enabled, autoReceive, quickTipSats } };
          case 'walletSetQuickTip': quickTipSats = msg.sats; break;
          case 'walletStatus': return { ok: true, value: { mint, balance: 0, funding: [], payments: [] } };
          case 'walletDiscoverMint': return { ok: true, value: 'https://selected.example' };
          case 'walletSelectMint': mint = msg.url; break;
          default: throw Error('Unexpected action ' + msg.type);
        }
        return { ok: true };
      },
    },
  } });
  page.eval(bundle.outputFiles[0].text);
  const button = (name: string) => [...page.document.querySelectorAll('button')].find(b => b.textContent.trim() === name);
  await until(() => !!button('Enable wallet'));
  assert.deepEqual(requests.map(r => r.type), ['walletIdentity']);
  button('Enable wallet')!.click();
  await until(() => !!button('Find my npub.cash mint') && !button('Find my npub.cash mint')!.disabled);
  assert.equal(mint, null);
  assert.equal(autoReceive, false);
  button('Find my npub.cash mint')!.click();
  await until(() => !!button('Use this mint') && !button('Use this mint')!.disabled);
  assert.equal(page.document.querySelector<HTMLInputElement>('input[type=url]')?.value, 'https://selected.example');
  assert.equal(mint, null);
  button('Use this mint')!.click();
  await until(() => !!button('Add sats') && !button('Add sats')!.disabled);
  assert.equal(mint, 'https://selected.example');
  assert.equal(requests.filter(m => ['walletFund', 'walletIncoming', 'walletConfirm'].includes(m.type)).length, 0);
  button('Wallet settings')!.click();
  await until(() => !!page.document.querySelector('input[placeholder="21"]'));
  const field = page.document.querySelector<HTMLInputElement>('input[placeholder="21"]')!;
  field.value = '1000001';
  field.dispatchEvent(new page.Event('input', { bubbles: true }));
  await until(() => !!button('Enable one-click tips')?.disabled);
  field.value = '499';
  field.dispatchEvent(new page.Event('input', { bubbles: true }));
  await until(() => page.document.body.textContent.includes('Maximum fee per tip is 5 sats.'));
  button('Enable one-click tips')!.click();
  await until(() => !!button('Turn off one-click tips') && !button('Turn off one-click tips')!.disabled);
  assert.equal(quickTipSats, 499);
  button('Turn off one-click tips')!.click();
  await until(() => quickTipSats === 0);
});

const token = 'ab'.repeat(16);
type QuickFixture = { fee?: number; saved?: number; profile?: boolean; reject?: boolean; pending?: boolean; prepare?: boolean };

function quickPage(t: TestContext, fixture: QuickFixture = {}) {
  const page = new Window({ url: 'https://extension.test/wallet.html#' + id + '?quick=' + token });
  t.after(() => page.happyDOM.abort());
  page.document.body.innerHTML = '<main><div id="app"></div></main>';
  const requests: Message[] = [];
  let state = fixture.prepare ? '' : fixture.pending ? 'pending' : 'ready', visible = true, focused = true, closed = 0;
  let notify: (() => void) | undefined, tick: (() => void) | undefined, time = Date.now();
  const NativeDate = page.Date;
  Object.defineProperty(page, 'Date', { value: class extends NativeDate { static now() { return time; } } });
  Object.defineProperty(page.document, 'hasFocus', { value: () => focused });
  Object.defineProperty(page.document, 'visibilityState', { get: () => visible ? 'visible' : 'hidden' });
  Object.defineProperty(page, 'close', { value: () => { closed++; } });
  const originalInterval = page.setInterval.bind(page), originalClear = page.clearInterval.bind(page);
  const timerId = Symbol('quick tip timer');
  Object.defineProperty(page, 'setInterval', { value: (callback: () => void, interval: number) => {
    if (interval !== 100) return originalInterval(callback, interval);
    tick = callback;
    return timerId;
  } });
  Object.defineProperty(page, 'clearInterval', { value: (timer: ReturnType<typeof originalInterval> | typeof timerId) => {
    if (timer === timerId) tick = undefined;
    else originalClear(timer);
  } });
  const payment = () => ({ id, invoice: 'test-invoice', sats: 21, fee: fixture.fee ?? 1, state });
  Object.defineProperty(page, 'chrome', { value: {
    storage: { onChanged: { addListener(f: (changed: object, area: string) => void) { notify = () => f({ settingsChanged: true }, 'local'); } } },
    runtime: {
      async sendMessage(msg: Message) {
        requests.push(structuredClone(msg));
        switch (msg.type) {
          case 'walletIdentity': return { ok: true, value: { pubkey: owner, enabled: true, unlocked: true, quickTipSats: fixture.saved ?? 21 } };
          case 'walletStatus': return { ok: true, value: { mint: 'https://mint.example', balance: 500, funding: [], payments: state ? [payment()] : [] } };
          case 'walletReview': return { ok: true, value: { account: owner, id, handle: 'alice', post: fixture.profile ? undefined : '123', lightning: 'alice@example.com', sats: 21, invoice: 'test-invoice' } };
          case 'walletPrepare': state = 'ready'; break;
          case 'walletQuickConfirm':
            if (fixture.reject) return { ok: false, error: 'Authorization expired.' };
            state = 'paid'; break;
          case 'walletCancel': state = 'failed'; break;
          default: throw Error('Unexpected action ' + msg.type);
        }
        return { ok: true, value: payment() };
      },
    },
  } });
  page.eval(bundle.outputFiles[0].text);
  return {
    page, requests, button: (name: string) => [...page.document.querySelectorAll('button')].find(b => b.textContent.trim() === name),
    closeCount: () => closed,
    countdown: () => page.document.body.textContent.includes('Sending in'),
    advance(n: number, step = 100) { for (let i = 0; i < n; i++) { time += step; tick?.(); } },
    blur() { focused = false; page.dispatchEvent(new page.Event('blur')); },
    hide() { visible = false; page.document.dispatchEvent(new page.Event('visibilitychange')); },
    leave() { page.dispatchEvent(new page.Event('pagehide')); },
    changeSettings() { notify?.(); },
    focus() { visible = focused = true; page.dispatchEvent(new page.Event('focus')); },
  };
}

test('one-click payment shows the recipient and fee for the whole countdown, then spends once', async t => {
  const win = quickPage(t, { prepare: true });
  await until(win.countdown);
  assert.equal(win.requests.filter(m => m.type === 'walletPrepare').length, 1);
  assert.equal(win.page.location.hash, '#' + id);
  assert.match(win.page.document.body.textContent, /alice@example.com/);
  assert.match(win.page.document.body.textContent, /Maximum fee1 sat/);
  assert.ok(win.button('Cancel'));
  assert.ok(!win.button('Confirm tip'));
  win.advance(24);
  assert.equal(win.requests.filter(m => m.type === 'walletQuickConfirm').length, 0);
  win.advance(1);
  await until(() => win.closeCount() === 1);
  win.advance(50);
  assert.deepEqual(win.requests.filter(m => m.type === 'walletQuickConfirm'), [{ type: 'walletQuickConfirm', account: owner, id, token, maxFee: 1 }]);
  assert.equal(win.requests.filter(m => m.type === 'walletConfirm').length, 0);
});

test('losing foreground, leaving, changing settings or suspending the timer permanently disarms one-click confirmation', async t => {
  for (const interruption of ['blur', 'hide', 'leave', 'changeSettings', 'stall'] as const) {
    const win = quickPage(t);
    await until(win.countdown);
    win.advance(20);
    if (interruption === 'stall') win.advance(1, 4000);
    else win[interruption]();
    win.focus();
    await until(() => !!win.button('Confirm tip'));
    win.advance(35);
    assert.equal(win.requests.filter(m => m.type === 'walletQuickConfirm').length, 0, interruption);
  }
});

test('cancel releases the quote; a failed quick authorization and ineligible quotes stay manual', async t => {
  const canceled = quickPage(t);
  await until(canceled.countdown);
  canceled.button('Cancel')!.click();
  await until(() => canceled.closeCount() === 1);
  canceled.advance(30);
  assert.equal(canceled.requests.filter(m => m.type === 'walletCancel').length, 1);
  assert.equal(canceled.requests.filter(m => m.type === 'walletQuickConfirm').length, 0);

  const denied = quickPage(t, { reject: true });
  await until(denied.countdown);
  denied.advance(25);
  await until(() => !!denied.button('Confirm tip') && !denied.button('Confirm tip')!.disabled);
  denied.focus();
  denied.advance(40);
  assert.match(denied.page.document.body.textContent, /Authorization expired/);
  assert.equal(denied.requests.filter(m => m.type === 'walletQuickConfirm').length, 1);
  assert.equal(denied.requests.filter(m => m.type === 'walletConfirm').length, 0);
  for (const fixture of [{ fee: 3 }, { saved: 20 }, { profile: true }, { pending: true }]) {
    const win = quickPage(t, fixture);
    await until(() => !!win.button(fixture.pending ? 'Check payment' : 'Confirm tip'));
    win.advance(30);
    assert.equal(win.requests.filter(m => m.type === 'walletQuickConfirm').length, 0);
  }
});
