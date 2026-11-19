/**
 * Runs archive and settings writes one at a time.
 * Urgent writes, such as settings the user just saved, run before queued background writes like relay imports,
 * so the interface never waits for a sync. A write that already started always finishes first.
 */
export function writeQueue() {
  const jobs: { urgent: boolean; run: () => Promise<void> }[] = [];
  let draining: Promise<void> | undefined;
  async function drain() {
    try {
      for (let job = jobs.shift(); job; job = jobs.shift()) await job.run();
    } finally {
      draining = undefined;
    }
  }
  return {
    write<T>(fn: () => T | Promise<T>, urgent = false): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const run = async () => {
          try {
            resolve(await fn());
          } catch (error) {
            reject(error);
          }
        };
        const at = urgent ? jobs.findIndex((job) => !job.urgent) : -1;
        if (at < 0) jobs.push({ urgent, run });
        else jobs.splice(at, 0, { urgent, run });
        // Writes start on a later tick, as they did when chained on a promise.
        draining ??= Promise.resolve().then(drain);
      });
    },
    /** Settles once every queued write has finished. */
    idle: () => draining ?? Promise.resolve(),
  };
}
