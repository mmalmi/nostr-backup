import type { Status } from '../types.ts';

// Shared state for the backup page. The page script updates it; panels read it.
export const page = $state<{ status?: Status; section: string }>({ section: 'archive' });

// Set by the page script. Panels call it after an action changes settings or the account.
export const app = {
  refresh: async (_initial?: boolean): Promise<void> => {},
};
