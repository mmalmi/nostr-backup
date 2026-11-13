import type { Settings } from './types.ts';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { deleteDB } from 'idb';
import { DexieStore } from '@hashtree/dexie';
import { archiveRouter, localArchive } from './archive-event-bus.ts';
import { openArchive } from './archive.ts';
import { hex, secretKey } from './model.ts';
import { DEFAULT_BLOSSOM_SERVER, mediaServers, publicMediaURL } from './media-refs.ts';
import { DEFAULT_RELAYS } from './default-relays.ts';

import { saveKey, forgetPermissions } from './signer-storage.ts';

const api = globalThis.browser ?? chrome;
export const defaults: Settings = {
  pubkey: '',
  handle: '',
  capture: false,
  relaySync: true,
  relays: DEFAULT_RELAYS,
  blossomServer: DEFAULT_BLOSSOM_SERVER,
};
const accountKey = (pubkey: string) => `account:${pubkey}` as const;
function withDefaults(conf: Settings): Settings {
  const servers = mediaServers(conf);
  conf = { ...conf, blossomServer: servers.find(publicMediaURL) ?? servers[0], blossomServers: servers };
  return !conf.relays.length && !conf.relaysConfigured
    ? { ...conf, relays: [...DEFAULT_RELAYS], relaySync: true }
    : conf;
}

export async function settings(): Promise<Settings> {
  const { settings: conf } = await api.storage.local.get('settings');
  // Archives created before multiple accounts all used this database name.
  return conf?.pubkey
    ? withDefaults({ archiveName: 'nostr-backup-v1', ...conf })
    : defaults;
}

export async function accountSettings(pubkey: string): Promise<Settings> {
  const active = await settings();
  if (active.pubkey) {
    if (active.pubkey !== pubkey) throw Error('Log out before opening a different profile.');
    return active;
  }
  const id = accountKey(pubkey);
  return withDefaults(
    (await api.storage.local.get(id))[id] ?? {
      ...defaults,
      pubkey,
      archiveName: 'nostr-backup-' + pubkey,
    },
  );
}

export function saveSettings(conf: Settings) {
  return api.storage.local.set({ settings: conf, [accountKey(conf.pubkey)]: conf });
}

export async function login(value: string, profileName?: string) {
  const key = secretKey(value);
  const pubkey = getPublicKey(key);
  const conf = await accountSettings(pubkey);
  if (profileName !== undefined) {
    if (
      typeof profileName !== 'string' ||
      !profileName.trim() ||
      profileName.trim().length > 100
    )
      throw Error('Enter a profile name of up to 100 characters.');
    const db = await openArchive(conf.archiveName);
    try {
      if (await db.count('events'))
        throw Error('This user ID already has a backup on this device.');
      const event = finalizeEvent(
        {
          kind: 0,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: JSON.stringify({ name: profileName.trim() }),
        },
        key,
      );
      const receipt = await archiveRouter(db, pubkey, conf.relays).publish(event, localArchive);
      if (!receipt.accepted) throw Error(receipt.reason ?? 'Could not save the profile.');
    } finally {
      db.close();
    }
  }
  await saveSettings(conf);
  await saveKey(hex(key));
}

export async function eraseAccount(conf: Settings) {
  // If the worker stops between the two databases, startup finishes this journaled deletion.
  const erase = async () => {
    if (!conf.archiveName) throw Error('Missing archive database name.');
    await DexieStore.deleteDatabase(conf.archiveName + '-media');
    await deleteDB(conf.archiveName);
    await forgetPermissions(conf.pubkey);
    await api.storage.local.remove(accountKey(conf.pubkey));
    await api.storage.local.remove('deletingAccount');
  };
  await navigator.locks.request('nostr-backup-media', erase);
}
