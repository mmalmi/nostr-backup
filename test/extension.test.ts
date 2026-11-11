import type { Filter } from 'nostr-tools/filter';
import type { Event as NostrEvent } from 'nostr-tools/pure';
import type { Action, Result, Reply, Message } from '../src/types.ts';
import type { Sender } from '../src/platform.d.ts';
import type { TestContext } from 'node:test';
import 'fake-indexeddb/auto';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInThisContext } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { generateSecretKey, finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { nsecEncode, npubEncode, decode } from 'nostr-tools/nip19';
import { append, openArchive, stagePosts } from '../src/archive.ts';
import { Reconciliation } from 'nostr-pubsub-reconcile';
import { retryDeadline } from '../src/rate-limit.ts';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const key = generateSecretKey(),
  pubkey = getPublicKey(key);
const native = finalizeEvent(
  { kind: 1, created_at: 2, tags: [], content: 'Existing relay note' },
  key,
);
let accept = false;
const transmissions: NostrEvent[] = [],
  subscriptions: Filter[] = [];
interface FixtureRelay {
  supported: boolean;
  sent: NostrEvent[];
  stored: Map<string, NostrEvent>;
  filters: Filter[];
  reads: Filter[];
  withheld?: string;
  reject?: string;
  negLimit?: string[];
  readLimit?: string[];
  publishLimit?: string[];
}
const broadcastRelays = new Map<string, FixtureRelay>();
class Wire extends EventTarget {
  static OPEN = 1;
  destination?: FixtureRelay;
  readyState = 1;
  neg?: Reconciliation;
  onopen?: () => void;
  onmessage?: (message: MessageEvent<string>) => void;
  onclose?: (event: { code: number; reason: string }) => void;
  constructor(url: string) {
    super();
    this.destination = broadcastRelays.get(new URL(url).href);
    queueMicrotask(() => this.onopen?.());
  }
  async send(frame: string) {
    const [type, id, filter, opening] = JSON.parse(frame);
    const receive = (data: unknown[]) =>
      setTimeout(() => {
        const message = new MessageEvent('message', { data: JSON.stringify(data) });
        this.dispatchEvent(message);
        this.onmessage?.(message);
      }, 0);
    const dest = this.destination;
    if (type === 'NEG-OPEN' || type === 'NEG-MSG') {
      if (type === 'NEG-OPEN') {
        dest?.filters.push(filter);
        if (dest?.negLimit) return receive(['NEG-ERR', id, ...dest.negLimit]);
        if (!dest?.supported) return receive(['NEG-ERR', id, 'unsupported']);
        const records = [...dest.stored.values()]
          .filter((e) => filter.authors.includes(e.pubkey) && filter.kinds.includes(e.kind))
          .map((e) => ({
            id: Buffer.from(e.id, 'hex'),
            timestamp: BigInt(e.created_at),
          }));
        this.neg = new Reconciliation(records, {
          since: BigInt(filter.since),
          until: BigInt(filter.until),
        });
      }
      assert.ok(this.neg);
      const reply = await this.neg.respond(Buffer.from(opening ?? filter, 'hex'));
      receive(['NEG-MSG', id, Buffer.from(reply).toString('hex')]);
    }
    if (type === 'REQ') {
      subscriptions.push(filter);
      dest?.reads?.push(filter);
      if (dest?.readLimit) return receive(['CLOSED', id, ...dest.readLimit]);
      const matches = (dest ? [...dest.stored.values()] : [native]).filter(
        (e) =>
          e.id !== dest?.withheld &&
          e.created_at <= filter.until &&
          e.created_at >= (filter.since ?? 0) &&
          (!filter.ids || filter.ids.includes(e.id)) &&
          filter.authors.includes(e.pubkey) &&
          filter.kinds.includes(e.kind),
      );
      matches.sort((a, b) => b.created_at - a.created_at);
      for (const e of matches.slice(0, filter.limit)) receive(['EVENT', id, e]);
      receive(['EOSE', id]);
    }
    if (type === 'EVENT') {
      transmissions.push(id);
      const ok = dest ? dest.reject !== id.id : accept;
      if (dest) {
        dest.sent.push(id);
        if (dest.publishLimit) return receive(['OK', id.id, false, ...dest.publishLimit]);
        if (ok) dest.stored.set(id.id, id);
      }
      receive(['OK', id.id, ok, ok ? '' : 'blocked: temporary test failure']);
    }
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: 'closed' });
  }
}
function listener<F = () => void>() {
  const list: F[] = [];
  return { addListener: (f: F) => list.push(f), list };
}
function area() {
  const state: Record<string, unknown> = {};
  return {
    async get(k: string) {
      return { [k]: structuredClone(state[k]) };
    },
    async set(v: Record<string, unknown>) {
      Object.assign(state, structuredClone(v));
    },
    async clear() {
      for (const k of Object.keys(state)) delete state[k];
    },
    async remove(k: string) {
      delete state[k];
    },
  };
}
const extensionId = 'test-extension',
  ext = 'chrome-extension://' + extensionId + '/';
