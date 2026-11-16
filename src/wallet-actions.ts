import type { WalletIntent } from './wallet-intent.ts';
import type * as engine from './cashu-wallet.ts';

export interface WalletIdentity {
  pubkey: string;
  unlocked: boolean;
  enabled: boolean;
  autoReceive: boolean;
  quickTipSats?: number;
  lastIncoming?: IncomingSummary;
}
export interface IncomingSummary {
  claimed: number;
  available: number;
  mints: string[];
  checkedAt: number;
}
export interface WalletRPC {
  walletIdentity: {};
  walletPreferences: { enabled: boolean; autoReceive: boolean };
  walletSetQuickTip: {sats: number};
  walletQuickConfirm: {id: string; token: string; maxFee: number};
  walletIncoming: {};
  walletDiscoverMint: {};
  walletReview: { id: string };
  walletStatus: {};
  walletSelectMint: { url: string };
  walletFund: { sats: number };
  walletRefreshFunding: { id: string };
  walletPrepare: { id: string };
  walletPrepareWithdrawal: { invoice: string };
  walletConfirm: { id: string; maxFee: number };
  walletRefresh: { id: string };
  walletCancel: { id: string };
  walletExport: { passphrase: string };
  walletRestore: { json: string; passphrase: string };
}
type Funding = Awaited<ReturnType<typeof engine.fundWallet>>;
type Payment = Awaited<ReturnType<typeof engine.prepareWalletPayment>>;
export interface WalletResults {
  walletIdentity: WalletIdentity;
  walletPreferences: WalletIdentity;
  walletSetQuickTip: WalletIdentity;
  walletQuickConfirm: Payment;
  walletIncoming: IncomingSummary;
  walletDiscoverMint: string;
  walletReview: WalletIntent;
  walletStatus: Awaited<ReturnType<typeof engine.walletStatus>>;
  walletSelectMint: void;
  walletFund: Funding;
  walletRefreshFunding: Funding;
  walletPrepare: Payment;
  walletPrepareWithdrawal: Payment;
  walletConfirm: Payment;
  walletRefresh: Payment;
  walletCancel: Payment;
  walletExport: string;
  walletRestore: void;
}
