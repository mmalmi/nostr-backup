// Run against a locally started ChromeDriver or geckodriver. No personal profile,
// real X request, account credential, or public relay is used.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { nsecEncode } from 'nostr-tools/nip19';
import { profileHTML } from '../test/fixtures.js';
import './build.js';

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
async function http(method, path, body) {
  const r = await fetch(driver + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await r.json();
  if (!r.ok) throw Error(result.value?.message ?? r.statusText);
  return result.value;
}
const session = await http('POST', '/session', {
  capabilities: { alwaysMatch: { browserName: browser, webSocketUrl: true, ...vendor } },
});
const path = '/session/' + session.sessionId;
let relay, socket;
try {
  socket = new WebSocket(session.capabilities.webSocketUrl);
  await new Promise((ok, fail) => {
    socket.onopen = ok;
    socket.onerror = fail;
  });
  let seq = 0;
  const pending = new Map();
  function bidi(method, params) {
    const id = ++seq;
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        pending.delete(id);
        rej(Error(method + ' timed out'));
      }, 15000);
      pending.set(id, (r) => {
        clearTimeout(t);
        r.type === 'error' ? rej(Error(r.message)) : res(r.result);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  socket.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) {
      pending.get(m.id)?.(m);
      pending.delete(m.id);
      return;
    }
    if (m.method === 'network.beforeRequestSent' && m.params.isBlocked) {
      void bidi('network.provideResponse', {
        request: m.params.request.request,
        statusCode: 200,
        headers: [
          { name: 'Content-Type', value: { type: 'string', value: 'text/html; charset=utf-8' } },
        ],
        body: {
          type: 'string',
          value: '<!DOCTYPE html><html><body>' + profileHTML + '</body></html>',
        },
      });
    }
  };
  await bidi('session.subscribe', { events: ['network.beforeRequestSent'] });
  await bidi('network.addIntercept', {
    phases: ['beforeRequestSent'],
    urlPatterns: [{ type: 'pattern', protocol: 'https', hostname: 'x.com' }],
  });
  const { extension } = await bidi('webExtension.install', {
    extensionData: { type: 'path', path: resolve('dist', browser) },
  });
  const options =
    (browser === 'chrome' ? 'chrome-extension://' + extension : 'moz-extension://' + uuid) +
    '/archive.html';
  const key = generateSecretKey(),
    pubkey = getPublicKey(key),
    saved = [];
  const native = finalizeEvent({ kind: 1, created_at: 2, content: 'Native note', tags: [] }, key);
  relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(relay, 'listening');
  const url = 'ws://127.0.0.1:' + relay.address().port;
  relay.on('connection', (ws) =>
    ws.on('message', (frame) => {
      const [type, id, filter] = JSON.parse(frame);
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
  const go = (url) => http('POST', path + '/url', { url });
  const js = (script, ...args) => http('POST', path + '/execute/sync', { script, args });
  async function waitFor(fn, label) {
    for (let i = 0; i < 120; i++) {
      if (await fn()) return;
      await delay(250);
    }
    throw Error('Timed out waiting for ' + label);
  }
  await go(options);
  await waitFor(
    () => js("return !!document.querySelector('#lockState')?.textContent"),
    'options page ready',
  );
  await js(
    "const [pk,u]=arguments; document.querySelector('#pubkey').value=pk;document.querySelector('#handle').value='alice';document.querySelector('#relays').value=u;document.querySelector('#capture').checked=true;document.querySelector('#relaySync').checked=true;document.querySelector('#settings').requestSubmit()",
    pubkey,
    url,
  );
  await waitFor(
    () => js("return document.querySelector('#notice').textContent==='Settings saved.'"),
    'settings save',
  );
  await js(
    "document.querySelector('#secret').value=arguments[0];document.querySelector('#unlock').requestSubmit()",
    nsecEncode(key),
  );
  await waitFor(() => js("return !document.querySelector('#lock').hidden"), 'signer unlock');
  await go('https://x.com/alice');
  await waitFor(() => saved.length === 1, 'published X event');
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