let winURL: string | undefined;
function approvalScreen() {
  assert.ok(winURL);
  return { ...ui, url: winURL };
}
type Injection = { world?: 'MAIN'; target: { tabId: number }; func: Function; args?: unknown[] };
const api = {
  scripting: {
    executeScript: async (_: Injection): Promise<{ result: unknown }[]> => {
      throw Error('Unexpected script injection');
    },
  },
  storage: { local: area(), session: area() },
  runtime: {
    id: extensionId,
    getURL: (p: string) => ext + p,
    onMessage:
      listener<
        (message: object, sender: Sender, reply: (response: Reply<unknown>) => void) => boolean
      >(),
    onInstalled: listener(),
    onStartup: listener(),
  },
  alarms: {
    get: async () => true,
    create: async () => {},
    onAlarm: listener<(alarm: { name: string }) => void>(),
  },
  tabs: {
    query: async () => [] as { id: number; url: string }[],
    onRemoved: listener(),
    get: async () => ({ url: 'https://client.example/' }),
  },
  windows: {
    onRemoved: listener(),
    create: async (o: { url: string }) => {
      winURL = o.url;
      return { id: 1 };
    },
  },
};
Object.defineProperty(globalThis, 'chrome', { configurable: true, value: api });
Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Wire });
// Node 22 lacks Web Locks. This fixture issues worker deletion requests sequentially.
if (!navigator.locks)
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: async (_name: string, callback: () => unknown) => callback() },
  });
const buildResult = await build({
  entryPoints: ['src/background.ts'],
  bundle: true,
  minify: true,
  format: 'iife',
  write: false,
  target: 'chrome120',
});
runInThisContext(buildResult.outputFiles[0].text);
const ui = { id: extensionId, url: ext + 'archive.html', frameId: 0 };
const x = {
  id: extensionId,
  url: 'https://x.com/alice',
  tab: { id: 1, url: 'https://x.com/alice' },
  frameId: 0,
};
function call<K extends Action>(
  type: K,
  data: object = {},
  sender: Sender = ui,
): Promise<Reply<Result<K>>> {
  return new Promise((resolve) =>
    api.runtime.onMessage.list[0]({ type, ...data }, sender, (response) =>
      resolve(response as Reply<Result<K>>),
    ),
  );
}
async function success<K extends Action>(
  type: K,
  data: object = {},
  sender: Sender = ui,
): Promise<Result<K>> {
  const response = await call(type, data, sender);
  if (!response.ok) assert.fail(response.error);
  return response.value;
}
async function until(fn: () => unknown) {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await delay(20);
  }
  assert.fail('timed out');
}

