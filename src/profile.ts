import { lightningAddress } from './x-tips.ts';
import type { Archive, Profile } from './types.ts';
import { archiveRouter } from './archive-event-bus.ts';

export async function readProfile(db: Archive, pubkey: string): Promise<Profile | undefined> {
  const result = await archiveRouter(db, pubkey).query([
    { authors: [pubkey], kinds: [0], limit: 1 },
  ]);
  if (!result.complete) throw Error('The local profile index could not be read.');
  const event = result.events[0]?.event;
  if (!event) return;
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
    return { name, displayName: text(data.display_name) || name, picture, ...(lightning ? { lightning } : {}) };
  } catch {
    return;
  }
}
