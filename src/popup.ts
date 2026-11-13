import { api, el, on, send, notice } from './ui.ts';
import { captureNetwork } from './social.ts';
import { showProfile } from './profile-ui.ts';

async function openBackup() {
  await api.runtime.openOptionsPage();
  window.close();
}

async function refreshPopup() {
  const [{ conf, profile, unlocked, events, x, social }, tabs] = await Promise.all([
    send('status'),
    api.tabs.query({ active: true, currentWindow: true }),
  ]);
  if (!conf.pubkey) return openBackup();
  showProfile(conf.pubkey, profile, !unlocked);
  const site = captureNetwork(tabs[0]?.url);
  const onX = site === 'x';
  el('socialPopup').hidden = !site || onX;
  if (site && site !== 'x') {
    const label = site === 'instagram' ? 'Instagram' : 'Facebook';
    const selection = conf.social?.[site];
    el('socialPopup').textContent = !unlocked ? label + ' capture paused · Read-only mode' :
      selection?.capture ? label + ' · ' + (social?.[site].saved ?? 0) + ' backed up for ' + selection.handle : label + ' capture off';
  }
  el('xPopupStats').hidden = !onX;
  el('xCaptured').textContent = x.captured.toLocaleString();
  el('xMatched').textContent = x.matched.toLocaleString();
  el('xSigned').textContent = x.signed.toLocaleString();
  el('xImageState').hidden = !x.media;
  el('xImageState').textContent = x.media
    ? x.media.toLocaleString() + (x.media === 1 ? ' post waiting for images' : ' posts waiting for images') +
      (x.mediaError ? ' · ' + x.mediaError : '') : '';
  el('xDrafts').textContent = x.drafts.toLocaleString();
  el('xCaptureState').textContent = !unlocked
    ? 'Capture paused · Read-only mode'
    : conf.capture
      ? 'Capture enabled for @' + conf.handle
      : 'Capture off';
  el('summary').textContent = `${events} backed-up ${events === 1 ? 'event' : 'events'}`;
  el('backupActions').hidden = false;
}
refreshPopup().catch((e) => notice(e.message));
setInterval(() => {
  if (!document.hidden) refreshPopup().catch((e) => notice(e.message));
}, 1500);
on('open', 'click', openBackup);
