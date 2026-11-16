import type { Event, EventTemplate } from 'nostr-tools/pure';
import { makeZapRequest } from 'nostr-tools/nip57';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { invoiceDetails } from './bolt11.ts';
export { invoiceDetails } from './bolt11.ts';

// The verified recipient's provider issues either a NIP-57 zap or an ordinary Lightning invoice.

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
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw Error('The lightning provider must use HTTPS.');
  const response = await fetcher(url, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw Error('The lightning provider did not respond.');
  return response.json();
}

/** The lightning provider's pay details (LNURL-pay) for an address. */
export function payInfo(address: string, fetcher: typeof fetch = fetch) {
  const [name, domain] = address.split('@');
  return getJSON('https://' + domain + '/.well-known/lnurlp/' + name, fetcher);
}

/** LUD-21 payment status from the HTTPS verification URL supplied by the recipient's provider. */
export async function verifyTipInvoice(verifyUrl: string, invoice: string, fetcher: typeof fetch = fetch) {
  const reply = await getJSON(verifyUrl, fetcher);
  if (reply?.status !== 'OK' || typeof reply.settled !== 'boolean' || typeof reply.pr !== 'string'
    || reply.pr.toLowerCase() !== invoice.toLowerCase()) throw Error('The provider did not confirm this invoice.');
  if (reply.preimage != null) {
    if (reply.settled !== true || typeof reply.preimage !== 'string' || !/^[0-9a-f]{64}$/i.test(reply.preimage) ||
        bytesToHex(sha256(hexToBytes(reply.preimage))) !== invoiceDetails(invoice)?.paymentHash)
      throw Error('The provider returned an invalid payment proof.');
  }
  return reply.settled as boolean;
}

export interface IssuedInvoice { invoice: string; kind: 'zap' | 'lightning'; verifyUrl?: string }

/** A lightning invoice for a tip of `sats` to the profile's owner. */
export async function tipInvoice(options: {
  profile: Event;
  sats: number;
  relays: string[];
  sign: (template: EventTemplate) => Event;
  fetcher?: typeof fetch;
  /** The tipped post's Nostr note, so the zap goes to the post and not only its author. */
  note?: string;
}): Promise<IssuedInvoice> {
  const fetcher = options.fetcher ?? fetch;
  const address = lightningAddress(options.profile);
  if (!address) throw Error('This profile has no lightning address.');
  if (!Number.isSafeInteger(options.sats) || options.sats < 1 || options.sats > 1000000) throw Error('Choose a tip amount.');
  const pay = await payInfo(address, fetcher);
  const msats = options.sats * 1000;
  if (pay?.tag !== 'payRequest' || typeof pay.callback !== 'string' || !Number.isSafeInteger(pay.minSendable) || !Number.isSafeInteger(pay.maxSendable) || msats < pay.minSendable || msats > pay.maxSendable)
    throw Error('The recipient cannot receive this amount.');
  const callback = new URL(pay.callback);
  callback.searchParams.set('amount', String(msats));
  const addressOrigin = new URL('https://' + address.split('@')[1]).origin;
  async function requestInvoice() {
    const { pr, verify } = await getJSON(callback.href, fetcher);
    const checked = invoiceDetails(pr);
    if (!checked || checked.network !== 'bc' || checked.msats !== msats)
      throw Error('The invoice amount does not match the tip.');
    if (checked.expiresAt <= Date.now() / 1000) throw Error('This invoice has expired.');
    let verifyUrl: string | undefined;
    if (typeof verify === 'string') {
      const url = new URL(verify);
      if (url.origin === callback.origin && url.protocol === 'https:' && !url.username && !url.password) verifyUrl = url.href;
    }
    return { invoice: pr as string, checked, verifyUrl };
  }
  let rejectedHash: string | undefined;
  if (pay.allowsNostr === true && /^[0-9a-f]{64}$/.test(pay.nostrPubkey)) {
    const template = makeZapRequest({ pubkey: options.profile.pubkey, amount: msats, comment: '', relays: options.relays });
    if (options.note) template.tags.push(['e', options.note], ['k', '1']);
    const description = JSON.stringify(options.sign(template));
    callback.searchParams.set('nostr', description);
    const { invoice, checked, verifyUrl } = await requestInvoice();
    if (checked.descriptionHash === bytesToHex(sha256(utf8ToBytes(description))))
      return { invoice, kind: 'zap', ...(verifyUrl && { verifyUrl }) };
    // Some Cashu-backed addresses offer zaps but their mint only issues text-description
    // invoices. Request a new ordinary payment explicitly; never spend the rejected zap.
    if (checked.descriptionHash || callback.origin !== addressOrigin || !verifyUrl)
      throw Error('The invoice does not match the signed zap request.');
    rejectedHash = checked.paymentHash;
  }
  callback.searchParams.delete('nostr');
  const { invoice, checked, verifyUrl } = await requestInvoice();
  if (checked.paymentHash === rejectedHash) throw Error('The provider reused the unverified zap invoice.');
  if (checked.descriptionHash) {
    if (typeof pay.metadata !== 'string' || checked.descriptionHash !== bytesToHex(sha256(utf8ToBytes(pay.metadata))))
      throw Error('The invoice does not match the Lightning address metadata.');
  } else if (callback.origin !== addressOrigin || !verifyUrl || await verifyTipInvoice(verifyUrl, invoice, fetcher)) {
    throw Error('The provider did not confirm a new unpaid invoice for this Lightning address.');
  }
  return { invoice, kind: 'lightning', ...(verifyUrl && { verifyUrl }) };
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
