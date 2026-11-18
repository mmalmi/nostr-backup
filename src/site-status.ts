import type { Settings, SocialNetwork } from './types.ts';

// What Social Backup is doing on X, Facebook or Instagram: the dot on the toolbar icon and the sentence in the
// popup. It is worked out from what the extension already holds. Nothing is asked of the network.

export type Site = 'x' | SocialNetwork;
/** Green: the backup is on. Yellow: it needs the user. Red: posts are not being saved. */
export type Level = 'on' | 'attention' | 'problem';
export interface SiteState {
  /** Missing when the site is not set up: no dot. */
  level?: Level;
  text: string;
}
/** What a page reports about the user's own posts on it. */
export interface PageReport {
  /** Own posts on the page that stay out of the backup. */
  unsaved?: number;
  /** Saving keeps failing. */
  failed?: boolean;
  reason?: string;
}
/** What the settings cannot tell about the backup in a tab. The background keeps it per tab for the popup. */
export interface TabReport extends PageReport {
  site: Site;
  /** Every relay failed in the last run while posts still wait to be sent. */
  relaysDown?: boolean;
  /** The page was open before an update and still runs the old code. */
  stale?: boolean;
}
const NAMES: Record<Site, string> = { x: 'X', instagram: 'Instagram', facebook: 'Facebook' };
export const siteName = (site: Site) => NAMES[site];

export function siteState(
  site: Site,
  conf: Pick<Settings, 'pubkey' | 'handle' | 'capture' | 'social'> | undefined,
  unlocked: boolean,
  { unsaved = 0, failed = false, reason, relaysDown = false, stale = false }: Omit<TabReport, 'site'> = {},
): SiteState {
  const name = NAMES[site];
  if (!conf?.pubkey) return { level: 'attention', text: 'Sign in to back up your posts' };
  const selected = site === 'x' ? conf : conf.social?.[site];
  if (!selected?.capture) return { text: name + ' backup is off' };
  if (!selected.handle) return { text: 'Add your ' + name + ' username in Sources' };
  if (!unlocked) return { level: 'attention', text: name + ' backup is paused. Enter your secret key in Keys & access' };
  if (stale) return { level: 'attention', text: 'Reload this page to start the backup' };
  if (failed) return { level: 'problem', text: reason ? 'Retrying backup. ' + reason : 'Your posts on this page could not be saved' };
  if (unsaved > 0)
    return { level: 'problem', text: unsaved + (unsaved === 1 ? ' post' : ' posts') + ' on this page could not be backed up' };
  if (relaysDown) return { level: 'attention', text: 'Relays are not reachable. New posts stay on this device for now' };
  return { level: 'on', text: 'Backing up ' + (site === 'facebook' ? '' : '@') + selected.handle + ' on ' + name };
}

/** Toolbar-sized rasters of the flower, with a four-pixel status dot when applicable. */
export function siteIcon(level?: Level) {
  const name = level ? 'icon-' + level : 'icon';
  return { 16: name + '-16.png', 32: name + '-32.png' };
}
