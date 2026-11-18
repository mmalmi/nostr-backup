import { buildProfileDraft, conflictingProfileFields, diffProfileFields, readProfileFields } from '@iris/profile-events';
import type { Event, EventTemplate } from 'nostr-tools/pure';

export const emptyProfile = { content: '{}', tags: [] as string[][], created_at: 0 };

export function readableFields(content: string): Record<string, unknown> | undefined {
  try { return readProfileFields(content); } catch { return undefined; }
}

/** Apply only fields the person reviewed, to the newest signed event for this account. */
export function editProfileDraft(base: Event | undefined, latest: Event | undefined, content: string,
  tagSource?: Event, repairSource?: Event): EventTemplate {
  let original = base ?? emptyProfile;
  let current = latest ?? emptyProfile;
  if (repairSource) {
    if (!base || latest?.id !== base.id || readableFields(base.content) || content !== repairSource.content)
      throw Error('The profile changed. Review the saved version again.');
    original = { ...base, content: '{}' };
    current = original;
  }
  const originalFields = readProfileFields(original.content);
  const edits = diffProfileFields(originalFields, readProfileFields(content));
  const conflicts = conflictingProfileFields(originalFields, readProfileFields(current.content), edits);
  if (conflicts.length) throw Error('Changed in another client: ' + conflicts.join(', ') + '. Reload the latest version and review these fields.');
  if (tagSource && JSON.stringify(current.tags) !== JSON.stringify(original.tags) && JSON.stringify(current.tags) !== JSON.stringify(tagSource.tags))
    throw Error('Profile tags changed in another client. Reload before restoring tags.');
  return buildProfileDraft({ ...current, tags: tagSource?.tags ?? current.tags }, edits);
}

export function validatePublicProfile(draft: EventTemplate, activeSecret: string) {
  const fields = readProfileFields(draft.content);
  const publicData = JSON.stringify([fields, draft.tags]).toLowerCase();
  if (publicData.includes('nsec1') || publicData.includes(activeSecret.toLowerCase()) ||
      [fields.name, fields.display_name, fields.about].some(value => typeof value === 'string' && /[a-f0-9]{64}/i.test(value)))
    throw Error('Remove the secret key before publishing your public profile.');
}

export function recoverFollowDraft(current: Event, saved: Event, keys: string[]): EventTemplate {
  if (!Array.isArray(keys) || !keys.length || keys.some(key => typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)))
    throw Error('Choose follows from the saved list.');
  const selected = new Set(keys);
  const present = new Set(current.tags.filter(([name]) => name === 'p').map(([, key]) => key));
  const restored = saved.tags.filter(([name, key]) => name === 'p' && selected.has(key) && !present.has(key));
  if (!restored.length) throw Error('The selected follows are already present.');
  return {kind: 3, created_at: Math.max(Math.floor(Date.now() / 1000), current.created_at + 1),
    content: current.content, tags: [...current.tags, ...restored]};
}
