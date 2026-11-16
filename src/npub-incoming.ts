import { getToken } from 'nostr-tools/nip98';
import type { Event, EventTemplate } from 'nostr-tools/pure';

interface IncomingQuote {
  mintUrl: string;
  quoteId: string;
  amount: number;
  state: 'PAID' | 'ISSUED' | 'INFLIGHT';
  locked: boolean;
}

function validQuote(input: unknown): input is IncomingQuote {
  if (!input || typeof input !== 'object') return false;
  const q = input as Partial<IncomingQuote>;
  try {
    const url = new URL(q.mintUrl ?? '');
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search &&
      typeof q.quoteId === 'string' &&
      q.quoteId.length > 0 &&
      q.quoteId.length <= 1024 &&
      Number.isSafeInteger(q.amount) &&
      q.amount! > 0 &&
      typeof q.locked === 'boolean' &&
      (q.state === 'PAID' || q.state === 'ISSUED' || q.state === 'INFLIGHT')
    );
  } catch {
    return false;
  }
}

type Sign = (event: EventTemplate) => Event;

// npub.cash authenticates the origin and path, excluding pagination. Never forward the authorization.
async function request(url: URL, sign: Sign, fetcher: typeof fetch) {
  const authorization = await getToken(url.origin + url.pathname, 'GET', sign, true);
  const response = await fetcher(url.href, {
    headers: { Authorization: authorization },
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw Error('Could not check npub.cash.');
  const body = await response.json();
  if (body?.error !== false || !body.data) throw Error('npub.cash returned an invalid response.');
  return body;
}

export async function receivingMint(owner: string, sign: Sign, fetcher = fetch) {
  const { data } = await request(new URL('https://npub.cash/api/v2/user/info'), sign, fetcher);
  if (data.user?.pubkey !== owner || typeof data.user.mintUrl !== 'string')
    throw Error('Could not read your receiving mint.');
  const mint = new URL(data.user.mintUrl);
  if (mint.protocol !== 'https:' || mint.username || mint.password || mint.search || mint.hash)
    throw Error('The receiving mint returned an invalid address.');
  return mint.href.replace(/\/+$/, '');
}

export async function* incomingQuotes(sign: Sign, fetcher = fetch) {
  let offset = 0;
  do {
    const url = new URL('https://npub.cash/api/v2/wallet/quotes?limit=50&offset=' + offset);
    const body = await request(url, sign, fetcher);
    const quotes: unknown = body.data?.quotes;
    if (
      body.error !== false ||
      !Array.isArray(quotes) ||
      quotes.length > 50 ||
      !quotes.every(validQuote) ||
      !Number.isSafeInteger(body.metadata?.total) ||
      body.metadata.total < 0
    )
      throw Error('npub.cash returned an invalid payment list.');
    yield quotes;
    offset += quotes.length;
    if (offset >= body.metadata.total) return;
    if (!quotes.length) throw Error('npub.cash returned an incomplete payment list.');
  } while (true);
}
