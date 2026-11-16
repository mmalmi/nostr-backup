import { Amount, Manager, MemoryRepositories, type MeltOperation, type MintQuote } from '@cashu/coco-core';
import { IndexedDbRepositories } from '@cashu/coco-indexeddb';
import { sha256 } from '@noble/hashes/sha2.js';
import { Wallet } from '@cashu/cashu-ts';
import { base64, hex } from '@scure/base';
import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { invoiceDetails } from './bolt11.ts';

export interface Funding {
  id: string;
  invoice: string;
  sats: number;
  expiry: number;
  state: 'pending' | 'paid' | 'expired' | 'failed';
}
export interface WalletTip {
  pubkey: string;
  handle: string;
  lightning: string;
  post?: string;
  note?: string;
}
export interface Payment {
  tip?: WalletTip;
  id: string;
  invoice: string;
  sats: number;
  fee: number;
  state: 'ready' | 'pending' | 'paid' | 'failed';
}
export interface WalletStatus {
  mint: string | null;
  balance: number;
  funding: Funding[];
  payments: Payment[];
}
interface Config {
  mint: string;
  seed: string;
  store: string;
}
interface Deposit extends Funding {
  mint: string;
  quoteId: string;
}
interface Spend extends Payment {
  mint: string;
  hash: string;
  quoteId: string;
  attempted?: boolean;
}
interface Ledger extends DBSchema {
  config: { key: string; value: Config };
  deposits: { key: string; value: Deposit };
  spends: { key: string; value: Spend; indexes: { hash: string } };
}
type DB = IDBPDatabase<Ledger>;
type Core = { manager: Manager; repos: IndexedDbRepositories };
const EMPTY: WalletStatus = { mint: null, balance: 0, funding: [], payments: [] };
class WalletError extends Error {}
const now = () => Math.floor(Date.now() / 1000);

