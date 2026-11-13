// Disposable browser preview: the production UI and background run against local fixtures.
// Build first, then run with Node. Nothing is sent to public relays.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { npubEncode, nsecEncode } from 'nostr-tools/nip19';

const secret = generateSecretKey(),
  pubkey = getPublicKey(secret);
const events = [
  finalizeEvent(
    {
      kind: 0,
      created_at: 1,
      tags: [],
      content: JSON.stringify({
        name: 'Preview User',
        picture: 'https://preview.invalid/avatar.svg',
      }),
    },
    secret,
  ),
];
for (let n = 0; n < 80; n++)
  events.push(
    finalizeEvent(
      {
        kind: 1,
        created_at: n + 2,
        tags: [],
        content: 'Local preview note ' + n,
      },
      secret,
    ),
  );

const bridge = `
const worker=new SharedWorker('/worker.js'),port=worker.port;let seq=0;const pending=new Map(),listeners=[];
window.chrome={runtime:{sendMessage(message){const id=++seq;return new Promise(resolve=>{pending.set(id,resolve);port.postMessage({id,message,page:location.pathname})})},openOptionsPage:async()=>{location.href='/archive.html'}},tabs:{query:async()=>[{id:1,url:'https://x.com/alice'}]},storage:{onChanged:{addListener(fn){listeners.push(fn)}}}};
port.onmessage=({data})=>{if(data.id){if(data.reply?.value?.profile?.picture)data.reply.value.profile.picture='/icon.svg';pending.get(data.id)?.(data.reply);pending.delete(data.id)}else if(data.changes){listeners.forEach(fn=>fn(data.changes,'local'))}};
port.start();`;
const worker = `
const handlers=[],listeners=[],ports=new Set(),queued=[];const listener=()=>({addListener(){}});
const dispatch=(port,data)=>handlers[0](data.message,{id:'preview',url:data.message.type==='capture'?'https://x.com/alice':location.origin+data.page,frameId:0,tab:data.message.type==='capture'?{id:1,url:'https://x.com/alice'}:undefined},reply=>port.postMessage({id:data.id,reply}));
const area=(local=false)=>{const state={};return {async get(key){return {[key]:state[key]}},async set(values){const changes=Object.fromEntries(Object.entries(values).map(([k,v])=>[k,{newValue:v}]));Object.assign(state,values);if(local){listeners.forEach(fn=>fn(changes,'local'));ports.forEach(port=>port.postMessage({changes}))}},async remove(key){delete state[key]},async clear(){Object.keys(state).forEach(k=>delete state[k])}}};
self.chrome={tabs:{onRemoved:listener()},windows:{onRemoved:listener()},runtime:{id:'preview',getURL:p=>location.origin+'/'+p,onMessage:{addListener:f=>{handlers.push(f);queued.splice(0).forEach(([p,d])=>dispatch(p,d))}},onInstalled:listener(),onStartup:listener(),openOptionsPage:async()=>{}},storage:{local:area(true),session:area(),onChanged:{addListener:f=>listeners.push(f)}},action:{onClicked:listener(),setPopup:async()=>{}},alarms:{get:async()=>true,create:async()=>{},onAlarm:listener()}};
const originalFetch=self.fetch.bind(self);self.fetch=(input,options)=>{
  const u=new URL(input,location);if(u.origin!=='https://publish.x.com')return originalFetch(input,options);
  const url=u.searchParams.get('url')||'',id=Number(url.split('/').pop());
  return Promise.resolve(Response.json({type:'rich',url,author_url:'https://x.com/alice',html:'<blockquote class="twitter-tweet"><p>Local X capture '+(id-1000)+'</p></blockquote>'}));
};
const NativeWebSocket=WebSocket;self.WebSocket=class extends NativeWebSocket{constructor(url){super('ws://'+location.host+'/relay?source='+encodeURIComponent(url))}};
onconnect=({ports:[port]})=>{ports.add(port);port.onmessage=({data})=>handlers.length?dispatch(port,data):queued.push([port,data]);port.start()};
importScripts('/background.js');`;
const fixtures = `<!doctype html><html><head><meta charset="utf-8"><title>Backup test fixtures</title><script src="/bridge.js"></script></head><body>
<h1>Disposable test account</h1><p>Public key</p><textarea aria-label="Test public key">${npubEncode(pubkey)}</textarea>
<p>Private key</p><textarea aria-label="Test private key">${nsecEncode(secret)}</textarea>
<p><a href="/archive.html">Backup preview</a> · <a href="/popup.html">X toolbar popup</a></p>
<button id="capture">Capture 12 test X posts</button><p id="result"></p>
<script>document.querySelector('#capture').onclick=async()=>{const posts=Array.from({length:12},(_,i)=>({author:'alice',id:String(1000+i),time:1700000000,text:'Local X capture '+i}));const result=await chrome.runtime.sendMessage({type:'capture',posts});document.querySelector('#result').textContent=result.ok?'Captured 12 test posts':result.error;}</script></body></html>`;
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url!, 'http://localhost').pathname;
    res.setHeader('Cache-Control', 'no-store');
    if (path === '/bridge.js' || path === '/worker.js') {
      res.setHeader('Content-Type', 'text/javascript');
      return res.end(path === '/bridge.js' ? bridge : worker);
    }
    if (path === '/fixtures') {
      res.setHeader('Content-Type', 'text/html');
      return res.end(fixtures);
    }
    const file = path === '/' ? 'archive.html' : path.slice(1);
    if (!/^[a-z0-9.-]+$/.test(file)) {
      res.writeHead(404).end();
      return;
    }
    let data = await readFile('dist/chrome/' + file);
    if (file.endsWith('.html'))
      data = Buffer.from(
        data
          .toString()
          .replace('<script defer', '<script src="bridge.js"></script><script defer'),
      );
    res.setHeader(
      'Content-Type',
      file.endsWith('.html')
        ? 'text/html'
        : file.endsWith('.js')
          ? 'text/javascript'
          : file.endsWith('.css')
            ? 'text/css'
            : 'image/svg+xml',
    );
    res.end(data);
  } catch {
    res.writeHead(404).end();
  }
});
const relays = new WebSocketServer({ server });
relays.on('connection', (socket, request) => {
  const source = new URL(request.url!, 'http://localhost').searchParams.get('source') ?? '';
  socket.on('message', (raw) => {
    const [type, id, filter] = JSON.parse(raw.toString());
    if (type === 'NEG-OPEN') socket.send(JSON.stringify(['NEG-ERR', id, 'unsupported']));
    if (type === 'REQ') {
      for (const event of events)
        if (
          filter.authors?.includes(event.pubkey) &&
          (!filter.kinds || filter.kinds.includes(event.kind)) &&
          event.created_at <= (filter.until ?? Infinity) &&
          event.created_at >= (filter.since ?? 0)
        )
          socket.send(JSON.stringify(['EVENT', id, event]));
      socket.send(JSON.stringify(['EOSE', id]));
    }
    if (type === 'EVENT')
      setTimeout(
        () => {
          if (socket.readyState === 1)
            socket.send(JSON.stringify(['OK', id.id, true, 'stored locally']));
        },
        source.includes('ditto') ? 350 : 120,
      );
  });
});
server.listen(49188, '127.0.0.1', () =>
  console.log('Preview: http://127.0.0.1:49188/fixtures'),
);