test('background entry point handles locked capture, signed import, rejection and acknowledged retry', async () => {
  assert.equal((await call('settings', { pubkey }, x)).ok, false);
  await success('settings', {
    pubkey,
    handle: 'alice',
    relays: 'wss://fixture.example',
    relaySync: true,
    capture: true,
  });
  await until(async () => !(await success('status')).running);
  const post = { author: 'alice', id: '987', text: 'Text to archive', time: 1700000000 };
  assert.equal((await call('capture', { posts: [post] }, { ...x, frameId: 1 })).ok, false);
  await Promise.all([
    success('capture', { posts: [post] }, x),
    success('capture', { posts: [post] }, x),
  ]);
  await until(async () => !(await success('status')).running);
  let status = await success('status');
  assert.equal(status.drafts, 1);
  assert.equal(status.events, 1);
  assert.equal(transmissions.length, 0);
  assert.equal((await call('unlock', { key: nsecEncode(generateSecretKey()) })).ok, false);
  await success('unlock', { key: nsecEncode(key) });
  await until(async () => !(await success('status')).running);
  status = await success('status');
  assert.equal(status.drafts, 0);
  assert.equal(status.events, 2);
  assert.equal(status.pending, 1);
  assert.equal(transmissions.length, 1);
  assert.ok(verifyEvent(structuredClone(transmissions[0])));
  assert.ok(subscriptions.every((f) => f.authors?.length === 1 && f.authors[0] === pubkey));
  accept = true;
  await success('sync');
  await until(async () => !(await success('status')).running);
  assert.equal((await success('status')).pending, 0);
  assert.deepEqual(transmissions[1], transmissions[0]);
  await success('capture', { posts: [post] }, x);
  await until(async () => !(await success('status')).running);
  assert.equal(transmissions.length, 2);
});
test('signer binds requests to a granted tab, exposes the key and signs only an approved template', async () => {
  const token = crypto.randomUUID(),
    origin = 'https://client.example';
  const sender = { id: extensionId, url: origin + '/', tab: { id: 8 }, frameId: 0 };
  await api.storage.session.set({ 'grant-8': { token, origin } });
  await success('unlock', { key: nsecEncode(key) });
  const req = (method: string, event?: object, extra: object = {}) =>
    call('nip07', { token, method, event, ...extra }, sender);
  assert.deepEqual(await req('getPublicKey'), { ok: true, value: pubkey });
  assert.equal((await req('signEvent', {}, { token: 'forged' })).ok, false);
  assert.equal(
    (
      await call(
        'nip07',
        { token, method: 'getPublicKey' },
        { ...sender, url: 'https://elsewhere.example/' },
      )
    ).ok,
    false,
  );
  const event = {
    kind: 27235,
    created_at: 12345,
    tags: [
      ['u', origin + '/login'],
      ['method', 'GET'],
    ],
    content: '',
  };
  for (const allow of [false, true]) {
    winURL = undefined;
    const pending = req('signEvent', event);
    await until(() => !!winURL);
    const screen = approvalScreen(),
      id = screen.url.split('#')[1];
    assert.equal((await call('approval', { id, decision: true }, sender)).ok, false);
    const preview = await success('approval', { id }, screen);
    assert.ok(preview);
    assert.deepEqual(preview.event, event);
    await success('approval', { id, decision: allow }, screen);
    const response = await pending;
    assert.equal(response.ok, allow);
    if (allow) {
      assert.ok(response.ok && typeof response.value === 'object');
      assert.equal(response.value.pubkey, pubkey);
      assert.ok(verifyEvent(response.value));
    }
    assert.equal((await call('approval', { id, decision: true }, screen)).ok, false);
  }
  await success('lock');
  assert.equal((await req('getPublicKey')).ok, false);
});
test('the popup injects window.nostr and the page signs a login event through the approval screen', async (t) => {
  const origin = 'https://client.example';
  const tab = { id: 8, url: origin + '/' };
  const site = new Window({ url: tab.url });
  t.after(() => site.happyDOM.abort());
  // Happy DOM reports its host Window as the sender. A browser exposes the
  // page's WindowProxy to handlers running inside the page.
  const pageWindow = site.eval('window');
  site.addEventListener(
    'message',
    (event) => {
      if ('source' in event && event.source === site)
        Object.defineProperty(event, 'source', { value: pageWindow });
    },
    true,
  );
  await success('login', { key: nsecEncode(key) });
  const sender = { id: extensionId, tab, url: tab.url, frameId: 0 };
  const bridge = {
    chrome: { runtime: { sendMessage: ({ type, ...body }: Message) => call(type, body, sender) } },
  };
  const worlds: string[] = [];
  t.mock.method(api.tabs, 'query', async () => [tab]);
  t.mock.method(
    api.scripting,
    'executeScript',
    async ({ world, target, func, args = [] }: Injection) => {
      assert.equal(target.tabId, tab.id);
      worlds.push(world ?? 'ISOLATED');
      // Chrome serializes the injected function. The isolated world shares the DOM
      // with the page and has its own global object and runtime API.
      const run =
        world === 'MAIN'
          ? site.eval('(' + func.toString() + ')')
          : site.Function(
              'globalThis',
              'chrome',
              'return (' + func.toString() + ')',
            )(bridge, bridge.chrome);
      return [{ result: run(...args) }];
    },
  );
  const popup = await extensionPage(t, 'popup');
  pageElements(popup)('signer').click();
  await until(() => pageElements(popup)('notice').textContent.includes('Signer enabled'));
  assert.deepEqual(worlds, ['ISOLATED', 'MAIN']);
  assert.equal(await site.eval('window.nostr.getPublicKey()'), pubkey);
  const login = {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['u', origin + '/login'],
      ['method', 'POST'],
    ],
    content: '',
  };
  winURL = undefined;
  const pending: Promise<NostrEvent> = site.eval(
    'window.nostr.signEvent(' + JSON.stringify(login) + ')',
  );
  await until(() => !!winURL);
  const review = await extensionPage(t, 'approve', undefined, approvalScreen().url);
  await until(() => !pageElements(review)('allow').disabled);
  assert.ok(pageElements(review)('origin').textContent.includes(origin));
  assert.deepEqual(JSON.parse(pageElements(review)('event').textContent), login);
  pageElements(review)('allow').click();
  const signed = await pending;
  assert.equal(signed.pubkey, pubkey);
  assert.deepEqual(
    { ...login, id: signed.id, pubkey, sig: signed.sig },
    JSON.parse(JSON.stringify(signed)),
  );
  assert.ok(verifyEvent(structuredClone(signed)));
  await success('lock');
  await assert.rejects(site.eval('window.nostr.getPublicKey()'), /locked/);
});
function installPageStorage(page: Window) {
  for (const [name, value] of Object.entries({
    indexedDB,
    IDBKeyRange,
    IDBRequest,
    IDBDatabase,
    IDBObjectStore,
    IDBIndex,
    IDBCursor,
    IDBTransaction,
    structuredClone,
    crypto,
    Uint8Array,
    ArrayBuffer,
    Blob,
  }))
    Object.defineProperty(page, name, { value, configurable: true });
  Object.defineProperty(page.navigator, 'locks', {
    value: { request: (_: string, __: object, fn: (lock: object) => unknown) => fn({}) },
  });
}
function pageElements(page: Window): typeof import('../src/ui.ts').el {
  return ((id: string) => {
    const element = page.document.getElementById(id);
    assert.ok(element, 'Missing fixture element ' + id);
    return element;
  }) as unknown as typeof import('../src/ui.ts').el;
}
function archivePage(t: TestContext, setup?: (page: Window) => void) {
  return extensionPage(t, 'archive', setup);
}
async function extensionPage(
  t: TestContext,
  name: 'archive' | 'approve' | 'popup',
  setup?: (page: Window) => void,
  url = ext + name + '.html',
) {
  const page = new Window({
    url,
    settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true },
  });
  t.after(() => page.happyDOM.abort());
  Object.defineProperty(page, 'chrome', {
    value: {
      storage: api.storage,
      runtime: { sendMessage: ({ type, ...body }: Message) => call(type, body, { ...ui, url }) },
    },
  });
  page.document.documentElement.innerHTML = await readFile('ui/' + name + '.html', 'utf8');
  const bundle = await build({
    entryPoints: ['src/' + (name === 'archive' ? 'archive-ui' : name) + '.ts'],
    bundle: true,
    write: false,
    format: 'iife',
  });
  setup?.(page);
  page.eval(bundle.outputFiles[0].text);
  return page;
}
test('archive button reconciles each relay, falls back and retries with capture and signing off', async (t) => {
  const db = await openArchive('nostr-backup-' + pubkey);
  const capable = 'wss://neg.example/',
    plain = 'wss://plain.example/';
  const relays = [capable, plain];
  for (const url of relays)
    broadcastRelays.set(url, {
      supported: url === capable,
      sent: [],
      stored: new Map(),
      filters: [],
      reads: [],
    });
  const neg = broadcastRelays.get(capable)!,
    fallback = broadcastRelays.get(plain)!;
  const configure = (urls: string[]) =>
    success('settings', {
      pubkey,
      handle: '',
      relays: urls.join('\n'),
      capture: false,
      relaySync: false,
    });
  const idle = () => until(async () => !(await success('status')).running);
  await success('lock');
  await configure([]);
  await idle();
  assert.equal((await call('broadcast')).ok, false);
  await configure(relays);
  await idle();
  const copy = finalizeEvent({ kind: 1, created_at: 99, tags: [], content: 'Signed X copy' }, key);
  await append(db, [{ event: native }, { event: copy, source: 'x:99', targets: [] }], pubkey);
  await stagePosts(db, [{ author: 'alice', id: '876', time: 90, text: 'Unsigned' }]);
  const archive = await db.getAll('events');
  const ids = archive.map((event) => event.id).sort();
  neg.stored.set(native.id, native);
  fallback.reject = copy.id;
  assert.equal((await call('broadcast', {}, x)).ok, false);
  const page = await archivePage(t);
  const button = pageElements(page)('broadcast');
  await until(() => !button.disabled);
  button.click();
  await until(() =>
    pageElements(page)('notice').textContent.includes(`Queued ${ids.length} signed`),
  );
  await idle();
  assert.deepEqual(
    neg.sent.map((e) => e.id).sort(),
    ids.filter((id) => id !== native.id),
  );
  assert.deepEqual(fallback.sent.map((e) => e.id).sort(), ids);
  for (const dest of [neg, fallback]) {
    assert.deepEqual(dest.filters[0].authors, [pubkey]);
    for (const e of dest.sent)
      assert.deepEqual(
        e,
        archive.find((event) => event.id === e.id),
      );
  }
  let status = await success('status');
  assert.match(status.lastRun!.reports[capable], /1 already on relay/);
  assert.match(status.lastRun!.reports[plain], /pending retry/);
  assert.equal(status.pending, 1);
  await configure([capable]);
  await idle();
  assert.equal((await success('status')).pending, 1);
  fallback.reject = undefined;
  await configure(relays);
  await idle();
  assert.deepEqual(
    fallback.sent.at(-1),
    archive.find((e) => e.id === copy.id),
  );
  assert.equal((await success('status')).pending, 0);
  await configure([capable]);
  await idle();
  await success('broadcast');
  await idle();
  assert.equal(neg.sent.length, ids.length - 1);
  status = await success('status');
  assert.equal(status.drafts, 1);
  assert.equal(status.pending, 0);
  assert.equal(status.unlocked, false);
  db.close();
});
const idle = () => until(async () => !(await success('status')).running);
test('the outbox stores a deadline even when the relay omits a delay', (t) => {
  t.mock.method(Date, 'now', () => 10000);
  assert.equal(retryDeadline({ retryAfterMs: 2500 }), 12500);
  assert.equal(retryDeadline({}), 70000);
});
async function configureRelays(urls: string[], relaySync: boolean) {
  await success('settings', {
    pubkey,
    handle: '',
    relays: urls.join('\n'),
    capture: false,
    relaySync,
  });
  await idle();
}
function fixtureRelay(url: string, supported = true) {
  const dest: FixtureRelay = { supported, sent: [], stored: new Map(), filters: [], reads: [] };
  broadcastRelays.set(url, dest);
  return dest;
}
const note = (content: string, created_at: number) =>
  finalizeEvent({ kind: 1, created_at, tags: [], content }, key);

