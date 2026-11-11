import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { unhex } from './model.js';

const api = globalThis.browser ?? chrome;
const requests = new Map();
const grantKey = (id) => 'grant-' + id;

export async function enableSigner() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || new URL(tab.url).protocol !== 'https:')
    throw Error('Open an HTTPS site, then use this button.');
  const origin = new URL(tab.url).origin,
    token = crypto.randomUUID();
  const target = { tabId: tab.id };
  // Only the isolated bridge holds this tab capability. Page messages never contain it.
  await api.scripting.executeScript({ target, func: installBridge, args: [token] });
  const [result] = await api.scripting.executeScript({
    target,
    world: 'MAIN',
    func: installProvider,
  });
  if (result.result !== true) throw Error('This page already has another Nostr signer.');
  await api.storage.session.set({ [grantKey(tab.id)]: { token, origin } });
  return origin;
}

function installBridge(token) {
  const api = globalThis.browser ?? chrome;
  globalThis.nostrBackupBridge?.abort();
  const controller = new AbortController();
  globalThis.nostrBackupBridge = controller;
  window.addEventListener(
    'message',
    async (e) => {
      const data = e.data;
      if (
        e.source !== window ||
        e.origin !== location.origin ||
        data?.channel !== 'nostr-backup-request' ||
        typeof data.id !== 'string' ||
        data.id.length > 64
      )
        return;
      try {
        const reply = await api.runtime.sendMessage({
          type: 'nip07',
          token,
          method: data.method,
          event: data.event,
        });
        window.postMessage(
          { channel: 'nostr-backup-response', id: data.id, ...reply },
          location.origin,
        );
      } catch {
        window.postMessage(
          {
            channel: 'nostr-backup-response',
            id: data.id,
            ok: false,
            error: 'Signer unavailable.',
          },
          location.origin,
        );
      }
    },
    { signal: controller.signal },
  );
}
function installProvider() {
  if (window.nostr) return window.nostr === window.nostrBackupProvider;
  function call(method, event) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const finish = () => {
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
      };
      const timer = setTimeout(() => {
        finish();
        reject(Error('Signer timed out.'));
      }, 75000);
      function onMessage(e) {
        if (
          e.source !== window ||
          e.origin !== location.origin ||
          e.data?.channel !== 'nostr-backup-response' ||
          e.data.id !== id
        )
          return;
        finish();
        e.data.ok ? resolve(e.data.value) : reject(Error(e.data.error));
      }
      window.addEventListener('message', onMessage);
      window.postMessage({ channel: 'nostr-backup-request', id, method, event }, location.origin);
    });
  }
  window.nostrBackupProvider = Object.freeze({
    getPublicKey: () => call('getPublicKey'),
    signEvent: (event) => call('signEvent', event),
  });
  window.nostr = window.nostrBackupProvider;
  return true;
}
export function template(input) {
  if (
    !input ||
    !Number.isInteger(input.kind) ||
    input.kind < 0 ||
    input.kind > 65535 ||
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
export async function handleSignerRequest(msg, sender, pubkey, sessionKey) {
  const tabId = sender.tab?.id,
    key = grantKey(tabId);
  const grant = (await api.storage.session.get(key))[key];
  if (
    !grant ||
    grant.token !== msg.token ||
    grant.origin !== new URL(sender.url).origin ||
    sender.frameId !== 0
  )
    throw Error('Enable the signer for this tab first.');
  if (!(await sessionKey())) throw Error('Signer is locked.');
  if (msg.method === 'getPublicKey') return pubkey;
  if (msg.method !== 'signEvent') throw Error('Unsupported signer method.');
  const event = template(msg.event);
  if (Array.from(requests.values()).some((r) => r.tabId === tabId))
    throw Error('There is already a request from this tab.');
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(Error('Signing request expired.')), 60000);
    function finish(error, value) {
      clearTimeout(timer);
      requests.delete(id);
      error ? reject(error) : resolve(value);
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
export async function approval(msg, sessionKey) {
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
    new URL(tab.url).origin !== request.origin
  )
    throw Error('Signer or tab changed.');
  request.finish(null, finalizeEvent(request.event, unhex(key)));
}
api.windows.onRemoved.addListener((win) => {
  for (const r of requests.values()) if (r.windowId === win) r.finish(Error('Signature declined.'));
});
api.tabs.onRemoved.addListener((id) => {
  void api.storage.session.remove(grantKey(id));
});
