import { api, el, on, send, notice } from './ui.ts';

send('status')
  .then((s) => {
    el('summary').textContent =
      s.events + ' archived posts · ' + (s.unlocked ? 'Signer unlocked' : 'Signer locked');
  })
  .catch((e) => notice(e.message));
on('open', 'click', async () => {
  await api.runtime.openOptionsPage();
  window.close();
});
on('signer', 'click', async () =>
  notice('Signer enabled on ' + (await send('enableSigner')) + '.'),
);