function mintURL(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new WalletError('Enter an HTTPS mint address without credentials, a query, or a fragment.');
  return url.href.replace(/\/+$/, '');
}
function amount(n: number) {
  if (!Number.isSafeInteger(n) || n < 1 || n > 100_000_000)
    throw new WalletError('Enter an amount from 1 to 100,000,000 sats.');
  return n;
}
function storeName(owner: string) {
  if (!/^[0-9a-f]{64}$/.test(owner)) throw new WalletError('Choose a wallet account.');
  return 'social-backup-cashu-' + owner;
}
async function locked<T>(owner: string, task: (db: DB) => Promise<T>) {
  const name = storeName(owner);
  return navigator.locks.request(name, async () => {
    const db = await openDB<Ledger>(name, 1, {
      upgrade(db) {
        db.createObjectStore('config');
        db.createObjectStore('deposits', { keyPath: 'id' });
        db.createObjectStore('spends', { keyPath: 'id' }).createIndex('hash', 'hash', { unique: true });
      },
    });
    try {
      return await task(db);
    } finally {
      db.close();
    }
  });
}
async function core<T>(cfg: Config, task: (core: Core) => Promise<T>) {
  const repos = new IndexedDbRepositories({ name: cfg.store });
  await repos.init();
  // Coco configures its Dexie schema lazily. Open it before a native backup transaction.
  await repos.mintRepository.getAllMints();
  // No subscription, timer or automatic payment at startup. Recovery targets an existing quote.
  const manager = new Manager(repos, async () => hex.decode(cfg.seed));
  try {
    return await task({ manager, repos });
  } catch (error) {
    if (error instanceof WalletError) throw error;
    // Upstream exceptions may include bearer proof secrets or complete responses from a mint.
    throw new WalletError(
      'The wallet could not finish this operation. Check your balance and refresh its status.',
    );
  } finally {
    try {
      await manager.dispose();
    } finally {
      if ('close' in repos.db && typeof repos.db.close === 'function') repos.db.close();
    }
  }
}
async function configured(db: DB) {
  const cfg = await db.get('config', 'wallet');
  if (!cfg) throw new WalletError('Choose your Cashu mint first.');
  return cfg;
}
function fundingView(d: Deposit): Funding {
  const { id, invoice, sats, expiry, state } = d;
  return { id, invoice, sats, expiry, state };
}
function tipDetails(tip: WalletTip | undefined): WalletTip | undefined {
  if (tip === undefined) return;
  if (
    !tip ||
    !/^[0-9a-f]{64}$/.test(tip.pubkey) ||
    !/^[a-z0-9_]{1,15}$/i.test(tip.handle) ||
    !/^[a-z0-9._+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,}$/i.test(tip.lightning) ||
    (tip.post !== undefined && !/^\d{1,25}$/.test(tip.post)) ||
    (tip.note !== undefined && !/^[0-9a-f]{64}$/.test(tip.note))
  )
    throw new WalletError('Invalid saved tip details.');
  return {
    pubkey: tip.pubkey,
    handle: tip.handle,
    lightning: tip.lightning,
    ...(tip.post && { post: tip.post }),
    ...(tip.note && { note: tip.note }),
  };
}
function paymentView(d: Spend): Payment {
  const { id, invoice, sats, fee, state } = d;
  return { id, invoice, sats, fee, state, ...(d.tip && { tip: tipDetails(d.tip) }) };
}
async function spendableSats(manager: Manager) {
  const balance = await manager.wallet.balances.total({ units: ['sat'] });
  return balance.spendable.toNumber();
}
export function availableWalletBalance(owner: string) {
  return locked(owner, async (db) => {
    const cfg = await db.get('config', 'wallet');
    return cfg ? core(cfg, ({ manager }) => spendableSats(manager)) : 0;
  });
}
async function snapshot(db: DB, cfg: Config, manager: Manager): Promise<WalletStatus> {
  const [balance, deposits, spends] = await Promise.all([
    spendableSats(manager),
    db.getAll('deposits'),
    db.getAll('spends'),
  ]);
  return {
    mint: cfg.mint,
    balance,
    funding: deposits.map(fundingView),
    payments: spends.map(paymentView),
  };
}
export function walletStatus(owner: string): Promise<WalletStatus> {
  return locked(owner, async (db) => {
    const cfg = await db.get('config', 'wallet');
    return cfg ? core(cfg, ({ manager }) => snapshot(db, cfg, manager)) : structuredClone(EMPTY);
  });
}
export function selectWalletMint(owner: string, rawUrl: string) {
  const mint = mintURL(rawUrl);
  return locked(owner, async (db) => {
    const current = await db.get('config', 'wallet');
    if (current?.mint === mint) return;
    if (current && (await occupied(db, current)))
      throw new WalletError('Withdraw your balance and finish pending operations before changing mint.');
    const cfg = current
      ? { ...current, mint }
      : {
          mint,
          seed: hex.encode(crypto.getRandomValues(new Uint8Array(64))),
          store: storeName(owner) + '-proofs',
        };
    await core(cfg, async ({ manager }) => {
      await manager.mint.addMint(mint, { trusted: true });
    });
    await db.put('config', cfg, 'wallet');
  });
}

