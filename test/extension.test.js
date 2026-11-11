import 'fake-indexeddb/auto';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { runInThisContext } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { generateSecretKey, finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { nsecEncode } from 'nostr-tools/nip19';
import { openArchive } from '../src/archive.js';
import { build } from 'esbuild';

const key = generateSecretKey(),
  pubkey = getPublicKey(key);
const native = finalizeEvent(
  { kind: 1, created_at: 2, tags: [], content: 'Existing relay note' },
  key,
);
let accept = false;
const transmissions = [],
  subscriptions = [];
class Wire {
  static OPEN = 1;
  constructor() {
    this.readyState = 1;
    queueMicrotask(() => this.onopen?.());
  }
  send(frame) {
    const [type, id, filter] = JSON.parse(frame);
    const receive = (data) => setTimeout(() => this.onmessage?.({ data: JSON.stringify(data) }), 0);
    if (type === 'REQ') {
      subscriptions.push(filter);
      if (filter.until >= 2 && (filter.since ?? 0) <= 2) receive(['EVENT', id, native]);
      receive(['EOSE', id]);
    }
    if (type === 'EVENT') {
      transmissions.push(id);
      receive(['OK', id.id, accept, accept ? '' : 'blocked: temporary test failure']);
    }
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: 'closed' });
  }
}
function listener() {
  const list = [];
  return { addListener: (f) => list.push(f), list };
}
function area() {
  const state = {};
  return {
    async get(k) {
      return { [k]: structuredClone(state[k]) };
    },
    async set(v) {
      Object.assign(state, structuredClone(v));
    },
    async remove(k) {
      delete state[k];
    },
  };
}
const extensionId = 'test-extension',
  ext = 'chrome-extension://' + extensionId + '/';
let winURL;
const api = {
  storage: { local: area(), session: area() },
  runtime: {
    id: extensionId,
    getURL: (p) => ext + p,
    onMessage: listener(),
    onInstalled: listener(),
    onStartup: listener(),
  },
  alarms: { get: async () => true, onAlarm: listener() },
  tabs: { onRemoved: listener(), get: async () => ({ url: 'https://client.example/' }) },
  windows: {
    onRemoved: listener(),
    create: async (o) => {
      winURL = o.url;
      return { id: 1 };
    },
  },
};
globalThis.chrome = api;
globalThis.WebSocket = Wire;
const buildResult = await build({
  entryPoints: ['src/background.js'],
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
const call = (type, data = {}, sender = ui) =>
  new Promise((resolve) => api.runtime.onMessage.list[0]({ type, ...data }, sender, resolve));
const success = async (...args) => {
  const r = await call(...args);
  assert.equal(r.ok, true, r.error);
  return r.value;
};
async function until(fn) {
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
  assert.ok(subscriptions.every((f) => f.authors.length === 1 && f.authors[0] === pubkey));
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
  const req = (method, event, extra = {}) =>
    call('nip07', { token, method, event, ...extra }, sender);
  assert.equal((await req('getPublicKey')).value, pubkey);
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
    const id = winURL.split('#')[1],
      screen = { ...ui, url: winURL };
    assert.equal((await call('approval', { id, decision: true }, sender)).ok, false);
    assert.deepEqual((await success('approval', { id }, screen)).event, event);
    await success('approval', { id, decision: allow }, screen);
    const response = await pending;
    assert.equal(response.ok, allow);
    if (allow) {
      assert.equal(response.value.pubkey, pubkey);
      assert.ok(verifyEvent(response.value));
    }
    assert.equal((await call('approval', { id, decision: true }, screen)).ok, false);
  }
  await success('lock');
  assert.equal((await req('getPublicKey')).ok, false);
});
after(async () => {
  const db = await openArchive();
  db.close();
});
