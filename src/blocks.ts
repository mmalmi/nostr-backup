import type { Archive } from './types.ts';
import type { CID, Store } from '@hashtree/core';

// HashTree readers accept the full Store interface, including mutation methods.
export function readOnlyStore(get: Store['get']): Store {
  const rejectWrite = async (): Promise<never> => {
    throw Error('This block store is read-only.');
  };
  return { get, has: async (hash) => !!(await get(hash)), put: rejectWrite, delete: rejectWrite };
}

export const readRoot = (db: Archive) => db.get('meta', 'root') as Promise<CID | undefined>;
