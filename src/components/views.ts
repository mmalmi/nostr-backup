import type { Settings, Status } from '../types.ts';

/** What the Sources page shows. */
export interface SourcesView {
  conf: Settings;
  unlocked: boolean;
  x: Status['x'];
  social?: Status['social'];
  localX?: number;
  xLink?: Status['xLink'];
  xFollows?: number;
}

/** The Sources part of the settings message. Usernames are the saved ones. */
export interface SourceSettings {
  handle: string;
  capture: boolean;
  skipCrossposts: boolean;
  social: Record<import('../types.ts').SocialNetwork, { handle: string; capture: boolean }>;
}

