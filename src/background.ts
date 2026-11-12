import type { Archive, Message, Sign, Status, Result, Action } from './types.ts';
import type { Sender } from './platform.d.ts';
import type { ImportOptions, ImportResult } from './relays.ts';
import { errorMessage } from './types.ts';
import { readCooldown, readPointer, readRoot } from './archive.ts';
import { getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { append, openArchive, queueBroadcast, stagePosts } from './archive.ts';
import { deliverPending } from './broadcast.ts';
import { RelayRateLimitError } from 'nostr-pubsub';
import { retryDeadline } from './rate-limit.ts';
import { createUploadAuth } from 'nostr-tools/nipb7';
import { blossomOrigin } from './media-refs.ts';
import { DEFAULT_MEDIA_MIB } from './media-files.ts';
import { identity, hex, unhex, handlePattern, relayList, xTemplate } from './model.ts';
import { profileHandle } from './x.ts';
import { importWithNegentropy, pool, publish, syncHistory } from './relays.ts';
import {
  defaults,
  settings,
  login,
  accountSettings,
  saveSettings,
  eraseAccount,
} from './accounts.ts';
import { queueIndexPointer, deliverIndexPointer } from './index-pointer.ts';
import { enableSigner, revokeSession, handleSignerRequest, approval } from './signer.ts';

const api = globalThis.browser ?? chrome;
let changing = false,
  preparing: Promise<void> | undefined,
  indexController: AbortController | undefined,
  recovery: Promise<void> | undefined;
function recover() {
  return (recovery ??= api.storage.local
    .get('deletingAccount')
    .then(async ({ deletingAccount }) => {
      if (deletingAccount) {
        await revokeSession();
        await eraseAccount(deletingAccount);
      }
    })
    .catch((error) => {
      recovery = undefined;
      throw error;
    }));
}
const sessionKey = async () => (await api.storage.session.get('signingKey')).signingKey;
// Tree writes, draft drains and changes to identity configuration use one queue.
// Network waits never hold this queue.
let writer = Promise.resolve(),
  running: Promise<void> | undefined,
  rerun = false;
function write<T>(fn: () => T | Promise<T>): Promise<T> {
  if (changing) return Promise.reject(Error('The active profile is changing. Try again.'));
  const result = writer.then(fn);
  writer = result.then(
    () => {},
    () => {},
  );
  return result;
}
async function signDrafts(db: Archive) {
  const conf = await settings(),
    key = await sessionKey();
  if (!conf.capture || !key || getPublicKey(unhex(key)) !== conf.pubkey) return;
  for (const post of await db.getAll('drafts')) {
    if (changing) break;
    if (post.author !== conf.handle) continue;
    const event = finalizeEvent(xTemplate(post, conf.handle), unhex(key));
    await append(
      db,
      [{ event, source: 'x:' + post.id, targets: conf.relays, posters: post.posters }],
      conf.pubkey,
    );
  }
}
async function run() {
  await recover();
  const conf = await settings();
  if (!conf.pubkey || changing) return;
  const db = await openArchive(conf.archiveName);
  try {
    await write(() => signDrafts(db));
    const reports: Record<string, string> = {};
    const pending = await db.getAll('outbox');
    // Parallelize destinations so a failed relay cannot starve another.
    await Promise.all(
      conf.relays.map(async (url) => {
        const cooldownKey = ['retryAfter', url];
        const waitMessage = (until: number) =>
          'Rate limited · Retry after ' + new Date(until).toLocaleString();
        const until = (await readCooldown(db, url)) ?? 0;
        if (until > Date.now()) {
          reports[url] = waitMessage(until);
          return;
        }
        const messages = [];
        const importOptions: ImportOptions = {
          db,
          url,
          pubkey: conf.pubkey,
          save: (entries, key) => write(() => append(db, entries, key)),
          enabled: async () => {
            const current = await settings();
            return (
              !changing &&
              current.pubkey === conf.pubkey &&
              current.relaySync &&
              current.relays.includes(url)
            );
          },
        };
        try {
          let imported: ImportResult | undefined;
          if (conf.pubkey && conf.relaySync && (await importOptions.enabled())) {
            try {
              imported = await importWithNegentropy(importOptions);
              if (!imported.report && (await importOptions.enabled())) {
                imported.report = await syncHistory(importOptions);
              }
            } catch (error) {
              if (error instanceof RelayRateLimitError) throw error;
              imported = { report: 'Import: ' + errorMessage(error) };
            }
          }
          if (imported?.report) messages.push(imported.report);
          const rows = pending.filter((row) => row.relay === url);
          const report = await deliverPending(db, url, rows, settings, conf.pubkey, imported);
          if (report) messages.push(report);
          if (!changing && (await settings()).relays.includes(url)) {
            const receipt = await deliverIndexPointer(db, url, publish);
            if (receipt) messages.push(receipt);
          }
        } catch (error) {
          if (error instanceof RelayRateLimitError) {
            const until = retryDeadline(error);
            await db.put('meta', until, cooldownKey);
            messages.push(waitMessage(until));
            await api.alarms.create('relay-retry:' + url, { when: until });
          } else {
            messages.push(errorMessage(error));
          }
        }
        reports[url] = messages.join(' · ') || 'Ready';
      }),
    );
    if (!changing) await api.storage.local.set({ lastRun: { at: Date.now(), reports } });
  } finally {
    db.close();
  }
}
function kick(): Promise<void> | undefined {
  if (changing) return;
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
async function configure(msg: Message<'settings'>) {
  const pubkey = identity(msg.pubkey);
  const prev = await accountSettings(pubkey);
  const handle = msg.handle.trim().replace(/^@/, '').toLowerCase();
  if ((handle || msg.capture) && !handlePattern.test(handle)) throw Error('Enter your X handle.');
  const relays = relayList(msg.relays);
  if ((msg.capture || msg.relaySync) && !relays.length) throw Error('Choose a relay first.');
  const rawServer = (msg.blossomServer ?? prev.blossomServer ?? '').trim();
  const blossomServer = rawServer ? blossomOrigin(rawServer) : '';
  const mediaMiB = Number(msg.mediaMiB ?? prev.mediaMiB ?? DEFAULT_MEDIA_MIB);
  if (!Number.isSafeInteger(mediaMiB) || mediaMiB < 1 || mediaMiB > 1024)
    throw Error('Choose a media file limit between 1 and 1024 MiB.');
  await saveSettings({
    ...prev,
    pubkey,
    handle,
    relays,
    capture: !!msg.capture,
    relaySync: !!msg.relaySync,
    blossomServer,
    mediaMiB,
  });
}

async function leave(msg: Message<'logout' | 'deleteAccount'>) {
  if (changing) throw Error('The active profile is changing. Try again.');
  changing = true;
  try {
    await writer;
    const conf = await settings();
    if (!conf.pubkey || msg.pubkey !== conf.pubkey)
      throw Error('The active profile changed. Reopen Settings.');
    const deleting = msg.type === 'deleteAccount';
    if (deleting && msg.confirmed !== true) throw Error('Confirm deletion in Settings.');
    indexController?.abort();
    await revokeSession();
    await api.storage.local.set({
      settings: null,
      lastRun: null,
      ['account:' + conf.pubkey]: conf,
      ...(deleting ? { deletingAccount: conf } : {}),
    });
    rerun = false;
    pool.destroy();
    await Promise.allSettled([running, preparing]);

    if (deleting) {
      recovery = undefined;
      await recover();
    }
  } finally {
    changing = false;
  }
}

async function route(msg: Message, sender: Sender): Promise<Result<Action>> {
  if (sender.id !== api.runtime.id || (sender.frameId ?? 0) > 0) throw Error('Untrusted sender.');
  // A media upload can hold the deletion lock while requesting its signature.
  if (
    msg.type === 'authorizeMediaUpload' &&
    (changing || (await api.storage.local.get('deletingAccount')).deletingAccount)
  )
    throw Error('The active profile is changing. Try again.');
  await recover();
  const conf = await settings();
  const page = sender.url?.split('#')[0];
  const trustedPage = [
    api.runtime.getURL('archive.html'),
    api.runtime.getURL('popup.html'),
  ].includes(page ?? '');
  if (changing && msg.type !== 'status' && msg.type !== 'captureConfig')
    throw Error('The active profile is changing. Try again.');
  if (msg.account !== undefined && msg.account !== conf.pubkey)
    throw Error('The active profile changed.');
  if (trustedPage && (msg.type === 'logout' || msg.type === 'deleteAccount')) return leave(msg);
  if (
    trustedPage &&
    (msg.type === 'login' || msg.type === 'unlock' || msg.type === 'createProfile')
  ) {
    await write(async () => {
      if (msg.type === 'createProfile' && (await settings()).pubkey)
        throw Error('Log out before creating a profile.');
      if (msg.type === 'createProfile' && typeof msg.name !== 'string')
        throw Error('Enter a profile name.');
      await login(msg.key, msg.type === 'createProfile' ? msg.name : undefined);
    });
    void kick();
    return;
  }
  if (trustedPage && msg.type === 'watch') {
    await write(async () => saveSettings(await accountSettings(identity(msg.pubkey))));
    void kick();
    return;
  }
  if (trustedPage && msg.type === 'settings') {
    await write(() => configure(msg));
    void kick();
    return;
  }
  if (!conf.pubkey || changing) {
    if (trustedPage && msg.type === 'status')
      return {
        conf: defaults,
        unlocked: false,
        events: 0,
        drafts: 0,
        pending: 0,
        running: false,
      } satisfies Status;
    if (msg.type === 'captureConfig') return { capture: false, handle: '' };
    throw Error('Choose a Nostr profile to start your backup.');
  }
  const db = await openArchive(conf.archiveName);
  try {
    if (msg.type === 'nip07') return handleSignerRequest(msg, sender, conf.pubkey, sessionKey);
    if (msg.type === 'approval') {
      if (sender.url !== api.runtime.getURL('approve.html') + '#' + msg.id)
        throw Error('Untrusted approval.');
      return approval(msg, sessionKey);
    }
    if (msg.type === 'captureConfig' || msg.type === 'capture') {
      if (!sender.tab || !sender.url || new URL(sender.url).origin !== 'https://x.com')
        throw Error('Invalid capture source.');
      if (msg.type === 'captureConfig')
        return { handle: conf.handle, capture: conf.capture, pubkey: conf.pubkey };
      await write(async () => {
        const current = await settings();
        const page = sender.tab?.url || sender.url;
        if (
          current.pubkey !== conf.pubkey ||
          !current.capture ||
          profileHandle(page) !== current.handle
        )
          throw Error('Outside the selected profile.');
        if (!Array.isArray(msg.posts) || msg.posts.length > 50)
          throw Error('Invalid capture batch.');
        for (const post of msg.posts) xTemplate(post, current.handle);
        await stagePosts(db, msg.posts);
      });
      void kick();
      return;
    }
    if (!trustedPage) throw Error('Extension page required.');
    switch (msg.type) {
      case 'status': {
        const root = await readRoot(db);
        return {
          conf,
          unlocked: !!(await sessionKey()),
          events: await db.count('events'),
          drafts: await db.count('drafts'),
          pending: await db.count('outbox'),
          running: !!running,
          preparingIndex: !!preparing,
          indexHash: root ? hex(root.hash) : undefined,
          pointer: await readPointer(db),
          lastRun: (await api.storage.local.get('lastRun')).lastRun,
        } satisfies Status;
      }
      case 'publishIndex': {
        if (preparing) throw Error('Index upload already in progress.');
        const controller = new AbortController();
        const checkActive = async () => {
          controller.signal.throwIfAborted();
          const current = await settings();
          if (
            changing ||
            current.pubkey !== conf.pubkey ||
            current.blossomServer !== conf.blossomServer ||
            JSON.stringify(current.relays) !== JSON.stringify(conf.relays)
          )
            throw Error('The active profile or backup destinations changed.');
          const key = await sessionKey();
          if (!key || getPublicKey(unhex(key)) !== conf.pubkey)
            throw Error('Sign in with the archive private key first.');
          return unhex(key);
        };
        const sign: Sign = async (event) => finalizeEvent(event, await checkActive());
        indexController = controller;
        preparing = (async () => {
          await checkActive();
          await queueIndexPointer(db, conf, sign, checkActive, controller.signal);
        })();
        try {
          await preparing;
        } finally {
          preparing = undefined;
          indexController = undefined;
        }
        void kick();
        return;
      }
      case 'lock':
        indexController?.abort();
        await write(() => api.storage.session.remove('signingKey'));
        return;
      case 'sync':
        void kick();
        return;
      case 'authorizeMediaUpload': {
        if (
          !conf.blossomServer ||
          msg.server !== conf.blossomServer ||
          !(await db.getKey('mediaFiles', msg.hash))
        )
          throw Error('Choose a saved file and the configured Blossom server.');
        const key = await sessionKey();
        if (!key || getPublicKey(unhex(key)) !== conf.pubkey)
          throw Error('Unlock the archive signer first.');
        return createUploadAuth(async (event) => finalizeEvent(event, unhex(key)), msg.hash, {
          servers: msg.server,
          expiration: Math.floor(Date.now() / 1000) + 300,
        });
      }
      case 'broadcast': {
        if (running) throw Error('Wait for the current sync to finish.');
        const count = await write(async () => queueBroadcast(db, await settings()));
        void kick();
        return count;
      }
      case 'rescan':
        if (running) throw Error('Wait for the current sync to finish.');
        await db.clear('cursors');
        void kick();
        return;
      case 'enableSigner':
        if (!(await sessionKey())) throw Error('Unlock your signer in the archive first.');
        return write(() => enableSigner());
      default:
        throw Error('Unknown action.');
    }
  } finally {
    db.close();
  }
}
api.runtime.onMessage.addListener((msg, sender, respond) => {
  route(msg, sender).then(
    (value) => respond({ ok: true, value }),
    (err) => respond({ ok: false, error: err.message }),
  );
  return true;
});
// A toolbar click opens the full-page welcome screen until a profile is active.
api.action.onClicked.addListener(() => api.runtime.openOptionsPage());
function setToolbarPopup(pubkey?: string) {
  return api.action.setPopup({ popup: pubkey ? 'popup.html' : '' });
}
let toolbarSettingsChanged = false;
api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  toolbarSettingsChanged = true;
  void setToolbarPopup(changes.settings.newValue?.pubkey);
});
void settings().then((conf) => {
  if (!toolbarSettingsChanged) return setToolbarPopup(conf.pubkey);
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
  if (a.name === 'backup' || a.name.startsWith('relay-retry:')) void kick();
});
void arm();
