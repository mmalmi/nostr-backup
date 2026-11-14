import type { NewProfile, Settings } from './types.ts';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { deleteDB } from 'idb';
import { DexieStore } from '@hashtree/dexie';
import { archiveRouter, localArchive } from './archive-event-bus.ts';
import { openArchive } from './archive.ts';
import { hex, secretKey } from './model.ts';
import { DEFAULT_BLOSSOM_SERVER, mediaServers, publicMediaURL } from './media-refs.ts';
import { DEFAULT_RELAYS } from './default-relays.ts';
import { accountRecord, writeAccountRecords } from './account-storage.ts';

import { saveKey, forgetPermissions } from './signer-storage.ts';

// Post backup starts on for every platform. It begins once the user enters a username.
export const defaults: Settings = {
  pubkey: '',
  handle: '',
  capture: true,
  relaySync: true,
  relays: DEFAULT_RELAYS,
  blossomServer: DEFAULT_BLOSSOM_SERVER,
  social: { instagram: { handle: '', capture: true }, facebook: { handle: '', capture: true } },
};
const accountKey = (pubkey: string) => `account:${pubkey}` as const;
function withDefaults(conf: Settings): Settings {
  const servers = mediaServers(conf);
  conf = { ...conf, blossomServer: servers.find(publicMediaURL) ?? servers[0], blossomServers: servers,
    social: { ...defaults.social, ...conf.social } };
  return !conf.relays.length && !conf.relaysConfigured
    ? { ...conf, relays: [...DEFAULT_RELAYS], relaySync: true }
    : conf;
}

export async function settings(): Promise<Settings> {
  const conf = await accountRecord('settings');
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
    await accountRecord(id) ?? {
      ...defaults,
      pubkey,
      archiveName: 'nostr-backup-' + pubkey,
    },
  );
}

export function saveSettings(conf: Settings) {
  return writeAccountRecords({ settings: conf, [accountKey(conf.pubkey)]: conf });
}

const secretLike = /nsec1|[a-f\d]{64}/i;
const address = (value: unknown, protocols: string[]) => {
  try {
    const url = new URL(String(value));
    if (protocols.includes(url.protocol) && !url.username && !url.password && url.href.length <= 500) return url.href;
  } catch { /* Checked below. */ }
};

/** The kind 0 content for a new profile. Every field is public, so none may hold a secret key. */
export function profileContent(profile: NewProfile) {
  const name = typeof profile?.name === 'string' ? profile.name.trim() : '';
  if (!name || name.length > 100) throw Error('Enter a profile name of up to 100 characters.');
  if (secretLike.test(name)) throw Error('A profile name is public. Enter a name without a secret key.');
  const about = typeof profile.about === 'string' ? profile.about.trim() : '';
  if (about.length > 1000) throw Error('Shorten your description to 1,000 characters.');
  if (secretLike.test(about)) throw Error('Your description is public. Remove the secret key.');
  const content: Record<string, string> = { name };
  if (about) content.about = about;
  for (const field of ['picture', 'banner', 'website'] as const) {
    if (profile[field] === undefined || profile[field] === '') continue;
    const href = address(profile[field], field === 'website' ? ['https:', 'http:'] : ['https:']);
    if (!href) throw Error('Check the ' + field + ' address.');
    content[field] = href;
  }
  return content;
}

export async function login(value: string, profile?: NewProfile) {
  const key = secretKey(value);
  const pubkey = getPublicKey(key);
  const conf = await accountSettings(pubkey);
  if (profile !== undefined) {
    const content = profileContent(profile);
    const db = await openArchive(conf.archiveName);
    try {
      if (await db.count('events'))
        throw Error('This user ID already has a backup on this device.');
      const event = finalizeEvent(
        {
          kind: 0,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: JSON.stringify(content),
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
    await writeAccountRecords({ [accountKey(conf.pubkey)]: undefined, deletingAccount: undefined });
  };
  await navigator.locks.request('nostr-backup-media', erase);
}
