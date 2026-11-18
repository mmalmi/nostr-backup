import { quickTipFeeLimit } from './quick-tip.ts';
import { getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import type { Archive, Message, Settings } from './types.ts';
import type { IncomingSummary, WalletRPC } from './wallet-actions.ts';
import { settings } from './accounts.ts';
import { savedKey } from './signer-storage.ts';
import { unhex } from './model.ts';
import { paymentConsent } from './tip-consent.ts';
import { invoiceDetails, readTipMarks, settleOwnTip } from './tip-history.ts';
import { openArchive } from './archive.ts';
import { savedQuickTip, tipById, type WalletIntent } from './wallet-intent.ts';
import { incomingQuotes, receivingMint } from './npub-incoming.ts';

type Engine = typeof import('./cashu-wallet.ts');
const engine = () => import('./cashu-wallet.ts');

export function isWalletAction(msg: Message): msg is Message<keyof WalletRPC> {
  return msg.type.startsWith('wallet');
}

export async function walletIdentity(conf: Settings) {
  const key = await savedKey();
  const unlocked = !!key && getPublicKey(unhex(key)) === conf.pubkey;
  let lastIncoming: IncomingSummary | undefined;
  if (unlocked && conf.walletEnabled && (await paymentConsent())) {
    const db = await openArchive(conf.archiveName);
    try {
      lastIncoming = (await db.get('meta', 'npubCashInbox')) as IncomingSummary | undefined;
    } finally {
      db.close();
    }
  }
  return {
    pubkey: conf.pubkey,
    unlocked,
    ...(lastIncoming && { lastIncoming }),
    enabled: conf.walletEnabled === true,
    autoReceive: conf.walletAutoReceive === true,
    ...(conf.walletEnabled && conf.quickTipSats && {quickTipSats: conf.quickTipSats}),
  };
}

async function walletAccess(owner: string, automatic = false) {
  const current = await settings();
  if (
    !owner ||
    current.pubkey !== owner ||
    !current.walletEnabled ||
    (automatic && !current.walletAutoReceive)
  )
    throw Error('The wallet is off or the active profile changed.');
  const key = await savedKey();
  if (!key || getPublicKey(unhex(key)) !== owner) throw Error('Unlock this profile to use its wallet.');
  if (!(await paymentConsent())) throw Error('Enable payment data in the extension settings.');
  return unhex(key);
}

export async function checkQuickSettings(owner: string, sats: number) {
  await walletAccess(owner);
  const conf = await settings();
  if (!Number.isSafeInteger(sats) || sats < 1 || sats > 1_000_000 || conf.pubkey !== owner ||
      !conf.tipButtons || !conf.walletEnabled || conf.quickTipSats !== sats)
    throw Error('One-click tip settings changed. Open the tip menu.');
  return conf;
}

export async function menuWalletBalance(owner: string) {
  await walletAccess(owner);
  const balance = await (await engine()).availableWalletBalance(owner);
  await walletAccess(owner);
  return balance;
}

export async function checkIncoming(db: Archive, owner: string, automatic = false): Promise<IncomingSummary> {
  const key = await walletAccess(owner, automatic);
  const cashu = await engine();
  const status = await cashu.walletStatus(owner);
  const mints = new Set<string>();
  let claimed = 0,
    available = 0;
  const seen = new Set<string>();
  for await (const page of incomingQuotes((template) => finalizeEvent(template, key))) {
    await walletAccess(owner, automatic);
    for (const q of page) {
      const mint = q.mintUrl.replace(/\/+$/, '');
      const entry = ['npubCashClaim', mint, q.quoteId];
      const reference = JSON.stringify(entry);
      if (q.state !== 'PAID' || seen.has(reference)) continue;
      seen.add(reference);
      if (await db.get('meta', entry)) continue;
      if (q.locked || mint !== status.mint) {
        available += q.amount;
        mints.add(mint);
        continue;
      }
      await walletAccess(owner, automatic);
      const result = await cashu.claimWalletQuote(owner, mint, q.quoteId).catch(() => undefined);
      if (result?.state === 'paid') {
        await db.put('meta', true, entry);
        claimed += result.sats;
      } else {
        available += q.amount;
        mints.add(mint);
      }
    }
  }
  const summary = { claimed, available, mints: [...mints], checkedAt: Date.now() };
  await db.put('meta', summary, 'npubCashInbox');
  return summary;
}

type WalletPayment = Awaited<ReturnType<Engine['confirmWalletPayment']>>;

function restoredTip(owner: string, payment?: WalletPayment): WalletIntent | undefined {
  if (!payment?.tip || payment.id.startsWith('withdraw-')) return;
  return {
    ...payment.tip,
    id: payment.id,
    tab: -1,
    account: owner,
    invoice: payment.invoice,
    sats: payment.sats,
  };
}

async function markPayment(db: Archive, owner: string, payment: WalletPayment) {
  if (payment.state !== 'paid' || payment.id.startsWith('withdraw-')) return;
  const details = invoiceDetails(payment.invoice);
  if (!details || (await db.get('meta', ['ownTipPayment', details.paymentHash]))) return;
  const tip = (await tipById(db, payment.id)) ?? restoredTip(owner, payment);
  if (!tip || tip.account !== owner || tip.invoice !== payment.invoice || tip.sats !== payment.sats) return;
  await settleOwnTip(db, {
    pubkey: tip.pubkey,
    post: tip.post,
    sats: tip.sats,
    paymentHash: details.paymentHash,
  });
}

// Replay only the local history write if the worker stopped after settlement. A pending
// payment is checked by its existing mint operation, without authorizing a new spend.
export async function recoverPayments(db: Archive, owner: string, checkPending: boolean) {
  await walletAccess(owner);
  const cashu = await engine();
  const status = await cashu.walletStatus(owner);
  for (const payment of status.payments) {
    if (payment.state === 'paid') await markPayment(db, owner, payment);
    else if (checkPending && payment.state === 'pending') {
      await walletAccess(owner);
      const updated = await cashu.refreshWalletPayment(owner, payment.id).catch(() => undefined);
      if (updated) await markPayment(db, owner, updated);
    }
  }
  if (checkPending) {
    for (const deposit of status.funding) {
      if (deposit.state !== 'pending') continue;
      await walletAccess(owner);
      await cashu.refreshFunding(owner, deposit.id).catch(() => {});
    }
  }
  return status;
}

// Check private records before creating an invoice. Another tab or a restored wallet can
// already own the only payment for this X post, even if the site's handle subsequently changed.
export async function priorQuickPayment(db: Archive, owner: string, pubkey: string, post: string) {
  const [own] = await readTipMarks(db, [{pubkey, post}]);
  if (own > 0) return {paid:true} as const;
  const cashu = await engine();
  const {payments} = await cashu.walletStatus(owner);
  const matching = payments.filter(p => p.tip?.post === post);
  const paid = matching.find(p => p.state === 'paid');
  if (paid) {
    await markPayment(db, owner, paid);
    return {paid:true} as const;
  }
  const saved = await savedQuickTip(db, post);
  const live = matching.find(p => p.state === 'pending') ?? matching.find(p => p.state === 'ready');
  if (live) {
    const tip = (await tipById(db, live.id)) ?? restoredTip(owner, live);
    if (!tip || tip.account !== owner || tip.post !== post) throw Error('Review the existing payment in your wallet.');
    return {paid:false, tip, reviewOnly:saved?.id !== live.id, pending:live.state === 'pending', reserved:true} as const;
  }
  if (saved && !payments.some(p => p.id === saved.id && p.state === 'failed')) {
    if (saved.account !== owner) throw Error('The active wallet changed.');
    return {paid:false, tip:saved, reviewOnly:false, pending:false, reserved:false} as const;
  }
  return {paid:false} as const;
}

export async function quickConfirm(db: Archive, owner: string, id: string, maxFee: number, checkWindow: () => Promise<void>) {
  const tip = await tipById(db, id);
  if (!tip || tip.account !== owner || !tip.post || (await savedQuickTip(db, tip.post))?.id !== id)
    throw Error('This one-click tip is no longer active.');
  await checkQuickSettings(owner, tip.sats);
  const invoice = invoiceDetails(tip.invoice);
  if (!invoice || invoice.network !== 'bc' || invoice.msats !== tip.sats * 1000 || invoice.expiresAt <= Date.now() / 1000)
    throw Error('The invoice expired or changed. Review this tip in the wallet.');
  if (!Number.isSafeInteger(maxFee) || maxFee < 0 || maxFee > quickTipFeeLimit(tip.sats))
    throw Error('The fee exceeds your one-click limit. Review this tip in the wallet.');
  const cashu = await engine();
  const {payments} = await cashu.walletStatus(owner);
  const payment = payments.find(p => p.id === id);
  if (!payment || payment.invoice !== tip.invoice || payment.sats !== tip.sats || payment.tip?.pubkey !== tip.pubkey ||
      payment.tip?.post !== tip.post || payment.tip.lightning !== tip.lightning)
    throw Error('Review the current wallet quote first.');
  if (payment.state !== 'ready') {
    await markPayment(db, owner, payment);
    return payment;
  }
  if (payment.fee !== maxFee) throw Error('The wallet fee changed. Review this tip in the wallet.');
  if ((await readTipMarks(db, [{pubkey:tip.pubkey, post:tip.post}]))[0] > 0 ||
      payments.some(p => p.id !== id && p.tip?.post === tip.post && (p.state === 'pending' || p.state === 'paid')))
    throw Error('You already tipped this post or a payment is pending.');
  await checkQuickSettings(owner, tip.sats);
  await checkWindow();
  const result = await cashu.confirmWalletPayment(owner, id, maxFee);
  await markPayment(db, owner, result);
  return result;
}

type Operation = Exclude<keyof WalletRPC, 'walletIdentity' | 'walletPreferences' | 'walletSetQuickTip' | 'walletQuickConfirm'>;
export async function walletOperation(db: Archive, owner: string, msg: Message<Operation>) {
  await walletAccess(owner);
  const cashu = await engine();
  switch (msg.type) {
    case 'walletDiscoverMint': {
      const key = await walletAccess(owner);
      return receivingMint(owner, (template) => finalizeEvent(template, key));
    }
    case 'walletIncoming':
      return checkIncoming(db, owner);
    case 'walletStatus':
      return recoverPayments(db, owner, false);
    case 'walletReview':
    case 'walletPrepare': {
      const tip =
        (await tipById(db, msg.id)) ??
        restoredTip(
          owner,
          (await cashu.walletStatus(owner)).payments.find((p) => p.id === msg.id),
        );
      if (!tip || tip.account !== owner)
        throw Error('This tip belongs to a different account or is unavailable.');
      if (msg.type === 'walletReview') return tip;
      const parsed = invoiceDetails(tip.invoice);
      if (
        !parsed ||
        parsed.network !== 'bc' ||
        parsed.expiresAt <= Date.now() / 1000 ||
        parsed.msats !== tip.sats * 1000
      )
        throw Error('This invoice expired or changed. Open a fresh tip.');
      const { pubkey, handle, lightning, post, note } = tip;
      return cashu.prepareWalletPayment(owner, msg.id, tip.invoice, tip.sats, {
        pubkey,
        handle,
        lightning,
        post,
        note,
      });
    }
    case 'walletPrepareWithdrawal': {
      const parsed = invoiceDetails(msg.invoice);
      if (
        !parsed ||
        parsed.network !== 'bc' ||
        parsed.expiresAt <= Date.now() / 1000 ||
        parsed.msats < 1000 ||
        parsed.msats % 1000
      )
        throw Error('Enter an unexpired Bitcoin Lightning invoice for a whole number of sats.');
      return cashu.prepareWalletPayment(
        owner,
        'withdraw-' + parsed.paymentHash,
        msg.invoice,
        parsed.msats / 1000,
      );
    }
    case 'walletSelectMint':
      await cashu.selectWalletMint(owner, msg.url);
      return;
    case 'walletFund':
      return cashu.fundWallet(owner, msg.sats);
    case 'walletRefreshFunding':
      return cashu.refreshFunding(owner, msg.id);
    case 'walletConfirm':
    case 'walletRefresh': {
      const payment =
        msg.type === 'walletConfirm'
          ? await cashu.confirmWalletPayment(owner, msg.id, msg.maxFee)
          : await cashu.refreshWalletPayment(owner, msg.id);
      await markPayment(db, owner, payment);
      return payment;
    }
    case 'walletCancel':
      return cashu.cancelWalletPayment(owner, msg.id);
    case 'walletExport':
      return cashu.exportWallet(owner, msg.passphrase);
    case 'walletRestore':
      await cashu.restoreWallet(owner, msg.json, msg.passphrase);
      await recoverPayments(db, owner, false);
      return;
  }
}