async function recordDeposit(db: DB, quote: MintQuote, sats: number) {
  if (
    quote.method !== 'bolt11' ||
    quote.unit !== 'sat' ||
    quote.amount.toNumber() !== sats ||
    invoiceDetails(quote.request)?.msats !== sats * 1000
  )
    throw new WalletError('The mint returned an incorrect funding invoice.');
  const id = quote.mintUrl + '#' + quote.quoteId;
  const existing = await db.get('deposits', id);
  if (existing) return existing;
  const deposit: Deposit = {
    id,
    mint: quote.mintUrl,
    quoteId: quote.quoteId,
    invoice: quote.request,
    sats,
    expiry: quote.expiry ?? invoiceDetails(quote.request)!.expiresAt,
    state: 'pending',
  };
  await db.add('deposits', deposit);
  return deposit;
}
export function fundWallet(owner: string, sats: number) {
  amount(sats);
  return locked(owner, async (db) => {
    const cfg = await configured(db);
    return core(cfg, async ({ manager }) => {
      const quote = await manager.quotes.mint.create({
        mintUrl: cfg.mint,
        amount: Amount.from(sats),
        method: 'bolt11',
        unit: 'sat',
      });
      return fundingView(await recordDeposit(db, quote, sats));
    });
  });
}
async function refreshDeposit(db: DB, manager: Manager, d: Deposit) {
  if (d.state === 'paid' || d.state === 'failed') return fundingView(d);
  const ref = { mintUrl: d.mint, quoteId: d.quoteId, method: 'bolt11' as const };
  if (d.expiry <= now()) {
    const quote = await manager.quotes.mint.refresh(ref);
    if (quote.method === 'bolt11' && quote.state === 'UNPAID') {
      d.state = 'expired';
      await db.put('deposits', d);
      return fundingView(d);
    }
  }
  let operation = (await manager.ops.mint.listByQuote(ref))[0];
  if (operation?.state === 'init') {
    await manager.recoverPendingMintOperations();
    operation = (await manager.ops.mint.listByQuote(ref))[0];
  }
  if (!operation) operation = await manager.ops.mint.prepare({ quote: ref, amount: Amount.from(d.sats) });
  const refreshed = await manager.ops.mint.refresh(operation.id);
  const quote = await manager.quotes.mint.get(ref);
  if (refreshed.state === 'failed' || (refreshed.state === 'finalized' && refreshed.error))
    d.state = 'failed';
  else if (refreshed.state === 'finalized') d.state = 'paid';
  else if (quote?.method === 'bolt11' && quote.state === 'UNPAID' && d.expiry < now()) d.state = 'expired';
  await db.put('deposits', d);
  return fundingView(d);
}
export function refreshFunding(owner: string, id: string) {
  return locked(owner, async (db) => {
    const d = await db.get('deposits', id);
    if (!d) throw new WalletError('Unknown funding invoice.');
    return core(await configured(db), ({ manager }) => refreshDeposit(db, manager, d));
  });
}
/** Claim an unlocked, paid NUT-04 quote from the selected mint. Its invoice and status come from that mint. */
export function claimWalletQuote(owner: string, mint: string, quoteId: string) {
  if (!/^[\w.:-]{1,256}$/.test(quoteId)) throw new WalletError('Invalid funding quote.');
  return locked(owner, async (db) => {
    const cfg = await configured(db);
    if (cfg.mint !== mintURL(mint)) throw new WalletError('This deposit belongs to a different mint.');
    return core(cfg, async ({ manager }) => {
      const existing = await db.get('deposits', cfg.mint + '#' + quoteId);
      if (existing) return refreshDeposit(db, manager, existing);
      const response = await fetch(cfg.mint + '/v1/mint/quote/bolt11/' + encodeURIComponent(quoteId), {
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new WalletError('The mint could not verify this deposit.');
      const wire = await response.json();
      const details = invoiceDetails(wire.request);
      if (!details || wire.quote !== quoteId || wire.unit !== 'sat' || wire.state !== 'PAID' || wire.pubkey)
        throw new WalletError('The mint must confirm an unlocked, paid deposit in sats.');
      const sats = amount(details.msats / 1000);
      if (wire.amount !== undefined && Number(wire.amount) !== sats)
        throw new WalletError('Deposit amount mismatch.');
      const quote = await manager.quotes.mint.import({
        mintUrl: cfg.mint,
        method: 'bolt11',
        quote: {
          quote: quoteId,
          request: wire.request,
          state: 'PAID',
          unit: 'sat',
          amount: Amount.from(sats),
          expiry: typeof wire.expiry === 'number' ? wire.expiry : details.expiresAt,
        },
      });
      return refreshDeposit(db, manager, await recordDeposit(db, quote, sats));
    });
  });
}

function projectOperation(spend: Spend, op: MeltOperation) {
  if (op.state === 'init') return;
  if (
    op.unit !== 'sat' ||
    op.amount.toNumber() !== spend.sats ||
    op.quoteId !== spend.quoteId ||
    op.mintUrl !== spend.mint
  )
    throw new WalletError('The saved payment does not match its mint quote.');
  // In a direct melt, the inputs bound the entire possible debit. In a split, the
  // swap's keep outputs are retained before the melt. This includes input fees and rounding.
  const keep = op.swapOutputData?.keep.reduce((sum, o) => sum + Number(o.blindedMessage.amount), 0) ?? 0;
  spend.fee =
    op.state === 'finalized' && op.effectiveFee !== undefined
      ? op.effectiveFee.add(op.swap_fee).toNumber()
      : op.inputAmount.toNumber() - keep - spend.sats;
  if (!Number.isSafeInteger(spend.fee) || spend.fee < 0) throw new WalletError('Invalid payment fee.');
  if (op.state === 'finalized' && op.finalizedData?.preimage) {
    const preimage = op.finalizedData.preimage;
    if (!/^[0-9a-f]{64}$/i.test(preimage) || hex.encode(sha256(hex.decode(preimage))) !== spend.hash)
      throw new WalletError(
        'The mint returned an invalid payment preimage. Check the payment with your mint.',
      );
  }
  spend.state =
    op.state === 'finalized'
      ? 'paid'
      : op.state === 'prepared'
        ? 'ready'
        : op.state === 'failed' || op.state === 'rolled_back'
          ? 'failed'
          : 'pending';
}
async function operationFor(manager: Manager, spend: Spend) {
  const ref = { mintUrl: spend.mint, quoteId: spend.quoteId, method: 'bolt11' as const };
  return (await manager.ops.melt.getByQuote(ref)) ?? (await manager.ops.melt.prepare({ quote: ref }));
}
async function savePayment(db: DB, spend: Spend, op: MeltOperation) {
  projectOperation(spend, op);
  await db.put('spends', spend);
  return paymentView(spend);
}
export function prepareWalletPayment(
  owner: string,
  id: string,
  invoice: string,
  sats: number,
  tip?: WalletTip,
) {
  const target = tipDetails(tip);
  const details = invoiceDetails(invoice);
  if (!details || details.msats !== amount(sats) * 1000 || !/^[a-zA-Z0-9:_-]{1,160}$/.test(id))
    throw new WalletError('Invalid tip invoice.');
  return locked(owner, async (db) => {
    const cfg = await configured(db);
    return core(cfg, async ({ manager }) => {
      let spend = await db.get('spends', id);
      if (
        spend &&
        (spend.invoice !== invoice ||
          spend.sats !== sats ||
          JSON.stringify(spend.tip) !== JSON.stringify(target))
      )
        throw new WalletError('This tip already has a different invoice.');
      if (spend && spend.state !== 'ready') return paymentView(spend);
      if (!spend) {
        if (details.expiresAt <= now()) throw new WalletError('The tip invoice has expired.');
        if (await db.getFromIndex('spends', 'hash', details.paymentHash))
          throw new WalletError('This invoice already belongs to a saved payment.');
        const balance = await manager.wallet.balances.total({ units: ['sat'], mintUrls: [cfg.mint] });
        if (balance.spendable.toNumber() < sats)
          throw new WalletError('Your Cashu balance is too low for this tip.');
        const quote = await manager.quotes.melt.create({
          mintUrl: cfg.mint,
          method: 'bolt11',
          unit: 'sat',
          methodData: { invoice },
        });
        if (
          quote.unit !== 'sat' ||
          quote.amount.toNumber() !== sats ||
          quote.request.toLowerCase() !== invoice.toLowerCase()
        )
          throw new WalletError('The mint returned a quote for a different payment.');
        spend = {
          id,
          mint: cfg.mint,
          invoice,
          sats,
          fee: 0,
          hash: details.paymentHash,
          quoteId: quote.quoteId,
          state: 'pending',
          ...(target && { tip: target }),
        };
        // Save the quote before preparing it: restart finds any reserved proofs by quote ID.
        await db.add('spends', spend);
      }
      try {
        return await savePayment(db, spend, await operationFor(manager, spend));
      } catch (error) {
        const existing = await manager.ops.melt.getByQuote({ mintUrl: spend.mint, quoteId: spend.quoteId });
        if (!existing) {
          // Failed before reserving any proofs. A fresh quote may now be reviewed.
          await db.delete('spends', id);
        }
        throw error;
      }
    });
  });
}
async function updatePayment(
  owner: string,
  id: string,
  action: 'refresh' | 'confirm' | 'cancel',
  maxFee?: number,
) {
  return locked(owner, async (db) => {
    const spend = await db.get('spends', id);
    if (!spend) throw new WalletError('Unknown tip payment.');
    if (spend.state === 'paid' || spend.state === 'failed') return paymentView(spend);
    return core(await configured(db), async ({ manager }) => {
      let op = await manager.ops.melt.getByQuote({ mintUrl: spend.mint, quoteId: spend.quoteId });
      if (op?.state === 'init' || (!op && !spend.attempted)) {
        await manager.ops.melt.recovery.run();
        op = await manager.ops.melt.getByQuote({ mintUrl: spend.mint, quoteId: spend.quoteId });
      }
      if (!op && action === 'cancel' && !spend.attempted) {
        spend.state = 'failed';
        await db.put('spends', spend);
        return paymentView(spend);
      }
      if (!op) {
        if (spend.attempted)
          throw new WalletError(
            'Payment status is uncertain. Keep the wallet backup and check with the mint.',
          );
        op = await operationFor(manager, spend);
      }
      if (action === 'cancel' && op.state === 'prepared') {
        await manager.ops.melt.cancel(op.id);
        op = (await manager.ops.melt.get(op.id))!;
      } else if (action === 'confirm' && op.state === 'prepared') {
        projectOperation(spend, op);
        if (spend.fee !== maxFee) throw new WalletError('Review the current payment fee before confirming.');
        if ((invoiceDetails(spend.invoice)?.expiresAt ?? 0) <= now())
          throw new WalletError('The tip invoice has expired. Cancel the quote.');
        // Persist uncertainty before the network call. If the response is lost, refresh this exact operation.
        spend.state = 'pending';
        spend.attempted = true;
        await db.put('spends', spend);
        try {
          op = await manager.ops.melt.execute(op.id);
        } catch {
          const saved = await manager.ops.melt.get(op.id);
          if (!saved) return paymentView(spend);
          op = saved;
        }
      } else if (op.state === 'pending' || op.state === 'executing') {
        op = await manager.ops.melt.refresh(op.id);
      }
      return savePayment(db, spend, op);
    });
  });
}
export const confirmWalletPayment = (owner: string, id: string, maxFee: number) =>
  updatePayment(owner, id, 'confirm', maxFee);
export const refreshWalletPayment = (owner: string, id: string) => updatePayment(owner, id, 'refresh');
export const cancelWalletPayment = (owner: string, id: string) => updatePayment(owner, id, 'cancel');

async function occupied(db: DB, cfg: Config) {
  return core(cfg, async ({ manager }) => {
    const [balance, deposits, spends] = await Promise.all([
      manager.wallet.balances.total({ units: ['sat'] }),
      db.getAll('deposits'),
      db.getAll('spends'),
    ]);
    return (
      balance.total.toNumber() > 0 ||
      deposits.some((d) => d.state === 'pending') ||
      spends.some((p) => p.state === 'ready' || p.state === 'pending')
    );
  });
}
export function walletHasFundsOrPending(owner: string) {
  return locked(owner, async (db) => {
    const cfg = await db.get('config', 'wallet');
    return cfg ? occupied(db, cfg) : false;
  });
}
export function eraseEmptyWallet(owner: string) {
  return locked(owner, async (db) => {
    const cfg = await db.get('config', 'wallet');
    if (cfg && (await occupied(db, cfg)))
      throw new WalletError(
        'Withdraw your balance and finish pending wallet operations before deleting this account.',
      );
    // Include interrupted setup/restore databases, which never became the active wallet.
    for (const name of new Set([
      storeName(owner) + '-proofs',
      storeName(owner) + '-restore',
      ...(cfg ? [cfg.store] : []),
    ]))
      await deleteDB(name);
    db.close();
    await deleteDB(storeName(owner));
  });
}

interface Backup {
  owner: string;
  mint: string;
  seed: string;
  deposits: Deposit[];
  spends: Spend[];
  tables: Record<string, unknown[]>;
}
const backupFormat = 'social-backup-cashu-v1';
const backupLimit = 32 * 1024 * 1024;
const utf8 = new TextEncoder();
async function backupKey(passphrase: string, salt: Uint8Array<ArrayBuffer>) {
  if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024)
    throw new WalletError('Use a recovery passphrase of 12 to 1,024 characters.');
  const material = await crypto.subtle.importKey('raw', utf8.encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
export function exportWallet(owner: string, passphrase: string) {
  return locked(owner, async (db) => {
    const cfg = await configured(db);
    const salt = crypto.getRandomValues(new Uint8Array(16)),
      iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await backupKey(passphrase, salt);
    const raw = await openDB(cfg.store);
    let tables: Backup['tables'];
    try {
      const names = Array.from(raw.objectStoreNames);
      const tx = raw.transaction(names);
      tables = Object.fromEntries(
        await Promise.all(names.map(async (name) => [name, await tx.objectStore(name).getAll()])),
      );
      await tx.done;
    } finally {
      raw.close();
    }
    const contents: Backup = {
      owner,
      mint: cfg.mint,
      seed: cfg.seed,
      tables,
      deposits: await db.getAll('deposits'),
      spends: await db.getAll('spends'),
    };
    const data = utf8.encode(JSON.stringify(contents));
    if ((data.byteLength * 4) / 3 + 1024 > backupLimit)
      throw new WalletError('This wallet exceeds the recovery file size limit.');
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: utf8.encode(backupFormat) },
      key,
      data,
    );
    return JSON.stringify({
      format: backupFormat,
      salt: base64.encode(salt),
      iv: base64.encode(iv),
      data: base64.encode(new Uint8Array(encrypted)),
    });
  });
}

/** Reconcile older backups against the mint. Preserve reserved inputs, pending operations and
 * the higher of the snapshot and mint-observed deterministic output counters. */
async function reconcileRestore(cfg: Config, { manager, repos }: Core) {
  await manager.ops.melt.recovery.run();
  await manager.recoverPendingMintOperations();
  const memory = new MemoryRepositories();
  await memory.init();
  const scan = new Manager(memory, async () => hex.decode(cfg.seed));
  try {
    await scan.mint.addMint(cfg.mint, { trusted: true });
    await scan.wallet.restore(cfg.mint, { units: ['sat'] });
    const keysets = await memory.keysetRepository.getKeysetsByMintUrl(cfg.mint);
    const checker = new Wallet(cfg.mint);
    const scannedProofs = await memory.proofRepository.getReadyProofs(cfg.mint, { unit: 'sat' });
    for (const set of keysets.filter((k) => k.unit === 'sat')) {
      if (!(await repos.keysetRepository.getKeysetById(cfg.mint, set.id)))
        await repos.keysetRepository.addKeyset(set);
      const known = await repos.proofRepository.getProofsByKeysetId(cfg.mint, set.id);
      const available = new Map(scannedProofs.filter((p) => p.id === set.id).map((p) => [p.secret, p]));
      // Snapshot records carry reservations and must take precedence over the scan.
      for (const p of known) available.set(p.secret, p);
      const proofs = Array.from(available.values());
      if (proofs.length) {
        const states = await checker.checkProofsStates(proofs);
        if (states.length !== proofs.length)
          throw new WalletError('The mint returned incomplete recovery data.');
        const saved = proofs.map((p, i) => {
          const state = states[i].state;
          if (state !== 'SPENT' && state !== 'UNSPENT' && state !== 'PENDING')
            throw new WalletError('Unknown proof state.');
          return {
            ...p,
            state:
              state === 'SPENT'
                ? ('spent' as const)
                : state === 'PENDING'
                  ? ('inflight' as const)
                  : p.state === 'inflight'
                    ? p.state
                    : ('ready' as const),
          };
        });
        const knownSecrets = new Set(known.map((p) => p.secret));
        const newProofs = saved.filter((p) => !knownSecrets.has(p.secret));
        if (newProofs.length) await repos.proofRepository.saveProofs(cfg.mint, newProofs);
        for (const state of ['ready', 'inflight', 'spent'] as const) {
          const changed = saved
            .filter((p) => knownSecrets.has(p.secret) && p.state === state)
            .map((p) => p.secret);
          if (changed.length) await repos.proofRepository.setProofState(cfg.mint, changed, state);
        }
      }
      const existing = await repos.counterRepository.getCounter(cfg.mint, set.id);
      const scanned = await memory.counterRepository.getCounter(cfg.mint, set.id);
      await repos.counterRepository.setCounter(
        cfg.mint,
        set.id,
        Math.max(existing?.counter ?? 0, scanned?.counter ?? 0, proofs.length ? 1 : 0),
      );
    }
  } finally {
    await scan.dispose();
  }
}
export function restoreWallet(owner: string, json: string, passphrase: string) {
  return locked(owner, async (db) => {
    if (await db.get('config', 'wallet'))
      throw new WalletError('Restore requires an account without a configured wallet.');
    if (typeof json !== 'string' || json.length > backupLimit)
      throw new WalletError('Invalid wallet recovery file.');
    const file = JSON.parse(json);
    if (file.format !== backupFormat) throw new WalletError('Unknown wallet recovery file format.');
    const salt = Uint8Array.from(base64.decode(file.salt)),
      iv = Uint8Array.from(base64.decode(file.iv));
    if (salt.length !== 16 || iv.length !== 12) throw new WalletError('Invalid wallet recovery file.');
    const key = await backupKey(passphrase, salt);
    const clear = await crypto.subtle
      .decrypt(
        { name: 'AES-GCM', iv, additionalData: utf8.encode(backupFormat) },
        key,
        Uint8Array.from(base64.decode(file.data)),
      )
      .catch(() => {
        throw new WalletError('Incorrect passphrase or damaged wallet file.');
      });
    const data: Backup = JSON.parse(new TextDecoder().decode(clear));
    if (
      data.owner !== owner ||
      !/^[a-f0-9]{128}$/.test(data.seed) ||
      !Array.isArray(data.deposits) ||
      !Array.isArray(data.spends)
    )
      throw new WalletError('The wallet file is invalid or belongs to a different account.');
    const spends = data.spends.map((s) => ({ ...s, tip: tipDetails(s.tip) }));
    const cfg = { seed: data.seed, mint: mintURL(data.mint), store: storeName(owner) + '-restore' };
    // A worker can stop midway through a previous restore. This database is unreferenced until commit.
    await deleteDB(cfg.store);
    try {
      await core(cfg, async (context) => {
        const raw = await openDB(cfg.store);
        try {
          const names = Array.from(raw.objectStoreNames);
          if (
            Object.keys(data.tables).length !== names.length ||
            names.some((n) => !Array.isArray(data.tables[n]))
          )
            throw new WalletError('Unsupported wallet storage format.');
          const tx = raw.transaction(names, 'readwrite');
          await Promise.all(
            names.flatMap((name) => data.tables[name].map((row) => tx.objectStore(name).add(row))),
          );
          await tx.done;
        } finally {
          raw.close();
        }
        await reconcileRestore(cfg, context);
      });
      const tx = db.transaction(['config', 'spends', 'deposits'], 'readwrite');
      // Switch to the reconciled wallet and recover its journal in a single commit.
      await Promise.all([
        tx.objectStore('config').add(cfg, 'wallet'),
        ...spends.map((s) => tx.objectStore('spends').add(s)),
        ...data.deposits.map((d) => tx.objectStore('deposits').add(d)),
      ]);
      await tx.done;
    } catch (error) {
      await deleteDB(cfg.store);
      throw error;
    }
  });
}
