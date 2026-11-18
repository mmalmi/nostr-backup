// Browser targets and newer Node versions supply Web Locks. Each Node 22 test worker
// owns its own fake IndexedDB and needs matching in-process snapshot/worker locks.
if (!navigator.locks) {
  const groups = new Map();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request(name, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const mode = options.mode ?? 'exclusive';
    const group = groups.get(name) ?? { readers: 0, writing: false, pending: [] };
    groups.set(name, group);
    const available = request => !group.writing && (request.mode === 'shared' || !group.readers);
    if (options.ifAvailable && (group.pending.length || !available({mode}))) return Promise.resolve().then(() => callback(null));
    return new Promise((resolve, reject) => {
      group.pending.push({mode, callback, resolve, reject});
      function dispatch() {
        while (group.pending.length && available(group.pending[0])) {
          const next = group.pending.shift();
          if (next.mode === 'shared') group.readers++;
          else group.writing = true;
          const release = () => {
            if (next.mode === 'shared') group.readers--;
            else group.writing = false;
            dispatch();
          };
          Promise.resolve().then(() => next.callback({name, mode: next.mode})).then(
            value => { release(); next.resolve(value); },
            error => { release(); next.reject(error); },
          );
        }
        if (!group.readers && !group.writing && !group.pending.length) groups.delete(name);
      }
      dispatch();
    });
  } } });
}
