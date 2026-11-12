import { api, el, on, send, notice } from './ui.ts';

async function openBackup() {
  await api.runtime.openOptionsPage();
  window.close();
}

send('status')
  .then(async ({ conf, unlocked, events }) => {
    if (!conf.pubkey) return openBackup();
    el('summary').textContent =
      `${events} backed-up ${events === 1 ? 'event' : 'events'} · ${unlocked ? 'Signer unlocked' : 'Read-only'}`;
    el('signer').hidden = !unlocked;
    if (!unlocked)
      el('signerHint').textContent = 'To sign on this tab, unlock your signer in Settings.';
    el('backupActions').hidden = false;
  })
  .catch((e) => notice(e.message));
on('open', 'click', openBackup);
on('signer', 'click', async () =>
  notice('Signer enabled on ' + (await send('enableSigner')) + '.'),
);
