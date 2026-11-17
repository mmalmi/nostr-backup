import { spawnSync } from 'node:child_process';

// Release checks must exercise the wallet against a real, disposable CDK fakewallet mint.
// Never silently turn an unavailable integration fixture into a successful release gate.
const fixture = process.env.SOCIAL_BACKUP_FAKE_MINT;
try {
  if (!fixture) throw Error('Set SOCIAL_BACKUP_FAKE_MINT to a running local CDK fakewallet mint. See README.md.');
  const endpoint = new URL(fixture);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || endpoint.pathname !== '/')
    throw Error('SOCIAL_BACKUP_FAKE_MINT must be a disposable http://127.0.0.1:PORT mint.');
  const response = await fetch(new URL('/v1/info', endpoint), { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw Error('The fake mint is not ready: HTTP ' + response.status);
  await response.json();
} catch (error) {
  console.error('Release tests cannot run:', (error as Error).message);
  process.exit(1);
}
for (const command of ['typecheck', 'test']) {
  const result = spawnSync('pnpm', [command], {
    stdio: 'inherit',
    env: { ...process.env, SOCIAL_BACKUP_RELEASE_TESTS: '1' },
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
