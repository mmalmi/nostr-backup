import { npubEncode } from 'nostr-tools/nip19';
import type { Event, EventTemplate } from 'nostr-tools/pure';

export const receivingAddress = (pubkey: string) => npubEncode(pubkey) + '@npub.cash';

export function updateReceivingAddress(profile: Event, enabled: boolean): EventTemplate {
  const data = JSON.parse(profile.content);
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw Error('Could not read your current Nostr profile.');
  const address = receivingAddress(profile.pubkey);
  if (enabled) {
    if (data.lud16 || data.lud06)
      throw Error('This profile already has a Lightning address. Refresh Account.');
    data.lud16 = address;
  } else {
    if (data.lud16 !== address) throw Error('The receiving address changed. Refresh Account.');
    delete data.lud16;
  }
  return {
    kind: 0,
    tags: profile.tags,
    content: JSON.stringify(data),
    created_at: Math.max(Math.floor(Date.now() / 1000), profile.created_at + 1),
  };
}
