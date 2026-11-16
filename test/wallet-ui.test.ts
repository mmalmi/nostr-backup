import { test } from 'node:test';
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
  const button = (win: Window, name: string) => [...win.document.querySelectorAll('button')].find(b => b.textContent === name);
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
  let enabled = false, mint: string | null = null, autoReceive = false;
  Object.defineProperty(page, 'chrome', { value: {
    storage: { onChanged: { addListener() {} } },
    runtime: {
      async sendMessage(msg: Message) {
        requests.push(structuredClone(msg));
        switch (msg.type) {
          case 'walletPreferences': enabled = msg.enabled; autoReceive = msg.autoReceive; break;
          case 'walletIdentity': return { ok: true, value: { pubkey: owner, unlocked: true, enabled, autoReceive } };
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
  const button = (name: string) => [...page.document.querySelectorAll('button')].find(b => b.textContent === name);
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
});
