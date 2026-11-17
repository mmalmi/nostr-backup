import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import {
  cancelWalletPayment,
  claimWalletQuote,
  confirmWalletPayment,
  eraseEmptyWallet,
  exportWallet,
  fundWallet,
  prepareWalletPayment,
  refreshFunding,
  refreshWalletPayment,
  restoreWallet,
  selectWalletMint,
  walletHasFundsOrPending,
  walletStatus,
} from '../src/cashu-wallet.ts';

if (!navigator.locks) {
  const locks = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, 'locks', {
    value: { request: (name: string, task: () => Promise<unknown>) => {
      const next = (locks.get(name) ?? Promise.resolve()).then(task);
      locks.set(name, next.catch(() => undefined));
      return next;
    } },
  });
}

const owner = 'b'.repeat(64),
  other = 'a'.repeat(64);
const mint = 'https://wallet.example',
  passphrase = 'disposable test wallet password';

test('wallet status and empty deletion stay local and account-scoped', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw Error('Unexpected network request');
  };
  try {
    assert.equal((await walletStatus(owner)).mint, null);
    assert.equal(await walletHasFundsOrPending(owner), false);
    await eraseEmptyWallet(owner);
    for (const url of [
      'http://wallet.example',
      'https://user@wallet.example',
      'https://wallet.example/?token=1',
    ])
      assert.throws(() => selectWalletMint(owner, url));
    await assert.rejects(walletStatus('invalid account'));
    await assert.rejects(fundWallet(owner, 42));
    await assert.rejects(restoreWallet(other, '{}', passphrase));
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

// Run with SOCIAL_BACKUP_FAKE_MINT pointing to a disposable loopback CDK mintd fakewallet.
// The production URL validation and wallet logic run unchanged; only test transport maps to loopback.
const fixture = process.env.SOCIAL_BACKUP_FAKE_MINT;
test(
    'fake mint funds, pays once after a dropped response, claims deposits and restores current proofs',
    { timeout: 120000, skip: !fixture && !process.env.SOCIAL_BACKUP_RELEASE_TESTS ? 'Set SOCIAL_BACKUP_FAKE_MINT to exercise the wallet integration' : false },
    async () => {
      assert.ok(fixture, 'Release tests require SOCIAL_BACKUP_FAKE_MINT');
      const endpoint = new URL(fixture);
      assert.equal(endpoint.protocol, 'http:');
      assert.equal(endpoint.hostname, '127.0.0.1');
      const nativeFetch = globalThis.fetch;
      let dropResponse = false,
        dropMintResponse = false,
        blockMintRecovery = false,
        minted = 0,
        blockChecks = false,
        submitted = 0;
      const requests: string[] = [];
      const mintRequests = new Map<string, unknown>();
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        assert.ok(url.startsWith(mint + '/'), 'Only the selected mint may receive wallet traffic');
        const path = url.slice(mint.length);
        requests.push(path);
        if (blockChecks && path.includes('/melt/quote/')) throw Error('Test mint is offline');
        if (blockMintRecovery && (path.includes('/mint/quote/') || path === '/v1/restore')) throw Error('Test mint is offline');
        const response = await nativeFetch(endpoint.origin + path, init);
        if (path === '/v1/mint/bolt11' && init?.method === 'POST') {
          // Recovery may resend the same quote. It must reuse the original blinded
          // outputs, and the balance below must include the deposit exactly once.
          const body = JSON.parse(String(init.body));
          const previous = mintRequests.get(body.quote);
          if (previous) assert.deepEqual(body.outputs, previous, 'Recovery reuses the original blinded outputs');
          else { mintRequests.set(body.quote, body.outputs); minted++; }
          if (dropMintResponse) {
            dropMintResponse = false;
            blockMintRecovery = true;
            await response.arrayBuffer();
            throw Error('Lost mint response');
          }
        }
        if (path === '/v1/melt/bolt11' && init?.method === 'POST') {
          submitted++;
          if (dropResponse) {
            dropResponse = false;
            blockChecks = true;
            await response.arrayBuffer();
            throw Error('Lost response');
          }
        }
        return response;
      };
      const upstreamQuote = async (sats: number) =>
        (await (
          await fetch(mint + '/v1/mint/quote/bolt11', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: sats, unit: 'sat' }),
          })
        ).json()) as { request: string; quote: string };
      async function eventually<T>(read: () => Promise<T>, matches: (item: T) => boolean) {
        for (let n = 0; n < 200; n++) {
          const item = await read();
          if (matches(item)) return item;
          await wait(125);
        }
        throw Error('Timed out waiting for fake mint settlement.');
      }
      async function newDevice() {
        for (const { name } of await indexedDB.databases()) {
          if (name?.startsWith('social-backup-cashu-'))
            await new Promise((resolve, reject) => {
              const request = indexedDB.deleteDatabase(name);
              request.onsuccess = resolve;
              request.onerror = reject;
            });
        }
      }
      try {
        await selectWalletMint(owner, mint);
        const funding = await fundWallet(owner, 128);
        assert.equal((await walletStatus(owner)).funding[0].id, funding.id);
        await eventually(
          () => refreshFunding(owner, funding.id),
          (d) => d.state === 'paid',
        );
        const backup = await exportWallet(owner, passphrase);
        assert.ok(!backup.includes(funding.invoice) && !backup.includes(passphrase));
        assert.equal((await walletStatus(owner)).balance, 128);
        assert.equal((await walletStatus(other)).balance, 0);
        await assert.rejects(eraseEmptyWallet(owner));
        await assert.rejects(selectWalletMint(owner, 'https://other.example'));
        const discarded = await upstreamQuote(9);
        assert.equal((await prepareWalletPayment(owner, 'abandoned', discarded.request, 9)).state, 'ready');
        assert.equal((await cancelWalletPayment(owner, 'abandoned')).state, 'failed');
        assert.equal((await walletStatus(owner)).balance, 128);
        const recipient = await upstreamQuote(21);
        const target = {
          pubkey: 'c'.repeat(64),
          handle: 'alice',
          lightning: 'alice@wallet.example',
          post: '42',
        };
        const quote = await prepareWalletPayment(owner, 'tip', recipient.request, 21, target);
        assert.equal(quote.state, 'ready');
        await assert.rejects(prepareWalletPayment(owner, 'second', recipient.request, 21));
        await assert.rejects(confirmWalletPayment(owner, 'tip', quote.fee + 1));
        assert.equal(submitted, 0);
        dropResponse = true;
        const uncertain = await confirmWalletPayment(owner, 'tip', quote.fee);
        assert.equal(uncertain.state, 'pending');
        blockChecks = false;
        const settled = await eventually(
          () => refreshWalletPayment(owner, 'tip'),
          (p) => p.state === 'paid',
        );
        assert.ok(settled.fee <= quote.fee);
        assert.equal((await confirmWalletPayment(owner, 'tip', quote.fee)).state, 'paid');
        assert.equal(submitted, 1);
        const after = (await walletStatus(owner)).balance;
        assert.equal(after + settled.sats + settled.fee, 128);
        const incoming = await upstreamQuote(16);
        await eventually(
          async () => (await (await fetch(mint + '/v1/mint/quote/bolt11/' + incoming.quote)).json()).state,
          (state) => state === 'PAID',
        );
        const mintedBefore = minted;
        dropMintResponse = true;
        await claimWalletQuote(owner, mint, incoming.quote).catch(() => undefined);
        assert.equal((await walletStatus(owner)).balance, after, 'Lost mint signatures are not yet spendable');
        blockMintRecovery = false;
        // Each call reopens the persisted wallet, as after the popup or extension closes.
        const [claim, concurrent] = await Promise.all([
          claimWalletQuote(owner, mint, incoming.quote),
          claimWalletQuote(owner, mint, incoming.quote),
        ]);
        assert.equal(claim.state, 'paid');
        assert.equal(concurrent.id, claim.id);
        assert.equal(minted, mintedBefore + 1, 'A recovered deposit must not mint twice');
        assert.equal((await claimWalletQuote(owner, mint, incoming.quote)).id, claim.id);
        assert.equal((await walletStatus(owner)).balance, after + 16);
        const beforeReads = requests.length;
        await walletStatus(owner);
        await walletHasFundsOrPending(owner);
        assert.equal(requests.length, beforeReads);
        const latest = await exportWallet(owner, passphrase);
        await assert.rejects(restoreWallet(owner, backup, passphrase));
        // New test device with no local proof or journal databases.
        await newDevice();
        await assert.rejects(restoreWallet(owner, backup, 'different password'));
        await assert.rejects(restoreWallet(other, backup, passphrase));
        await restoreWallet(owner, backup, passphrase);
        assert.equal((await walletStatus(owner)).balance, after + 16);
        await newDevice();
        await restoreWallet(owner, latest, passphrase);
        assert.deepEqual((await walletStatus(owner)).payments.find((p) => p.id === 'tip')?.tip, target);
      } finally {
        globalThis.fetch = nativeFetch;
      }
    },
  );
