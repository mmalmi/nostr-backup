import type { Event as NostrEvent, EventTemplate } from 'nostr-tools/pure';
import type { Message, Approval } from './types.ts';
import type { Sender } from './platform.d.ts';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { unhex } from './model.ts';

import { hasPermission, savePermission } from './signer-storage.ts';

type SessionKey = () => Promise<string | undefined>;
interface PendingSignature extends Approval {
  token: string;
  tabId: number;
  windowId?: number;
  finish(error: Error | null, value?: NostrEvent | string): void;
}

const api = globalThis.browser ?? chrome;
const requests = new Map<string, PendingSignature>();
const grantKey = (id: number) => `grant-${id}` as const;

export async function revokeSession() {
  for (const request of requests.values())
    request.finish(Error('Signing request cancelled on logout.'));
  await api.storage.session.clear();
}

export function template(value: unknown): EventTemplate {
  const input = value as Partial<EventTemplate> | null;
  if (
    !input ||
    typeof input.kind !== 'number' ||
    !Number.isInteger(input.kind) ||
    input.kind < 0 ||
    input.kind > 65535 ||
    typeof input.created_at !== 'number' ||
    !Number.isSafeInteger(input.created_at) ||
    input.created_at < 0 ||
    typeof input.content !== 'string' ||
    !Array.isArray(input.tags) ||
    !input.tags.every((t) => Array.isArray(t) && t.length && t.every((v) => typeof v === 'string'))
  )
    throw Error('Invalid Nostr event.');
  const event = {
    kind: input.kind,
    created_at: input.created_at,
    tags: input.tags,
    content: input.content,
  };
  if (JSON.stringify(event).length > 131072) throw Error('Event exceeds the signing limit.');
  return event;
}
export async function handleSignerRequest(
  msg: Message<'nip07'>,
  sender: Sender,
  pubkey: string,
  sessionKey: SessionKey,
) {
  const tabId = sender.tab?.id;
  if (tabId === undefined || !sender.url) throw Error('Enable the signer for this tab first.');
  const key = grantKey(tabId);
  const grant = (await api.storage.session.get(key))[key];
  if (
    !grant ||
    grant.token !== msg.token ||
    grant.origin !== new URL(sender.url).origin ||
    sender.frameId !== 0
  )
    throw Error('Enable the signer for this tab first.');
  if (!(await sessionKey())) throw Error('Signer is locked.');
  if (msg.method === 'getPublicKey' && grant.loginPubkey === pubkey) return pubkey;
  if (msg.method !== 'getPublicKey' && msg.method !== 'signEvent') throw Error('Unsupported signer method.');
  const event = msg.method === 'signEvent' ? template(msg.event) : undefined;
  if (await hasPermission(pubkey, grant.origin, event?.kind ?? -1)) {
    const tab = await api.tabs.get(tabId);
    const current = (await api.storage.session.get(key))[key];
    const secret = await sessionKey();
    if (!secret || getPublicKey(unhex(secret)) !== pubkey || current?.token !== msg.token ||
        !tab.url || new URL(tab.url).origin !== grant.origin) throw Error('Signer or tab changed.');
    return event ? finalizeEvent(event, unhex(secret)) : pubkey;
  }
  if (Array.from(requests.values()).some((r) => r.tabId === tabId))
    throw Error('There is already a request from this tab.');
  const id = crypto.randomUUID();
  return new Promise<NostrEvent | string>((resolve, reject) => {
    const timer = setTimeout(() => finish(Error('Signing request expired.')), 60000);
    function finish(error: Error | null, value?: NostrEvent | string) {
      clearTimeout(timer);
      requests.delete(id);
      if (error) reject(error);
      else if (value) resolve(value);
    }
    requests.set(id, { event, origin: grant.origin, token: grant.token, tabId, pubkey, finish });
    api.windows
      .create({
        url: api.runtime.getURL('approve.html') + '#' + id,
        type: 'popup',
        width: 500,
        height: 580,
      })
      .then((win) => {
        const r = requests.get(id);
        if (r) r.windowId = win.id;
      }, finish);
  });
}
export async function approval(msg: Message<'approval'>, sessionKey: SessionKey) {
  const request = requests.get(msg.id);
  if (!request) throw Error('Request expired. Ask the site to try again.');
  if (msg.decision === undefined)
    return { origin: request.origin, event: request.event, pubkey: request.pubkey };
  if (msg.decision !== true) {
    request.finish(Error('Signature declined.'));
    return;
  }
  const key = await sessionKey();
  const tab = await api.tabs.get(request.tabId);
  const name = grantKey(request.tabId);
  const grant = (await api.storage.session.get(name))[name];
  if (
    requests.get(msg.id) !== request ||
    !key ||
    getPublicKey(unhex(key)) !== request.pubkey ||
    grant?.token !== request.token ||
    !tab.url ||
    new URL(tab.url).origin !== request.origin
  )
    throw Error('Signer or tab changed.');
  if (msg.remember) await savePermission(request.pubkey, request.origin, request.event?.kind ?? -1);
  if (!request.event) await api.storage.session.set({ [name]: { ...grant, loginPubkey: request.pubkey } });
  request.finish(null, request.event ? finalizeEvent(request.event, unhex(key)) : request.pubkey);
}
api.windows.onRemoved.addListener((win) => {
  for (const r of requests.values()) if (r.windowId === win) r.finish(Error('Signature declined.'));
});
api.tabs.onRemoved.addListener((id) => {
  void api.storage.session.remove(grantKey(id));
});
