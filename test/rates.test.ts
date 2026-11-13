import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { coinbaseRate, formatFiat, localCurrency, snortRate, SNORT_RATES, tipPresets } from '../src/rates.ts';

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

test('Coinbase is read without cookies, and fiat amounts are short', async () => {
  assert.equal(await coinbaseRate('USD', async (_url, init) => {
    assert.equal(init?.credentials, 'omit');
    return Response.json({ data: { currency: 'BTC', rates: { USD: '100000.5' } } });
  }), 100000.5);
  assert.equal(formatFiat(0.1, 'USD', 'en-US'), '$0.10');
  assert.equal(formatFiat(5, 'USD', 'en-US'), '$5');
  assert.equal(formatFiat(1.234, 'EUR', 'en-US'), '€1.23');
});

test('tip presets are a dime, a coin and a note in the local currency, sized per currency', () => {
  assert.deepEqual(tipPresets('USD', 100000), [{ fiat: 0.1, sats: 100 }, { fiat: 1, sats: 1000 }, { fiat: 5, sats: 5000 }]);
  assert.deepEqual(tipPresets('JPY', 15000000).map((p) => p.fiat), [10, 100, 500]);
  assert.equal(tipPresets('USD', 1e12)[0].sats, 1);
});
