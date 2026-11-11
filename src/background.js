import { getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { append, openArchive, stagePosts } from './archive.js';
import { identity, secretKey, hex, unhex, handlePattern, relayList, xTemplate } from './model.js';
import { profileHandle } from './x.js';
import { pool, publish, syncHistory } from './relays.js';
import { enableSigner, handleSignerRequest, approval } from './signer.js';

const api = globalThis.browser ?? chrome;
const dbReady = openArchive();
const defaults = { pubkey: '', handle: '', capture: false, relaySync: false, relays: [] };
const settings = async () => (await api.storage.local.get('settings')).settings ?? defaults;
const sessionKey = async () => (await api.storage.session.get('signingKey')).signingKey;
// Tree writes, draft drains and changes to identity configuration use one queue.
// Network waits never hold this queue.
let writer = Promise.resolve(),
  running,
  rerun = false;
function write(fn) {
  const result = writer.then(fn);
  writer = result.catch(() => {});
  return result;
}
async function signDrafts(db) {
  const conf = await settings(),
    key = await sessionKey();
  if (!conf.capture || !key || getPublicKey(unhex(key)) !== conf.pubkey) return;
  for (const post of await db.getAll('drafts')) {
    if (post.author !== conf.handle) continue;
    const event = finalizeEvent(xTemplate(post, conf.handle), unhex(key));
    await append(db, [{ event, source: 'x:' + post.id, targets: conf.relays }], conf.pubkey);
  }
}
async function run() {
  const db = await dbReady;
  await write(() => signDrafts(db));
  const conf = await settings();
  const reports = {};
  // Parallelize destinations so a failed relay cannot starve another.
  await Promise.all(
    conf.relays.map(async (url) => {
      const messages = [];
      try {
        const items = (await db.getAll('outbox')).filter((row) => row.relay === url).slice(0, 100);
        for (const row of items) {
          const current = await settings();
          if (!current.capture || !current.relays.includes(url)) break;
          await publish(url, await db.get('events', row.id));
          await db.delete('outbox', [row.id, url]);
        }
      } catch (e) {
        messages.push('Delivery: ' + e.message);
      }
      if (conf.pubkey && conf.relaySync) {
        try {
          messages.push(
            await syncHistory({
              db,
              url,
              pubkey: conf.pubkey,
              save: (entries, key) => write(() => append(db, entries, key)),
            }),
          );
        } catch (e) {
          messages.push('Import: ' + e.message);
        }
      }
      reports[url] = messages.join(' · ') || 'Ready';
    }),
  );
  await api.storage.local.set({ lastRun: { at: Date.now(), reports } });
}
function kick() {
  if (running) {
    rerun = true;
    return running;
  }
  running = run()
    .catch(async (e) => {
      await api.storage.local.set({ lastRun: { at: Date.now(), reports: { Archive: e.message } } });
    })
    .finally(() => {
      pool.destroy();
      running = undefined;
      if (rerun) {
        rerun = false;
        void kick();
      }
    });
  return running;
}
async function configure(msg) {
  const prev = await settings(),
    pubkey = identity(msg.pubkey);
  if (prev.pubkey && prev.pubkey !== pubkey)
    throw Error('This archive already belongs to a different public key.');
  const handle = msg.handle.trim().replace(/^@/, '').toLowerCase();
  if ((handle || msg.capture) && !handlePattern.test(handle)) throw Error('Enter your X handle.');
  const relays = relayList(msg.relays);
  if ((msg.capture || msg.relaySync) && !relays.length) throw Error('Choose a relay first.');
  await api.storage.local.set({
    settings: { pubkey, handle, relays, capture: !!msg.capture, relaySync: !!msg.relaySync },
  });
}
async function route(msg, sender) {
  if (sender.id !== api.runtime.id || sender.frameId > 0) throw Error('Untrusted sender.');
  const db = await dbReady;
  const conf = await settings();
  if (msg.type === 'nip07') return handleSignerRequest(msg, sender, conf.pubkey, sessionKey);
  if (msg.type === 'approval') {
    if (sender.url !== api.runtime.getURL('approve.html') + '#' + msg.id)
      throw Error('Untrusted approval.');
    return approval(msg, sessionKey);
  }
  if (msg.type === 'captureConfig' || msg.type === 'capture') {
    if (!sender.tab || new URL(sender.url).origin !== 'https://x.com')
      throw Error('Invalid capture source.');
    if (msg.type === 'captureConfig') return { handle: conf.handle, capture: conf.capture };
    await write(async () => {
      const current = await settings();
      const page = sender.tab.url || sender.url;
      if (!current.capture || profileHandle(page) !== current.handle)
        throw Error('Outside the selected profile.');
      if (!Array.isArray(msg.posts) || msg.posts.length > 50) throw Error('Invalid capture batch.');
      for (const post of msg.posts) xTemplate(post, current.handle);
      await stagePosts(db, msg.posts);
    });
    void kick();
    return;
  }
  if (![api.runtime.getURL('archive.html'), api.runtime.getURL('popup.html')].includes(sender.url))
    throw Error('Extension page required.');
  switch (msg.type) {
    case 'status':
      return {
        conf,
        unlocked: !!(await sessionKey()),
        events: await db.count('events'),
        drafts: await db.count('drafts'),
        pending: await db.count('outbox'),
        running: !!running,
        lastRun: (await api.storage.local.get('lastRun')).lastRun,
      };
    case 'settings':
      await write(() => configure(msg));
      void kick();
      return;
    case 'unlock': {
      const key = secretKey(msg.key);
      if (getPublicKey(key) !== conf.pubkey)
        throw Error('The secret key does not match this archive.');
      await api.storage.session.set({ signingKey: hex(key) });
      void kick();
      return;
    }
    case 'lock':
      await write(() => api.storage.session.remove('signingKey'));
      return;
    case 'sync':
      void kick();
      return;
    case 'rescan':
      if (running) throw Error('Wait for the current sync to finish.');
      await db.clear('cursors');
      void kick();
      return;
    case 'enableSigner':
      if (!(await sessionKey())) throw Error('Unlock your signer in the archive first.');
      return enableSigner();
    default:
      throw Error('Unknown action.');
  }
}
api.runtime.onMessage.addListener((msg, sender, respond) => {
  route(msg, sender).then(
    (value) => respond({ ok: true, value }),
    (err) => respond({ ok: false, error: err.message }),
  );
  return true;
});
async function arm() {
  if (!(await api.alarms.get('backup'))) await api.alarms.create('backup', { periodInMinutes: 5 });
}
api.runtime.onInstalled.addListener(() => void arm());
api.runtime.onStartup.addListener(() => {
  void arm();
  void kick();
});
api.alarms.onAlarm.addListener((a) => {
  if (a.name === 'backup') void kick();
});
void arm();
