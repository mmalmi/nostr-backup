import type { Event } from 'nostr-tools/pure';
import { lightningAddress } from './x-tips.ts';
import type { Archive, Profile } from './types.ts';
import { archiveRouter } from './archive-event-bus.ts';

export async function readProfile(db: Archive, pubkey: string): Promise<Profile | undefined> {
  const result = await archiveRouter(db, pubkey).query([
    { authors: [pubkey], kinds: [0], limit: 1 },
  ]);
  if (!result.complete) throw Error('The local profile index could not be read.');
  const event = result.events[0]?.event;
  return event && profileFromEvent(event);
}

/** Name, picture, about and Lightning address from a kind 0 profile; undefined when its content is not an object. */
export function profileFromEvent(event: Event): Profile | undefined {
  try {
    const data = JSON.parse(event.content);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    const text = (value: unknown) => (typeof value === 'string' ? value.trim().slice(0, 200) : '');
    const name = text(data.name);
    let picture: string | undefined;
    if (typeof data.picture === 'string') {
      try {
        const url = new URL(data.picture);
        if (url.protocol === 'https:' && !url.username && !url.password) picture = url.href;
      } catch {
        /* Keep the initials when the avatar URL is invalid. */
      }
    }
    const lightning = lightningAddress(event);
    // Enough of the description for a short card; the page clamps it to a few lines.
    const about = typeof data.about === 'string' ? data.about.trim().slice(0, 400) : '';
    return { name, displayName: text(data.display_name) || name, picture, ...(about ? { about } : {}), ...(lightning ? { lightning } : {}), ...(data.lud06 || (data.lud16 && !lightning) ? { hasLightning: true } : {}) };
  } catch {
    return;
  }
}
