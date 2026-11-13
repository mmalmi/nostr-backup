import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { coinbaseRate, fiatLabel, localCurrency, snortRate, SNORT_RATES } from '../src/rates.ts';

test('the currency follows the browser region', () => {
  assert.equal(localCurrency(['fi-FI']), 'EUR');
  assert.equal(localCurrency(['en-GB', 'en']), 'GBP');
  assert.equal(localCurrency(['pt-BR']), 'USD');
  assert.equal(localCurrency([]), 'USD');
});

test('Snort rates must come from Snort, be recent and name the currency', () => {
  const now = 1_800_000_000;
  const event = (pubkey: string, created_at: number) => ({
    ...finalizeEvent({ kind: SNORT_RATES.kind, created_at, content: '', tags: [['d', 'BTCEUR', '90000', '89900', '88000', '91000']] }, generateSecretKey()),
    pubkey,
  });
  assert.equal(snortRate(event(SNORT_RATES.pubkey, now - 60), 'EUR', now), 90000);
  assert.equal(snortRate(event(SNORT_RATES.pubkey, now - 60), 'USD', now), undefined);
  assert.equal(snortRate(event(SNORT_RATES.pubkey, now - 5 * 3600), 'EUR', now), undefined);
  assert.equal(snortRate(event('00'.repeat(32), now - 60), 'EUR', now), undefined);
});

test('Coinbase is read without cookies, and amounts show as short estimates', async () => {
  assert.equal(await coinbaseRate('USD', async (_url, init) => {
    assert.equal(init?.credentials, 'omit');
    return Response.json({ data: { currency: 'BTC', rates: { USD: '100000.5' } } });
  }), 100000.5);
  assert.equal(fiatLabel(21, 100000, 'USD', 'en-US'), '≈ $0.02');
  assert.equal(fiatLabel(1, 100000, 'USD', 'en-US'), '< $0.01');
  assert.equal(fiatLabel(100000, 100000, 'USD', 'en-US'), '≈ $100');
});
