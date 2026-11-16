import { validateEvent, verifyEvent, type Event } from 'nostr-tools/pure';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { invoiceDetails } from './bolt11.ts';
export { invoiceDetails } from './bolt11.ts';
import type { Archive } from './types.ts';

export interface TipLocation {
  pubkey: string;
  post?: string;
}
export interface TipSummary {
  note?: string;
  sats: number;
  tips: number;
  ownSats: number;
  ownTips: number;
  paid?: boolean;
}
type ConfirmedTip = TipLocation & { paymentHash: string; sats: number };
const hex64 = /^[a-f0-9]{64}$/;
const totalsKey = (name: string, target: TipLocation) => [name, target.pubkey, target.post ?? ''];
const ownKey = (hash: string) => ['ownTipPayment', hash];
const sameTarget = (a: TipLocation, b: TipLocation) => a.pubkey === b.pubkey && a.post === b.post;

/** An account's private archive remembers a settled payment once, whether a mint or a receipt confirmed it. */
export async function settleOwnTip(db: Archive, tip: ConfirmedTip) {
  const msats = Math.round(tip.sats * 1000);
  if (
    !hex64.test(tip.pubkey) ||
    !hex64.test(tip.paymentHash) ||
    (tip.post !== undefined && !/^\d{1,20}$/.test(tip.post)) ||
    !Number.isSafeInteger(msats) ||
    msats <= 0
  )
    throw Error('Invalid settled tip.');
  const tx = db.transaction('meta', 'readwrite'),
    store = tx.store;
  if (!(await store.get(ownKey(tip.paymentHash)))) {
    const amountKey = totalsKey('ownTipMsats', tip),
      countKey = totalsKey('ownTipCount', tip);
    const [amount, count] = await Promise.all([store.get(amountKey), store.get(countKey)]);
    await Promise.all([
      store.put([tip.pubkey, tip.post ?? ''], ownKey(tip.paymentHash)),
      store.put(Number(amount ?? 0) + msats, amountKey),
      store.put(Number(count ?? 0) + 1, countKey),
    ]);
  }
  await tx.done;
}

/** Batch local-only lookup during scrolling. No identities or post IDs go to a relay or a mint. */
export async function readTipMarks(db: Archive, targets: TipLocation[]) {
  const store = db.transaction('meta').store;
  return Promise.all(
    targets.map(async (target) => Number((await store.get(totalsKey('ownTipMsats', target))) ?? 0) / 1000),
  );
}

/** Reject duplicate tags, including conflicting receipt targets. */
function tag(event: Event, name: string) {
  const tags = event.tags.filter((t) => t[0] === name);
  if (!tags.length) return undefined;
  if (tags.length !== 1 || !tags[0][1]) throw Error('Invalid zap tag.');
  return tags[0][1];
}

function verifiedZap(event: Event, provider: string, recipient: string, note?: string) {
  try {
    if (
      event.kind !== 9735 ||
      event.pubkey !== provider ||
      !validateEvent(event) ||
      !verifyEvent(event) ||
      tag(event, 'p') !== recipient ||
      tag(event, 'e') !== note ||
      tag(event, 'a')
    )
      return;
    const description = tag(event, 'description'),
      bolt11 = tag(event, 'bolt11');
    if (!description || description.length > 32768 || !bolt11) return;
    const request = JSON.parse(description) as Event;
    if (
      request.kind !== 9734 ||
      !validateEvent(request) ||
      !verifyEvent(request) ||
      tag(request, 'p') !== recipient ||
      tag(request, 'e') !== note ||
      tag(request, 'a')
    )
      return;
    const sender = tag(event, 'P');
    if (sender !== undefined && sender !== request.pubkey) return;
    const invoice = invoiceDetails(bolt11);
    if (
      !invoice ||
      invoice.network !== 'bc' ||
      bytesToHex(sha256(utf8ToBytes(description))) !== invoice.descriptionHash
    )
      return;
    const amount = tag(request, 'amount');
    if (amount !== undefined && (!/^\d+$/.test(amount) || Number(amount) !== invoice.msats)) return;
    const preimage = tag(event, 'preimage');
    if (
      preimage &&
      (!hex64.test(preimage) || bytesToHex(sha256(hexToBytes(preimage))) !== invoice.paymentHash)
    )
      return;
    return { hash: invoice.paymentHash, sats: invoice.msats / 1000, sender: request.pubkey };
  } catch {
    return;
  }
}

/** Only the user's own settled tips persist. Other senders' totals belong to this explicit menu lookup. */
export async function summarizeTips(
  db: Archive,
  target: TipLocation & { note?: string; invoice?: string },
  owner: string,
  receipts: Event[],
  provider?: string,
  issuedTarget?: (paymentHash: string) => Promise<TipLocation | undefined>,
): Promise<TipSummary> {
  const seen = new Set<string>();
  const other = new Map<string, number>();
  if (provider)
    for (const event of receipts) {
      const tip = verifiedZap(event, provider, target.pubkey, target.note);
      if (!tip || seen.has(tip.hash)) continue;
      seen.add(tip.hash);
      if (tip.sender === owner) {
        // An X post without a matching Nostr note produces a profile zap. Its original local
        // invoice binds it to that specific post, including when a receipt arrives on a later visit.
        const issued = await issuedTarget?.(tip.hash);
        if (issued && issued.pubkey !== target.pubkey) continue;
        if (target.post && !target.note && !issued) continue;
        await settleOwnTip(db, { ...(issued ?? target), paymentHash: tip.hash, sats: tip.sats });
      } else if (!target.post || target.note) {
        other.set(tip.hash, Math.round(tip.sats * 1000));
      }
    }
  const store = db.transaction('meta').store;
  const checking = target.invoice && invoiceDetails(target.invoice)?.paymentHash;
  const [ownMsats, count, settled, otherPayments] = await Promise.all([
    store.get(totalsKey('ownTipMsats', target)),
    store.get(totalsKey('ownTipCount', target)),
    checking ? store.get(ownKey(checking)) : undefined,
    Promise.all(Array.from(other, async ([hash, msats]) => ((await store.get(ownKey(hash))) ? 0 : msats))),
  ]);
  const otherMsats = otherPayments.reduce((sum, msats) => sum + msats, 0),
    otherTips = otherPayments.filter(Boolean).length;
  const ownSats = Number(ownMsats ?? 0) / 1000,
    ownTips = Number(count ?? 0);
  return {
    ...(target.note && { note: target.note }),
    sats: otherMsats / 1000 + ownSats,
    tips: otherTips + ownTips,
    ownSats,
    ownTips,
    ...(target.invoice && {
      paid:
        Array.isArray(settled) && sameTarget({ pubkey: settled[0], post: settled[1] || undefined }, target),
    }),
  };
}