test('two-way sync restores an empty archive, reconciles both sides and retries incomplete downloads', async (t) => {
  const db = await openArchive('nostr-backup-' + pubkey);
  t.after(() => db.close());
  for (const name of db.objectStoreNames) await db.clear(name);
  const url = 'wss://both.example/';
  const relay = fixtureRelay(url);
  await configureRelays([url], true);
  const older = note('old relay-only post', 1);
  relay.stored.set(older.id, older);
  // The previous scheduled import completed. A manual run still covers time zero.
  const page = await archivePage(t);
  const button = pageElements(page)('broadcast');
  await until(() => !button.disabled);
  assert.equal(button.textContent, 'Broadcast and import');
  button.click();
  await until(() => pageElements(page)('notice').textContent.includes('Checking saved relays'));
  await idle();
  assert.equal((await db.get('events', older.id))?.sig, older.sig);
  assert.equal(relay.filters.at(-1)?.since, 0);
  assert.deepEqual(relay.reads.at(-1)?.ids, [older.id]);
  assert.equal(relay.sent.length, 0);

  const local = note('local only', 200);
  await append(db, [{ event: local }], pubkey);
  const remote = Array.from({ length: 101 }, (_, i) => note('remote ' + i, i + 400));
  for (const event of remote) relay.stored.set(event.id, event);
  relay.withheld = remote.at(-1)!.id;
  const start = relay.filters.length;
  await success('broadcast');
  await idle();
  assert.equal(relay.filters.length, start + 1);
  assert.ok(relay.reads.every((f) => f.ids && f.ids.length <= 100));
  assert.deepEqual(
    relay.sent.map((e) => e.id),
    [local.id],
  );
  assert.equal(await db.get('cursors', [pubkey, url]), undefined);
  assert.match((await success('status')).lastRun!.reports[url], /Incomplete/);
  relay.withheld = undefined;
  await success('sync');
  await idle();
  assert.equal(await db.count('events'), 2 + remote.length);
  assert.equal(await db.count('outbox'), 0);
  assert.ok(((await db.get('cursors', [pubkey, url]))?.through ?? 0) > 0);

  const extra = note('never published by scheduled imports', 500);
  await append(db, [{ event: extra }], pubkey);
  const now = Math.floor(Date.now() / 1000);
  const fresh = note('new relay event', now);
  relay.stored.set(fresh.id, fresh);
  await success('sync');
  await idle();
  assert.equal((await db.get('events', fresh.id))?.sig, fresh.sig);
  assert.deepEqual(
    relay.sent.map((e) => e.id),
    [local.id],
  );
  assert.equal(relay.reads.at(-1)?.ids?.length, 1);
});

