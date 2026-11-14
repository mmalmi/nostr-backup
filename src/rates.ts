import type { Event } from 'nostr-tools/pure';

// Fiat estimates for tips, following iris-market: Snort's signed Nostr rate events first,
// Coinbase's public rates as a fallback. Estimates only; tips are always paid in sats.
// Snort's schema and publisher, as reviewed in iris-market at this Snort revision:
// https://github.com/v0l/snort/blob/d750544e9ba29f929bbc019a747399359fa9f9fa/packages/app/src/Hooks/useRates.tsx
export const SNORT_RATES = { pubkey: '84de35e2584d2b144aae823c9ed0b0f3deda09648530b93d1a2a146d1dea9864', kind: 1009 };
export const COINBASE_RATES_URL = 'https://api.coinbase.com/v2/exchange-rates?currency=BTC';
export const FRESH_SECONDS = 15 * 60;
const MAX_AGE_SECONDS = 4 * 60 * 60;

const byCountry: Record<string, string> = {
  US: 'USD', GB: 'GBP', SE: 'SEK', NO: 'NOK', DK: 'DKK', CH: 'CHF', LI: 'CHF',
  CA: 'CAD', AU: 'AUD', JP: 'JPY', CN: 'CNY', IN: 'INR',
};
for (const country of 'AT BE BG CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK AD MC SM VA'.split(' '))
  byCountry[country] = 'EUR';

/** Currencies tip amounts can be shown in. */
export const TIP_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY', 'CNY', 'INR', 'SEK', 'NOK', 'DKK'];

/** The chosen tip currency, or the one for the browser's region. */
export function tipCurrency(chosen: string | undefined, locales: readonly string[]) {
  return chosen && TIP_CURRENCIES.includes(chosen) ? chosen : localCurrency(locales);
}

/** The currency for the browser's region, or USD. */
export function localCurrency(locales: readonly string[]) {
  for (const locale of locales) {
    try {
      const region = new Intl.Locale(locale).maximize().region;
      if (region && byCountry[region]) return byCountry[region];
    } catch { /* Ignore malformed locales. */ }
  }
  return 'USD';
}

/** Units of `currency` per bitcoin from a signed Snort rate event, if it is recent and well formed. */
export function snortRate(event: Event, currency: string, now = Date.now() / 1000) {
  if (event.kind !== SNORT_RATES.kind || event.pubkey !== SNORT_RATES.pubkey) return;
  if (event.created_at > now + 60 || now - event.created_at > MAX_AGE_SECONDS) return;
  const tag = event.tags.find(([name, symbol]) => name === 'd' && symbol === 'BTC' + currency);
  const ask = Number(tag?.[2]);
  return Number.isFinite(ask) && ask > 0 ? ask : undefined;
}

/** Units of `currency` per bitcoin from Coinbase's public rates. */
export async function coinbaseRate(currency: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(COINBASE_RATES_URL, {
    credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return;
  const value = Number((await response.json())?.data?.rates?.[currency]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

// Tip presets in the user's currency: about a dime, a coin and a note, sized for each currency.
const PRESET_SCALE: Record<string, number> = { JPY: 100, INR: 100, CNY: 10, SEK: 10, NOK: 10, DKK: 10 };
export function tipPresets(currency: string, perBitcoin: number) {
  return [0.1, 1, 5].map((step) => {
    const fiat = step * (PRESET_SCALE[currency] ?? 1);
    return { fiat, sats: Math.max(1, Math.round((fiat / perBitcoin) * 1e8)) };
  });
}

/** A fiat amount such as "€0.10" or "¥100". */
export function formatFiat(value: number, currency: string, locale?: string): string {
  if (value > 0 && value < 0.01) return '<' + formatFiat(0.01, currency, locale);
  return new Intl.NumberFormat(locale, {
    style: 'currency', currency, minimumFractionDigits: value < 10 && value % 1 ? 2 : 0, maximumFractionDigits: 2,
  }).format(value);
}
