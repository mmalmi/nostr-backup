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
import { startBrowserFixture } from './browser-fixture.ts';
import { profileHTML } from '../test/fixtures.ts';
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
const fixture = await startBrowserFixture();
const session = await http<{ sessionId: string; capabilities: { webSocketUrl: string } }>(
  'POST',
  '/session',
  {
    capabilities: { alwaysMatch: { browserName: browser, webSocketUrl: true, acceptInsecureCerts: true,
      proxy: { proxyType: 'manual', httpProxy: fixture.address, sslProxy: fixture.address, noProxy: ['127.0.0.1', 'localhost'] }, ...vendor } },
  },
).catch(error => { fixture.close(); throw error; });
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
  };
  await bidi('session.subscribe', { events: ['log.entryAdded'] });
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
    () => js("return document.querySelector('#onboarding')?.hidden === false"),
    'options page ready',
  );
  await js(
    `const [owner,relay]=arguments;
     return new Promise((resolve,reject)=>{
       const request=indexedDB.open('nostr-backup-accounts');
       request.onerror=()=>reject(request.error);
       request.onsuccess=()=>{
         const db=request.result,tx=db.transaction('records','readwrite');
         tx.objectStore('records').put({pubkey:owner,handle:'',capture:true,relaySync:true,
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
  await waitFor(() => js("return !!document.querySelector('#watchConfirm')"), 'read-only confirmation');
  await js("document.querySelector('#watchConfirm').click()");
  await waitFor(
    () =>
      js("return !document.querySelector('#workspace').hidden && !document.querySelector('[data-panel=archive]').hidden"),
    'read-only profile opened',
  );
  await js("document.querySelector('a[href=\"#account\"]').click()");
  await waitFor(() => js("return !document.querySelector('[data-panel=account]').hidden"), 'account settings');
  await js(
    "const input=document.querySelector('#secret');input.value=arguments[0];input.dispatchEvent(new Event('input',{bubbles:true}))",
    nsecEncode(key),
  );
  await waitFor(() => js("return !document.querySelector('#lock').hidden"), 'signer unlock');
  await js("document.querySelector('a[href=\"#sources\"]').click()");
  await waitFor(() => js("return !document.querySelector('[data-panel=sources]').hidden"), 'source settings');
  await js("const h=document.querySelector('#handle');h.value='alice';h.dispatchEvent(new Event('input',{bubbles:true}))");
  await waitFor(() => js("return !!document.querySelector('#handleSave')"), 'unsaved username');
  await js("document.querySelector('#handleSave').click()");
  await waitFor(
    () => js("return document.querySelector('#notice').textContent==='Saved.'"),
    'settings save',
  );
  const following = await js("return document.querySelector('[data-panel=sources] a[href$=\"/following\"]')?.href");
  assert.equal(following, 'https://x.com/alice/following');
  await go(following as string);
  await waitFor(() => js("return !!document.querySelector('[data-testid=UserCell]')"), 'X following list');
  // Leave the following page open while checking what the extension collected.
  const followingTab = await http<string>('GET', path + '/window');
  const { handle: settingsTab } = await http<{ handle: string }>('POST', path + '/window/new', { type: 'tab' });
  await http('POST', path + '/window', { handle: settingsTab });
  await go(options + '#sources');
  await waitFor(() => js("return document.querySelector('#findXFollows')?.disabled === false"), 'X follows ready without a self-verification');
  await http('DELETE', path + '/window');
  await http('POST', path + '/window', { handle: followingTab });
  // X changes routes and content without replacing the document. Chrome retains the sender's first URL.
  await js("history.pushState(null,'','/alice');document.body.innerHTML=arguments[0]", profileHTML);
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
      () => js("return document.querySelector('#workspace')?.hidden === false"),
      'diagnostic page ready',
    );
    console.error(
      'Archive state:',
      await js(
        "return Object.fromEntries(['events','drafts','onlineState','relayProblem','notice','reports','xCaptured','localXCount'].map(id=>[id,document.getElementById(id)?.textContent]))",
      ),
    );
    throw error;
  }
  assert.equal(saved[0].content, 'Hello\nbackup 🌲');
  await go(options);
  await waitFor(
    () =>
      js(
        "return document.querySelector('#events')?.textContent==='2' && !!document.querySelector('#onlineState')?.textContent.includes('up to date')",
      ),
    'two archived events and acknowledged delivery',
  );
  await go(new URL('wallet.html', options).href);
  await waitFor(() => js("return Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim()==='Enable wallet')"), 'wallet opens for the signed-in account');
  if (browser === 'chrome') {
    await js("Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim()==='Enable wallet').click()");
    await waitFor(() => js("return !!document.querySelector('#balanceTitle') && !!document.querySelector('input[type=url]')"), 'empty wallet and mint selection');
  }
  console.log(
    browser +
      ' passed: installed extension, read X follows, imported a note, captured one own X post, received relay OK and opened the wallet.',
  );
} finally {
  socket?.close();
  for (const ws of relay?.clients ?? []) ws.terminate();
  relay?.close();
  try { await http('DELETE', path); } finally { fixture.close(); }
}