test('relay cooldown survives immediate syncs and lets other relays finish', async (t) => {
  const db = await openArchive('nostr-backup-' + pubkey);
  t.after(() => db.close());
  for (const name of db.objectStoreNames) await db.clear(name);
  const slow = 'wss://slow.example/',
    fast = 'wss://fast.example/';
  const limited = fixtureRelay(slow),
    healthy = fixtureRelay(fast, false);
  await configureRelays([slow, fast], false);
  const events = [note('pending one', 2), note('pending two', 3)];
  await append(
    db,
    events.map((event) => ({ event })),
    pubkey,
  );
  const count = await db.count('events');
  const epoch = Date.now();
  let now = epoch;
  t.mock.method(Date, 'now', () => now);
  const alarms = new Map();
  t.mock.method(api.alarms, 'create', async (name: string, options: { when: number }) =>
    alarms.set(name, options.when),
  );
  limited.publishLimit = ['rate-limited: slow down', '125000'];
  await success('broadcast');
  await idle();
  const cooldown = ['retryAfter', slow];
  assert.equal(await db.get('meta', cooldown), epoch + 125000);
  assert.equal(alarms.get('relay-retry:' + slow), epoch + 125000);
  assert.equal(limited.sent.length, 1);
  assert.equal(healthy.sent.length, count);
  assert.equal(await db.count('outbox'), count);
  limited.publishLimit = undefined;
  now += 124999;
  await success('sync');
  await idle();
  assert.equal(limited.sent.length, 1);
  now++;
  api.alarms.onAlarm.list[0]({ name: 'relay-retry:' + slow });
  await idle();
  assert.equal(limited.sent.length, count + 1);
  assert.equal(await db.count('outbox'), 0);

  const sent = limited.sent.length;
  limited.negLimit = ['rate-limited: quota exceeded; retry in 4s'];
  await configureRelays([slow], false);
  await success('broadcast');
  await idle();
  assert.equal(limited.sent.length, sent);
  assert.equal(await db.count('outbox'), count);
  assert.equal(await db.get('meta', cooldown), now + 4000);
  now += 4000;
  limited.negLimit = undefined;
  limited.supported = false;
  limited.readLimit = ['rate-limited: reduce requests', '90000'];
  await configureRelays([slow], true);
  assert.equal(await db.get('meta', cooldown), now + 90000);
  assert.equal(limited.sent.length, sent);
  now += 90000;
  limited.readLimit = undefined;
  const remote = note('old post on fallback relay', 12);
  limited.stored.set(remote.id, remote);
  await success('broadcast');
  await idle();
  assert.equal((await db.get('events', remote.id))?.sig, remote.sig);
  assert.equal(await db.count('outbox'), 0);
});
test('tabbed archive backs up a media attachment and scopes uploads to its saved server', async (t) => {
  const server = 'https://media.example',
    mediaURL = 'https://files.example/test.png';
  const db = await openArchive('nostr-backup-' + pubkey);
  t.after(() => db.close());
  await success('settings', { pubkey, relays: '', handle: '', blossomServer: server, mediaMiB: 8 });
  const note = finalizeEvent({ kind: 1, content: mediaURL, tags: [], created_at: 17 }, key);
  await append(db, [{ event: note }], pubkey);
  await success('lock');
  const page = await archivePage(t, (page) => {
    installPageStorage(page);
    const fetcher: typeof fetch = async (url, init) => {
      if (url === mediaURL)
        return new Response('media bytes', { headers: { 'Content-Type': 'image/png' } });
      assert.equal(url, server + '/upload');
      const auth = JSON.parse(
        Buffer.from(new Headers(init?.headers).get('Authorization')!.slice(6), 'base64').toString(),
      );
      assert.ok(verifyEvent(auth));
      assert.equal(auth.kind, 24242);
      assert.ok(auth.tags.some((t) => t[0] === 'server' && t[1] === 'media.example'));
      const hash = new Headers(init?.headers).get('X-SHA-256');
      assert.ok(auth.tags.some((t) => t[0] === 'x' && t[1] === hash));
      assert.ok(init?.body instanceof Uint8Array);
      return Response.json({
        sha256: hash,
        size: init.body.length,
        url: server + '/' + hash,
      });
    };
    Object.defineProperty(page, 'fetch', { value: fetcher });
  });
  const id = pageElements(page);
  const tab = (hash: string) => {
    page.location.hash = hash;
    page.dispatchEvent(new page.Event('hashchange'));
  };
  tab('#settings');
  await until(() => id('blossomServer').value === server);
  assert.equal(page.document.querySelector('[data-panel="archive"]')?.hasAttribute('hidden'), true);
  assert.equal(
    page.document.querySelector('a[aria-current="page"]')?.getAttribute('href'),
    '#settings',
  );
  tab('#media');
  await until(() => !id('backupMedia').disabled);
  id('backupMedia').click();
  await until(() => id('notice').textContent);
  assert.match(id('notice').textContent, /1 saved/);
  await until(() => id('savedFiles').textContent === '1');
  assert.equal(id('uploadMedia').disabled, true);
  const [file] = await db.getAll('mediaFiles');
  assert.equal((await call('authorizeMediaUpload', { server, hash: file.sha256 })).ok, false);
  await success('unlock', { key: nsecEncode(key) });
  assert.equal(
    (await call('authorizeMediaUpload', { server: 'https://elsewhere.example', hash: file.sha256 }))
      .ok,
    false,
  );
  assert.equal((await call('authorizeMediaUpload', { server, hash: file.sha256 }, x)).ok, false);
  assert.equal((await call('status', {}, { ...ui, url: ui.url + '#settings' })).ok, true);
  tab('#media');
  await until(() => !id('uploadMedia').disabled);
  id('uploadMedia').click();
  await until(() => id('notice').textContent.startsWith('Uploaded '));
  assert.deepEqual((await db.get('mediaFiles', file.sha256))?.copies, [server]);
});
test('Settings creates a recoverable profile, logs out, isolates accounts and deletes only the confirmed archive', async (t) => {
  const previous = await success('status');
  if (previous.conf.pubkey) await success('logout', { pubkey: previous.conf.pubkey });
  const page = await archivePage(t, installPageStorage);
  const id = pageElements(page);
  await until(() => !id('onboarding').hidden);
  id('startProfile').click();
  const nsec = id('recoveryKey').value;
  const decoded = decode(nsec);
  assert.equal(decoded.type, 'nsec');
  const owner = getPublicKey(decoded.data);
  id('profileName').value = 'Example';
  id('keySaved').checked = true;
  id('newProfile').requestSubmit();
  await until(() => id('notice').textContent.includes('created locally'));
  assert.equal(id('recoveryKey').value, '');
  assert.equal(id('accountNpub').value, npubEncode(owner));
  assert.equal(id('indexAddress').value, 'htree://' + npubEncode(owner) + '/my-events');
  const first = await success('status');
  assert.ok(first.conf.archiveName);
  assert.equal(first.events, 1);
  assert.equal(first.unlocked, true);
  const d = await openArchive(first.conf.archiveName);
  const [profile] = await d.getAll('events');
  d.close();
  assert.equal(profile.kind, 0);
  assert.equal(JSON.parse(profile.content).name, 'Example');
  assert.ok(verifyEvent(profile));
  const relayUrl = 'wss://index.example/';
  const relay = fixtureRelay(relayUrl);
  const server = 'https://blocks.example';
  let pausedUpload: PromiseWithResolvers<void> | undefined;
  let suspendUploads = false;
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init: RequestInit = {}) => {
    assert.equal(new URL(String(url)).origin, server);
    if (suspendUploads && init.method === 'PUT') {
      pausedUpload ??= Promise.withResolvers<void>();
      await pausedUpload.promise;
    }
    if (init.method === 'HEAD') return new Response(null, { status: 404 });
    assert.equal(init.method, 'PUT');
    const hash = new Headers(init?.headers).get('X-SHA-256');
    assert.ok(init.body instanceof Blob);
    return Response.json({
      sha256: hash,
      size: init.body.size,
      url: server + '/' + hash,
    });
  });
  id('relays').value = relayUrl;
  id('blossomServer').value = server;
  id('backupSettings').requestSubmit();
  await until(() => id('notice').textContent === 'Settings saved.');
  page.location.hash = '#archive';
  page.dispatchEvent(new page.Event('hashchange'));
  await until(() => !id('publishIndex').disabled);
  assert.equal(relay.sent.length, 0);
  id('publishIndex').click();
  await until(async () => (await success('status')).pointer?.acknowledged.includes(relayUrl));
  page.dispatchEvent(new page.Event('hashchange'));
  await until(() => id('pointerStatus').textContent.includes('Acknowledged by ' + relayUrl));
  assert.equal(relay.sent.length, 1);
  assert.equal(relay.sent[0].kind, 30064);
  assert.ok(verifyEvent(relay.sent[0]));
  assert.equal((await success('status')).events, 1);
  page.location.hash = '#storage';
  page.dispatchEvent(new page.Event('hashchange'));
  await until(() => id('kindList').textContent.includes('Kind 0'));
  assert.match(id('storageTotals').textContent, /Event index blocks/);
  const details = id('kindList').querySelector('details');
  assert.ok(details);
  details.open = true;
  details.dispatchEvent(new page.Event('toggle') as unknown as Event);
  assert.ok(details.textContent.includes(profile.id));
  await api.storage.session.set({ 'grant-99': { token: 'old' } });
  suspendUploads = true;
  const interrupted = call('publishIndex', { account: owner });
  await until(() => !!pausedUpload);
  id('logout').click();
  await until(() => id('notice').textContent.includes('Logged out'));
  assert.equal((await interrupted).ok, false);
  suspendUploads = false;
  assert.ok(pausedUpload);
  pausedUpload.resolve();
  assert.equal((await success('status')).events, 0);
  assert.equal((await api.storage.session.get('grant-99'))['grant-99'], undefined);
  assert.equal((await api.storage.session.get('signingKey'))?.signingKey, undefined);
  const other = generateSecretKey(),
    otherPub = getPublicKey(other);
  assert.equal((await call('login', { key: 'bad-key' }, x)).ok, false);
  await success('login', { key: Buffer.from(other).toString('hex') });
  assert.equal((await success('status')).events, 0);
  assert.equal((await call('deleteAccount', { pubkey: owner, confirmed: true })).ok, false);
  assert.equal((await call('deleteAccount', { pubkey: otherPub })).ok, false);
  await success('logout', { pubkey: otherPub });
  await success('watch', { pubkey: npubEncode(owner) });
  assert.equal((await success('status')).events, 1);
  assert.equal((await success('status')).unlocked, false);
  await success('login', { key: nsec });
  const local = await openArchive(first.conf.archiveName);
  const { openMediaBlocks } = await import('../src/media-files.ts');
  const stored = openMediaBlocks(local);
  await stored.put(new Uint8Array(32), new Uint8Array([12]));
  stored.close();
  local.close();
  page.location.hash = '#settings';
  page.dispatchEvent(new page.Event('hashchange'));
  await until(() => id('accountNpub').value === npubEncode(owner));
  id('deleteStart').click();
  assert.equal(id('deleteConfirm').hidden, false);
  id('cancelDelete').click();
  assert.equal(id('deleteConfirm').hidden, true);
  id('deleteStart').click();
  id('deleteAccount').click();
  await until(() => id('notice').textContent.includes('Local archive deleted.'));
  assert.equal((await success('status')).conf.pubkey, '');
  const names = (await indexedDB.databases()).map((db) => db.name);
  assert.ok(!names.includes(first.conf.archiveName));
  assert.ok(!names.includes(first.conf.archiveName + '-media'));
  assert.ok(names.includes('nostr-backup-' + otherPub));
  await success('login', { key: nsec });
  assert.equal((await success('status')).events, 0);
  await success('logout', { pubkey: owner });
});

test('legacy single-account data reopens under its original identity after logout', async () => {
  const legacyKey = generateSecretKey(),
    legacyPub = getPublicKey(legacyKey);
  const conf = { pubkey: legacyPub, handle: '', capture: false, relaySync: false, relays: [] };
  const db = await openArchive('nostr-backup-v1');
  await append(
    db,
    [
      {
        event: finalizeEvent(
          { kind: 1, content: 'old archive', tags: [], created_at: 123 },
          legacyKey,
        ),
      },
    ],
    legacyPub,
  );
  db.close();
  await api.storage.local.set({ settings: conf });
  await success('logout', { pubkey: legacyPub });
  await success('login', { key: nsecEncode(legacyKey) });
  assert.equal((await success('status')).conf.archiveName, 'nostr-backup-v1');
  assert.equal((await success('status')).events, 1);
  await success('logout', { pubkey: legacyPub });
});
after(async () => {
  const db = await openArchive('nostr-backup-' + pubkey);
  db.close();
});
