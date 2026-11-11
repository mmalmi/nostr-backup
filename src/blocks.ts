import type { Store } from '@hashtree/core';

// HashTree readers accept the full Store interface, including mutation methods.
export function readOnlyStore(get: Store['get']): Store {
  const rejectWrite = async (): Promise<never> => {
    throw Error('This block store is read-only.');
  };
  return { get, has: async (hash) => !!(await get(hash)), put: rejectWrite, delete: rejectWrite };
}
