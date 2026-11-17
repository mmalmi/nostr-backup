// The test browser and its background worker must see the same anonymous X pages.
// Its private loopback proxy serves fixtures and refuses external destinations.
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileHTML, publicTweetHTML } from '../test/fixtures.ts';

export async function startBrowserFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'social-backup-test-tls-'));
  const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem');
  let tls;
  try {
    execFileSync('openssl', ['req', '-new', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-subj', '/CN=x.com', '-days', '1', '-keyout', key, '-out', cert], { stdio: 'ignore' });
    tls = httpsServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
      const body = req.url === '/alice/status/123' ? publicTweetHTML('alice', '123', 'Hello\nbackup 🌲', 1704164645) :
        req.url === '/alice' ? profileHTML :
        req.url === '/alice/following' ? '<main data-testid="primaryColumn"><div data-testid="UserCell"><a href="/bob">Bob</a></div></main>' : undefined;
      res.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const proxy = httpServer((_req, res) => { res.writeHead(403); res.end(); });
  proxy.on('connect', (req, socket, head) => {
    if (req.url !== 'x.com:443') return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) socket.unshift(head);
    tls.emit('connection', socket);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const address = proxy.address();
  if (!address || typeof address === 'string') throw Error('Missing test proxy port.');
  return { address: '127.0.0.1:' + address.port, close: () => proxy.close() };
}
