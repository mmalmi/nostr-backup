import type { Event as NostrEvent, EventTemplate } from 'nostr-tools/pure';
function installProvider() {
  if (window.nostr) return window.nostr === window.socialBackupProvider;
  function call(method: 'getPublicKey'): Promise<string>;
  function call(method: 'signEvent', event: EventTemplate): Promise<NostrEvent>;
  function call(method: string, event?: EventTemplate): Promise<string | NostrEvent> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const finish = () => {
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
      };
      const timer = setTimeout(() => {
        finish();
        reject(Error('Account request timed out.'));
      }, 75000);
      function onMessage(e: MessageEvent) {
        if (
          e.source !== window ||
          e.origin !== location.origin ||
          e.data?.channel !== 'social-backup-response' ||
          e.data.id !== id
        )
          return;
        finish();
        e.data.ok ? resolve(e.data.value) : reject(Error(e.data.error));
      }
      window.addEventListener('message', onMessage);
      window.postMessage({ channel: 'social-backup-request', id, method, event }, location.origin);
    });
  }
  window.socialBackupProvider = Object.freeze({
    getPublicKey: () => call('getPublicKey'),
    signEvent: (event: EventTemplate) => call('signEvent', event),
  });
  window.nostr = window.socialBackupProvider;
  return true;
}

installProvider();
