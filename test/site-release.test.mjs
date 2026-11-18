import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSiteReleasePlan, runSiteRelease } from '../website/release-site.mjs';

const gatePath = fileURLToPath(import.meta.url);

test('both website release paths retain the wallet gate and website build before native verification', () => {
  for (const deploy of [false, true]) {
    const steps = createSiteReleasePlan({ deploy, gatePath });
    assert.deepEqual(steps.map(step => step.id), deploy ? ['test', 'build', 'publish', 'deploy'] : ['test', 'build', 'publish']);
    assert.deepEqual(steps[0].command, ['pnpm', 'test:release']);
    assert.deepEqual(steps[1].command, ['pnpm', 'run', 'build:site']);
    assert.deepEqual(steps[2].command, [
      process.execPath, gatePath, '--dist', steps[2].cwd,
      '--tree', 'nostr-backup-site', '--htree', process.env.HTREE_BIN || 'htree',
    ]);
  }
});

test('live website release requires the native runner while dry-run remains available', () => {
  assert.throws(() => createSiteReleasePlan({ gatePath: '' }), /IRIS_NATIVE_RELEASE_GATE/);
  assert.equal(createSiteReleasePlan({ dryRun: true, gatePath: '' })[2].command[1], '$IRIS_NATIVE_RELEASE_GATE');
});

test('Cloudflare deploy is blocked if native verification fails or only returns a candidate', async () => {
  const success = { status: 0, stdout: '', stderr: '' };
  for (const rejected of [
    { status: 1, stdout: '', stderr: '' },
    { status: 0, stdout: 'url: nhash1ace\npublished: npub1example/nostr-backup-site-candidate-abcdef123456', stderr: '' },
  ]) {
    const seen = [];
    await assert.rejects(runSiteRelease({ deploy: true, gatePath }, async step => {
      seen.push(step.id);
      return step.id === 'publish' ? rejected : success;
    }));
    assert.deepEqual(seen, ['test', 'build', 'publish']);
  }
});
