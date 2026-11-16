import type { Archive } from './types.ts';
import { invoiceDetails, verifyTipInvoice } from './x-tips.ts';
import { settleOwnTip, type TipLocation } from './tip-history.ts';

export interface WalletIntent {
  id: string;
  account: string;
  tab: number;
  handle: string;
  pubkey: string;
  lightning: string;
  sats: number;
  invoice: string;
  verifyUrl?: string;
  post?: string;
  note?: string;
}

export async function issuedTip(db: Archive, hash: string) {
  return (await db.get('meta', ['issuedTip', hash])) as WalletIntent | undefined;
}

export async function rememberInvoice(db: Archive, hash: string, tip: Omit<WalletIntent, 'id'>) {
  const tx = db.transaction('meta', 'readwrite');
  const key = ['issuedTip', hash];
  const old = (await tx.store.get(key)) as WalletIntent | undefined;
  if (old) {
    if (
      old.invoice !== tip.invoice ||
      old.account !== tip.account ||
      old.pubkey !== tip.pubkey ||
      old.post !== tip.post ||
      old.tab !== tip.tab ||
      old.lightning !== tip.lightning ||
      old.sats !== tip.sats
    )
      throw Error('The provider reused an invoice. Choose a new tip.');
    return;
  }
  const id = crypto.randomUUID();
  await tx.store.put({ ...tip, id }, key);
  await tx.store.put([hash], ['walletTip', id]);
  if (tip.verifyUrl) await tx.store.put(true, ['pendingTip', tip.pubkey, tip.post ?? '', hash]);
  await tx.done;
}

// Rotate through pending invoices so an older external payment is still found after later
// invoice requests. Only a menu click contacts providers. Each lookup reads a bounded batch.
async function pendingBatch(db: Archive, target: TipLocation) {
  const tx = db.transaction('meta', 'readwrite'),
    store = tx.store;
  const prefix = ['pendingTip', target.pubkey, target.post ?? ''];
  const cursorKey = ['tipCheckCursor', target.pubkey, target.post ?? ''];
  const cursor = ((await store.get(cursorKey)) as string[] | undefined)?.[0];
  const start = cursor ? [...prefix, cursor] : prefix;
  const end = [...prefix, '\uffff'];
  const limit = 6;
  const keys = await store.getAllKeys(IDBKeyRange.bound(start, end, !!cursor), limit);
  if (cursor && keys.length < limit)
    keys.push(
      ...(await store.getAllKeys(IDBKeyRange.bound(prefix, [...prefix, cursor]), limit - keys.length)),
    );
  const hashes = keys.flatMap((key) => (Array.isArray(key) ? [key[3]] : []));
  if (hashes.length) await store.put([hashes[hashes.length - 1]], cursorKey);
  else await store.delete(cursorKey);
  await tx.done;
  return hashes;
}

export async function reconcileTipInvoices(
  db: Archive,
  target: TipLocation & { account: string; invoice?: string },
  fetcher: typeof fetch = fetch,
) {
  const exact = target.invoice ? invoiceDetails(target.invoice)?.paymentHash : undefined;
  const hashes = target.invoice ? (exact ? [exact] : []) : await pendingBatch(db, target);
  await Promise.allSettled(
    hashes.map(async (hash) => {
      const key = ['pendingTip', target.pubkey, target.post ?? '', hash];
      if (await db.get('meta', ['ownTipPayment', hash])) {
        await db.delete('meta', key);
        return;
      }
      const tip = await issuedTip(db, hash);
      if (
        !tip?.verifyUrl ||
        tip.account !== target.account ||
        tip.pubkey !== target.pubkey ||
        tip.post !== target.post ||
        (target.invoice && tip.invoice !== target.invoice)
      )
        return;
      const paid = await verifyTipInvoice(tip.verifyUrl, tip.invoice, fetcher);
      if (paid) {
        await settleOwnTip(db, { pubkey: tip.pubkey, post: tip.post, sats: tip.sats, paymentHash: hash });
        await db.delete('meta', key);
      }
      // An expired invoice may already have been paid while this device was away.
      // Retain unsettled records for later checks even if settlement or the provider is slow.
    }),
  );
}

export async function tipById(db: Archive, id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) return;
  const index = (await db.get('meta', ['walletTip', id])) as string[] | undefined;
  return index && (await issuedTip(db, index[0]));
}
