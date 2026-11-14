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

/** The lightning provider's pay details (LNURL-pay) for an address. */
export function payInfo(address: string, fetcher: typeof fetch = fetch) {
  const [name, domain] = address.split('@');
  return getJSON('https://' + domain + '/.well-known/lnurlp/' + name, fetcher);
}

/** A lightning invoice for a tip of `sats` to the profile's owner. */
export async function tipInvoice(options: {
  profile: Event;
  sats: number;
  relays: string[];
  sign: (template: EventTemplate) => Event;
  fetcher?: typeof fetch;
  /** The tipped post's Nostr note, so the zap goes to the post and not only its author. */
  note?: string;
}) {
  const fetcher = options.fetcher ?? fetch;
  const address = lightningAddress(options.profile);
  if (!address) throw Error('This profile has no lightning address.');
  if (!Number.isSafeInteger(options.sats) || options.sats < 1 || options.sats > 1000000) throw Error('Choose a tip amount.');
  const pay = await payInfo(address, fetcher);
  const msats = options.sats * 1000;
  if (pay?.tag !== 'payRequest' || typeof pay.callback !== 'string' || msats < pay.minSendable || msats > pay.maxSendable)
    throw Error('The recipient cannot receive this amount.');
  const callback = new URL(pay.callback);
  callback.searchParams.set('amount', String(msats));
  if (pay.allowsNostr && pay.nostrPubkey) {
    const template = makeZapRequest({ pubkey: options.profile.pubkey, amount: msats, comment: '', relays: options.relays });
    if (options.note) template.tags.push(['e', options.note], ['k', '1']);
    const request = options.sign(template);
    callback.searchParams.set('nostr', JSON.stringify(request));
  }
  const { pr } = await getJSON(callback.href, fetcher);
  if (typeof pr !== 'string' || getSatoshisAmountFromBolt11(pr) !== options.sats)
    throw Error('The invoice amount does not match the tip.');
  return pr;
}

const normal = (text: string) => text.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The author's Nostr copy of an X post: one tagged with the post's URL, as Social Backup copies
 * are, or one posted within a minute of it that starts with the same text.
 */
export function matchingNote(notes: Event[], url: string, time?: number, text?: string) {
  const tagged = notes.find((note) => note.tags.some(([name, value]) => (name === 'i' || name === 'r') && value === url));
  if (tagged || time === undefined || !text) return tagged;
  const start = normal(text).slice(0, 40);
  if (start.length < 10) return;
  return notes.find((note) => Math.abs(note.created_at - time) <= 60 && normal(note.content).startsWith(start));
}

/** Sats and count of zap receipts (kind 9735) signed by the recipient's lightning provider. */
export function zapTotal(receipts: Event[], provider: string) {
  const genuine = receipts.filter((receipt) => receipt.kind === 9735 && receipt.pubkey === provider);
  let sats = 0;
  for (const receipt of genuine) sats += getSatoshisAmountFromBolt11(receipt.tags.find(([name]) => name === 'bolt11')?.[1] ?? '');
  return { sats, tips: genuine.length };
}
