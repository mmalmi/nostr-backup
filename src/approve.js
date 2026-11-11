import { el, on, send, notice } from './ui.js';
const id = location.hash.slice(1);
send('approval', { id })
  .then((r) => {
    el('origin').textContent = r.origin + ' is asking you to sign with ' + r.pubkey;
    el('event').textContent = JSON.stringify(r.event, null, 2);
    el('allow').disabled = false;
  })
  .catch((e) => notice(e.message));
for (const key of ['allow', 'deny'])
  on(key, 'click', async () => {
    el('allow').disabled = true;
    await send('approval', { id, decision: key === 'allow' });
    window.close();
  });
