import type { Event as NostrEvent, EventTemplate } from 'nostr-tools/pure';
import type { Message, Approval } from './types.ts';
import type { Sender } from './platform.d.ts';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { unhex } from './model.ts';

import { forgetPermissions, hasPermission, permissionLabel, savePermission } from './signer-storage.ts';

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
let revision = 0;

export async function revokeSession() {
  revision++;
  for (const request of requests.values())
    request.finish(Error('Request cancelled because you logged out.'));
  await api.storage.session.clear();
}

export async function revokeWebsite(owner: string, origin: string) {
  revision++;
  for (const request of requests.values())
    if (request.pubkey === owner && request.origin === origin)
      request.finish(Error('Website permission revoked.'));
  await forgetPermissions(owner, origin);
  const grants = await api.storage.session.get(null);
  const names = Object.keys(grants).filter((name): name is `grant-${number}` => /^grant-\d+$/.test(name));
  for (const name of names)
    if (grants[name]?.origin === origin && grants[name]?.loginPubkey === owner)
      await api.storage.session.remove(name);
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
  if (JSON.stringify(event).length > 131072) throw Error('This request is too large to approve.');
  return event;
}
export async function handleSignerRequest(
  msg: Message<'nip07'>,
  sender: Sender,
  pubkey: string,
  sessionKey: SessionKey,
) {
  const tabId = sender.tab?.id;
  const started = revision;
  if (tabId === undefined || !sender.url) throw Error('Allow the extension to work on this tab first.');
  const key = grantKey(tabId);
  const grant = (await api.storage.session.get(key))[key];
  if (
    !grant ||
    grant.token !== msg.token ||
    grant.origin !== new URL(sender.url).origin ||
    sender.frameId !== 0
  )
    throw Error('Allow the extension to work on this tab first.');
  if (!(await sessionKey())) throw Error('Your account is locked.');
  if (msg.method !== 'getPublicKey' && msg.method !== 'signEvent') throw Error('This type of request is not supported.');
  const event = msg.method === 'signEvent' ? template(msg.event) : undefined;
  if ((!event && grant.loginPubkey === pubkey) || await hasPermission(pubkey, grant.origin, event?.kind ?? -1)) {
    const tab = await api.tabs.get(tabId);
    const current = (await api.storage.session.get(key))[key];
    const secret = await sessionKey();
    if (started !== revision || !secret || getPublicKey(unhex(secret)) !== pubkey || current?.token !== msg.token ||
        !tab.url || new URL(tab.url).origin !== grant.origin) throw Error('The account or website changed.');
    return event ? finalizeEvent(event, unhex(secret)) : pubkey;
  }
  if (started !== revision) throw Error('Website permission changed.');
  if (Array.from(requests.values()).some((r) => r.tabId === tabId))
    throw Error('There is already a request from this tab.');
  const id = crypto.randomUUID();
  return new Promise<NostrEvent | string>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (requests.has(id)) finish(Error('The request expired.'));
    }, 60000);
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
    request.finish(Error('Request declined.'));
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
    throw Error('The account or website changed.');
  const kind = request.event?.kind ?? -1;
  if (msg.remember && !permissionLabel(kind)) throw Error('This request needs individual approval.');
  // Consume the decision before any asynchronous writes. A closed prompt or
  // duplicate click cannot change a decision while its permission is saving.
  const result = request.event ? finalizeEvent(request.event, unhex(key)) : request.pubkey;
  requests.delete(msg.id);
  try {
    if (msg.remember) await savePermission(request.pubkey, request.origin, kind);
    if (!request.event) await api.storage.session.set({ [name]: { ...grant, loginPubkey: request.pubkey } });
    request.finish(null, result);
  } catch (error) {
    request.finish(Error('Could not save website permission.'));
    throw error;
  }
}
api.windows.onRemoved.addListener((win) => {
  for (const r of requests.values()) if (r.windowId === win) r.finish(Error('Request declined.'));
});
api.tabs.onRemoved.addListener((id) => {
  for (const r of requests.values()) if (r.tabId === id) r.finish(Error('Request tab closed.'));
  void api.storage.session.remove(grantKey(id));
});
