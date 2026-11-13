function installBridge(token: string) {
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
        const registration = await api.runtime.sendMessage({ type: 'registerBridge', token });
        if (!registration?.ok) throw Error('Account access is unavailable.');
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
            error: 'Account access is unavailable.',
          },
          location.origin,
        );
      }
    },
    { signal: controller.signal },
  );
}

installBridge(crypto.randomUUID());
