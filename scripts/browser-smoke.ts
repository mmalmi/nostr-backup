import type { Event as NostrEvent } from 'nostr-tools/pure';
// Run against a locally started ChromeDriver or geckodriver. No personal profile,
// real X request, account credential, or public relay is used.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from 'nostr-tools/pure';
import { nsecEncode, npubEncode } from 'nostr-tools/nip19';
import { profileHTML, publicTweetHTML } from '../test/fixtures.ts';
import './build.ts';

const browser = process.argv[2] ?? 'chrome';
if (!['chrome', 'firefox'].includes(browser)) throw Error('Choose chrome or firefox.');
const driver = process.env.DRIVER_URL ?? 'http://127.0.0.1:4444';
const uuid = '537b5f80-ec6f-4bcc-9fd8-2952dd234e59';
const prefs = {
  'extensions.webextensions.uuids': JSON.stringify({ 'nostr-backup@extensions.local': uuid }),
};
const vendor =
  browser === 'chrome'
    ? {
        'goog:chromeOptions': {
          args: [
            '--headless=new',
            '--remote-debugging-pipe',
            '--enable-unsafe-extension-debugging',
          ],
        },
      }
    : { 'moz:firefoxOptions': { args: ['-headless'], prefs } };
if (process.env.BROWSER_BINARY) Object.values(vendor)[0].binary = process.env.BROWSER_BINARY;
async function http<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(driver + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await r.json();
  if (!r.ok) throw Error(result.value?.message ?? r.statusText);
  return result.value;
}
const session = await http<{ sessionId: string; capabilities: { webSocketUrl: string } }>(
  'POST',
  '/session',
  {
    capabilities: { alwaysMatch: { browserName: browser, webSocketUrl: true, ...vendor } },
  },
);
const path = '/session/' + session.sessionId;
let relay: WebSocketServer | undefined, socket: WebSocket | undefined;
try {
  const connection = (socket = new WebSocket(session.capabilities.webSocketUrl));
  await new Promise<void>((ok, fail) => {
    connection.onopen = () => ok();
    connection.onerror = fail;
  });
  let seq = 0;
  const pending = new Map<
    number,
    (response: { type: string; message?: string; result: unknown }) => void
  >();
  function bidi<T = unknown>(method: string, params: object) {
    const id = ++seq;
    return new Promise<T>((res, rej) => {
      const t = setTimeout(() => {
        pending.delete(id);
        rej(Error(method + ' timed out'));
      }, 15000);
      pending.set(id, (r) => {
        clearTimeout(t);
        r.type === 'error' ? rej(Error(r.message)) : res(r.result as T);
      });
      connection.send(JSON.stringify({ id, method, params }));
    });
  }
  connection.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) {
      pending.get(m.id)?.(m);
      pending.delete(m.id);
      return;
    }
    if (m.method === 'log.entryAdded' && m.params.level === 'error')
      console.error('Browser error:', m.params.text);
    if (m.method === 'network.beforeRequestSent' && m.params.isBlocked) {
      const check = m.params.request.url === 'https://x.com/alice/status/123';
      void bidi('network.provideResponse', {
        request: m.params.request.request,
        statusCode: 200,
        headers: [
          {
            name: 'Content-Type',
            value: { type: 'string', value: 'text/html; charset=utf-8' },
          },
        ],
        body: {
          type: 'string',
          value: check ? publicTweetHTML('alice', '123', 'Hello\nbackup 🌲', 1704164645)
            : '<!DOCTYPE html><html><body>' + profileHTML + '</body></html>',
        },
      });
    }
  };
  await bidi('session.subscribe', {
    events: ['network.beforeRequestSent', 'log.entryAdded'],
  });
  await bidi('network.addIntercept', {
    phases: ['beforeRequestSent'],
    urlPatterns: [{ type: 'pattern', protocol: 'https', hostname: 'x.com' }],
  });
  const { extension } = await bidi<{ extension: string }>('webExtension.install', {
    extensionData: { type: 'path', path: resolve('dist', browser) },
  });
  const options =
    (browser === 'chrome' ? 'chrome-extension://' + extension : 'moz-extension://' + uuid) +
    '/archive.html';
  const key = generateSecretKey(),
    pubkey = getPublicKey(key),
    saved: NostrEvent[] = [];
  const native = finalizeEvent(
    { kind: 1, created_at: 2, content: 'Native note', tags: [] },
    key,
  );
  relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(relay, 'listening');
  const address = relay.address();
  assert.ok(address && typeof address !== 'string');
  const url = 'ws://127.0.0.1:' + address.port;
  relay.on('connection', (ws) =>
    ws.on('message', (frame) => {
      const [type, id, filter] = JSON.parse(frame.toString());
      if (type === 'REQ') {
        if (filter.authors?.includes(pubkey) && filter.until >= 2 && (filter.since ?? 0) <= 2)
          ws.send(JSON.stringify(['EVENT', id, native]));
        ws.send(JSON.stringify(['EOSE', id]));
      }
      if (type === 'EVENT') {
        assert.ok(verifyEvent(id));
        saved.push(id);
        ws.send(JSON.stringify(['OK', id.id, true, 'stored']));
      }
    }),
  );
  const go = (url: string) => http('POST', path + '/url', { url });
  const js = (script: string, ...args: unknown[]) =>
    http('POST', path + '/execute/sync', { script, args });
  async function waitFor(fn: () => unknown, label: string) {
    for (let i = 0; i < 120; i++) {
      if (await fn()) return;
      await delay(250);
    }
    throw Error('Timed out waiting for ' + label);
  }
  await go(options);
  await waitFor(
    () => js("return !document.querySelector('#onboarding').hidden"),
    'options page ready',
  );
  await js(
    `const [owner,relay]=arguments;
     return new Promise((resolve,reject)=>{
       const request=indexedDB.open('nostr-backup-accounts');
       request.onerror=()=>reject(request.error);
       request.onsuccess=()=>{
         const db=request.result,tx=db.transaction('records','readwrite');
         tx.objectStore('records').put({pubkey:owner,handle:'',capture:false,relaySync:false,
           relays:[relay],relaysConfigured:true,archiveName:'nostr-backup-'+owner},'account:'+owner);
         tx.oncomplete=()=>{db.close();resolve(true)};
         tx.onabort=()=>{db.close();reject(tx.error)};
       };
     })`,
    pubkey, url,
  );
  await js(
    "document.querySelector('#existingProfile').click();const input=document.querySelector('#loginKey');input.value=arguments[0];input.dispatchEvent(new Event('input',{bubbles:true}))",
    npubEncode(pubkey),
  );
  await waitFor(
    () =>
      js("return !document.querySelector('#workspace').hidden && location.hash==='#archive'"),
    'read-only profile opened',
  );
  await js(
    "const input=document.querySelector('#secret');input.value=arguments[0];input.dispatchEvent(new Event('input',{bubbles:true}))",
    nsecEncode(key),
  );
  await waitFor(() => js("return !document.querySelector('#lock').hidden"), 'signer unlock');
  await js(
    "const u=arguments[0];document.querySelector('#handle').value='alice';document.querySelector('#relays').value=u;document.querySelector('#capture').checked=true;document.querySelector('#relaySync').checked=true;document.querySelector('#backupSettings').requestSubmit()",
    url,
  );
  await waitFor(
    () => js("return document.querySelector('#notice').textContent==='Saved.'"),
    'settings save',
  );
  await go('https://x.com/alice');
  try {
    await waitFor(() => saved.length === 1, 'published X event');
  } catch (error) {
    console.error(
      'Capture page:',
      await js(
        "return {url:location.href,articles:document.querySelectorAll('article').length}",
      ),
    );
    await go(options);
    await waitFor(
      () => js("return !document.querySelector('#workspace').hidden"),
      'diagnostic page ready',
    );
    console.error(
      'Archive state:',
      await js(
        "return Object.fromEntries(['events','drafts','pending','notice','activity','reports'].map(id=>[id,document.getElementById(id)?.textContent]))",
      ),
    );
    throw error;
  }
  assert.equal(saved[0].content, 'Hello\nbackup 🌲');
  await go(options);
  await waitFor(
    () =>
      js(
        "return document.querySelector('#events').textContent==='2' && document.querySelector('#pending').textContent==='0'",
      ),
    'two archived events and acknowledged delivery',
  );
  console.log(
    browser +
      ' passed: installed extension, imported a note, captured one own X post and received relay OK.',
  );
} finally {
  socket?.close();
  for (const ws of relay?.clients ?? []) ws.terminate();
  relay?.close();
  await http('DELETE', path);
}
