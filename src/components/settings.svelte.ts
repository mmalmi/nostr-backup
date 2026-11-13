import type { Settings } from '../types.ts';
import { mediaServers } from '../media-refs.ts';
import { DEFAULT_MEDIA_MIB } from '../media-files.ts';

// The editable settings outside Sources. Fields reload from storage when the profile
// changes or after a save; otherwise they keep what the user is editing.
export const form = $state({
  relays: '',
  relaySync: true,
  kindMode: 'all',
  kinds: '',
  mediaMiB: DEFAULT_MEDIA_MIB as number | null,
  blossomServers: '',
});

export function loadForm(conf: Settings) {
  form.relays = conf.relays.join('\n');
  form.relaySync = conf.relaySync;
  form.kindMode = conf.relayKinds?.mode ?? 'all';
  form.kinds = conf.relayKinds?.kinds.join(', ') ?? '';
  form.mediaMiB = conf.mediaMiB ?? DEFAULT_MEDIA_MIB;
  form.blossomServers = mediaServers(conf).join('\n');
}
