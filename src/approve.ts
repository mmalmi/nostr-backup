import { el, on, send, notice } from './ui.ts';

import { npubEncode } from 'nostr-tools/nip19';
import { permissionLabel } from './signer-storage.ts';

const id = location.hash.slice(1);
send('approval', { id })
  .then((r) => {
    el('reviewTitle').textContent = r.event ? 'Approve this request?' : 'Allow website login?';
    el('allow').textContent = r.event ? 'Approve request' : 'Share user ID';
    el('origin').textContent = r.event ? r.origin + ' wants your approval to act as ' + npubEncode(r.pubkey) + '. Check the details before approving.'
      : r.origin + ' is asking for your user ID to sign you in.';
    el('requestDetails').hidden = !r.event;
    const isPost = r.event?.kind === 1 && !!r.event.content.trim();
    el('postPreview').hidden = !isPost;
    el('postPreview').textContent = isPost ? r.event?.content ?? '' : '';
    if (isPost) {
      el('reviewTitle').textContent = 'Allow this website to use this post?';
      el('allow').textContent = 'Approve post';
    }
    el('requestDetails').open = !!r.event && !isPost;
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
