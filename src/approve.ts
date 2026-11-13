import { el, on, send, notice } from './ui.ts';

import { permissionLabel } from './signer-storage.ts';

const id = location.hash.slice(1);
send('approval', { id })
  .then((r) => {
    el('reviewTitle').textContent = r.event ? 'Review signature' : 'Allow website login?';
    el('allow').textContent = r.event ? 'Sign event' : 'Share public key';
    el('origin').textContent = r.event ? r.origin + ' is asking you to sign with ' + r.pubkey
      : r.origin + ' wants to identify you using your Nostr public key.';
    el('event').hidden = !r.event;
    el('event').textContent = JSON.stringify(r.event, null, 2);
    const label = permissionLabel(r.event?.kind ?? -1);
    if (label) {
      el('rememberLabel').textContent = 'Always allow ' + label + ' on ' + r.origin;
      el('rememberOption').hidden = false;
    }
    el('allow').disabled = false;
  })
  .catch((e) => notice(e.message));
for (const key of ['allow', 'deny'])
  on(key, 'click', async () => {
    el('allow').disabled = true;
    await send('approval', { id, decision: key === 'allow', remember: key === 'allow' && el('remember').checked });
    window.close();
  });
