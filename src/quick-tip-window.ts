import { bytesToHex } from '@noble/hashes/utils.js';
import type { Sender } from './platform.d.ts';
import type { WalletIntent } from './wallet-intent.ts';

const api = globalThis.browser ?? chrome;
const grants = new Map<string, {
  owner: string; id: string; windowId: number; expires: number; deadline: number;
}>();
const lifetime = 60_000;

function expired(grant: {expires: number; deadline: number}) {
  return Date.now() >= grant.expires || performance.now() >= grant.deadline;
}

export function revokeQuickTips(owner: string, id?: string) {
  for (const [token, grant] of grants) if (grant.owner === owner && (!id || grant.id === id)) grants.delete(token);
}

api.windows.onRemoved.addListener(id => {
  for (const [token, grant] of grants) if (grant.windowId === id) grants.delete(token);
});

/** Only the extension popup receives the bearer token. A failed open creates no payment authority. */
export async function openQuickTip(tip: WalletIntent, authorize: boolean) {
  for (const [token, grant] of grants) {
    if (expired(grant)) grants.delete(token);
    else if (grant.owner === tip.account && grant.id === tip.id) {
      if (authorize) return;
      grants.delete(token);
    }
  }
  const token = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const url = api.runtime.getURL('wallet.html') + '#' + tip.id + (authorize ? '?quick=' + token : '');
  const win = await api.windows.create({url, type:'popup', width:430, height:580}).catch(() => undefined);
  if (!win || !(Number.isInteger(win.id) && win.id! >= 0)) throw Error('Could not open the tip window. Tap again to retry.');
  if (authorize) grants.set(token, {
    owner:tip.account, id:tip.id, windowId:win.id!, expires:Date.now() + lifetime, deadline:performance.now() + lifetime,
  });
}

export function consumeQuickTip(owner: string, id: string, token: string, sender: Sender) {
  const grant = grants.get(token);
  if (!grant || grant.owner !== owner || grant.id !== id || sender.frameId !== 0 ||
      sender.tab?.windowId !== grant.windowId || sender.url?.split('#')[0] !== api.runtime.getURL('wallet.html'))
    throw Error('Review this tip in the extension wallet.');
  grants.delete(token);
  if (expired(grant)) throw Error('One-click approval expired. Review this tip in the wallet.');
  return async () => {
    const active = await api.tabs.query({active:true, currentWindow:true});
    if (expired(grant) || sender.tab?.id === undefined || !active.some(tab => tab.id === sender.tab!.id))
      throw Error('The tip window is no longer active. Review the tip before paying.');
  };
}
