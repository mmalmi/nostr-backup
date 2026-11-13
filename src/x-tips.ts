import type { Event, EventTemplate } from 'nostr-tools/pure';
import { getSatoshisAmountFromBolt11, makeZapRequest } from 'nostr-tools/nip57';

// Tips are Nostr zaps (NIP-57) paid by the user's own wallet. This code only asks the
// recipient's lightning provider for an invoice and checks it before the wallet opens it.

/** The lightning address (lud16) in a Nostr profile, if it looks like name@domain. */
export function lightningAddress(profile?: Event) {
  try {
    const address = JSON.parse(profile?.content ?? '{}')?.lud16;
    if (typeof address !== 'string') return;
    const value = address.trim().toLowerCase();
    return /^[a-z0-9._+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,}$/.test(value) ? value : undefined;
  } catch {
    return;
  }
}

async function getJSON(url: string, fetcher: typeof fetch) {
  if (new URL(url).protocol !== 'https:') throw Error('The lightning provider must use HTTPS.');
  const response = await fetcher(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw Error('The lightning provider did not respond.');
  return response.json();
}

/** A lightning invoice for a tip of `sats` to the profile's owner. */
export async function tipInvoice(options: {
  profile: Event;
  sats: number;
  comment?: string;
  relays: string[];
  sign: (template: EventTemplate) => Event;
  fetcher?: typeof fetch;
}) {
  const fetcher = options.fetcher ?? fetch;
  const address = lightningAddress(options.profile);
  if (!address) throw Error('This profile has no lightning address.');
  if (!Number.isSafeInteger(options.sats) || options.sats < 1 || options.sats > 1000000) throw Error('Choose a tip amount.');
  const [name, domain] = address.split('@');
  const pay = await getJSON('https://' + domain + '/.well-known/lnurlp/' + name, fetcher);
  const msats = options.sats * 1000;
  if (pay?.tag !== 'payRequest' || typeof pay.callback !== 'string' || msats < pay.minSendable || msats > pay.maxSendable)
    throw Error('The recipient cannot receive this amount.');
  const callback = new URL(pay.callback);
  callback.searchParams.set('amount', String(msats));
  if (pay.allowsNostr && pay.nostrPubkey) {
    const request = options.sign(
      makeZapRequest({ pubkey: options.profile.pubkey, amount: msats, comment: options.comment, relays: options.relays }),
    );
    callback.searchParams.set('nostr', JSON.stringify(request));
  } else if (options.comment && (pay.commentAllowed ?? 0) >= options.comment.length) {
    callback.searchParams.set('comment', options.comment);
  }
  const { pr } = await getJSON(callback.href, fetcher);
  if (typeof pr !== 'string' || getSatoshisAmountFromBolt11(pr) !== options.sats)
    throw Error('The invoice amount does not match the tip.');
  return pr;
}
