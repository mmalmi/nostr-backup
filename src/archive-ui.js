import { el, send, notice, on } from './ui.js';
import { dump, openArchive } from './archive.js';
let pubkey;
async function refresh(initial = false) {
  const { conf, unlocked, events, drafts, pending, running, lastRun } = await send('status');
  pubkey = conf.pubkey;
  if (initial) {
    for (const k of ['handle', 'pubkey']) el(k).value = conf[k];
    el('relays').value = conf.relays.join('\n');
    for (const k of ['capture', 'relaySync']) el(k).checked = conf[k];
  }
  el('pubkey').readOnly = !!pubkey;
  for (const [k, n] of Object.entries({ events, drafts, pending })) el(k).textContent = n;
  el('lockState').textContent = unlocked ? 'Signer unlocked for this session.' : 'Signer locked.';
  el('unlock').hidden = unlocked;
  el('lock').hidden = !unlocked;
  el('sync').disabled = running;
  el('rescan').disabled = running;
  el('activity').textContent = running
    ? 'Sync in progress…'
    : lastRun
      ? 'Last run ' + new Date(lastRun.at).toLocaleString()
      : '';
  el('reports').replaceChildren(
    ...Object.entries(lastRun?.reports ?? {}).map(([url, v]) => {
      const li = document.createElement('li');
      li.textContent = url + ' — ' + v;
      return li;
    }),
  );
}
on('settings', 'submit', async () => {
  await send('settings', {
    pubkey: el('pubkey').value,
    handle: el('handle').value,
    relays: el('relays').value,
    capture: el('capture').checked,
    relaySync: el('relaySync').checked,
  });
  await refresh(true);
  notice('Settings saved.');
});
on('unlock', 'submit', async () => {
  const key = el('secret').value;
  el('secret').value = '';
  await send('unlock', { key });
  await refresh();
  notice('Signer unlocked.');
});
on('lock', 'click', async () => {
  await send('lock');
  await refresh();
  notice('Signer locked.');
});
for (const id of ['sync', 'rescan'])
  on(id, 'click', async () => {
    await send(id);
    await refresh();
  });
on('download', 'click', async () => {
  const db = await openArchive();
  try {
    const bytes = await dump(db, pubkey);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'nostr-backup-' + new Date().toISOString().slice(0, 10) + '.zip';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    notice('ZIP download started.');
  } finally {
    db.close();
  }
});
refresh(true).catch((e) => notice(e.message));
setInterval(() => {
  if (!document.hidden) refresh().catch((e) => notice(e.message));
}, 2500);
