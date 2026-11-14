import type { Status } from '../types.ts';

// Shared state for the backup page. The page script updates it; panels read it.
// `setup` shows the source setup step right after signing up or signing in with a secret key.
// `accounts` holds the usernames chosen before signing up or in, until setup saves them.
export const page = $state<{
  status?: Status;
  section: string;
  setup: boolean;
  accounts?: { x: string; instagram: string; facebook: string };
  /** Set when sign-up created a new key, so setup ends by offering to save it. */
  created?: boolean;
  /** Which onboarding wizard is running, for its progress dots. */
  flow?: 'signup' | 'signin';
}>({ section: 'archive', setup: false });

// Set by the page script. Panels call it after an action changes settings or the account.
export const app = {
  refresh: async (_initial?: boolean): Promise<void> => {},
};
