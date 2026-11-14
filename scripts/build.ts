import { build } from 'esbuild';
import { svelte } from './svelte.ts';
import { captureSites } from '../src/social.ts';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
// Rasters of ui/icon.svg: resvg -w SIZE ui/icon.svg ui/icon-SIZE.png
const icons = { 16: 'icon-16.png', 32: 'icon-32.png', 48: 'icon-48.png', 128: 'icon-128.png' };
const assets = ['archive.html', 'popup.html', 'approve.html', 'style.css', 'icon.svg', 'graph-followers.bin', 'facebook-logo.png', ...Object.values(icons)];
const common = {
  manifest_version: 3,
  name: 'Social Backup',
  version: pkg.version,
  homepage_url: pkg.homepage,
  description: 'Save your posts from X, Facebook, Instagram and Nostr. Download a copy with photos and videos, or share public posts on Nostr.',
  permissions: ['storage', 'alarms', 'scripting', 'unlimitedStorage'],
  host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*', 'http://[::1]/*'],
  icons,
  action: { default_title: 'Social Backup', default_icon: icons },
  options_ui: { page: 'archive.html', open_in_tab: true },
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  },
  content_scripts: [
    { matches: ['https://*/*'], js: ['browser-helper.js'], run_at: 'document_start', all_frames: true },
    { matches: ['https://*/*'], js: ['bridge.js'], run_at: 'document_start' },
    { matches: ['https://*/*'], js: ['provider.js'], world: 'MAIN', run_at: 'document_start' },
    { matches: captureSites, js: ['content.js'], run_at: 'document_idle' }],
};
const bundles = await build({
  entryPoints: [
    'src/browser-helper.ts',
    'src/background.ts',
    'src/provider.ts',
    'src/bridge.ts',
    'src/content.ts',
    'src/archive-ui.ts',
    'src/popup.ts',
    'src/approve.ts',
  ],
  bundle: true,
  format: 'iife',
  target: ['chrome120', 'firefox128', 'safari17'],
  outdir: 'dist',
  write: false,
  minify: true,
  legalComments: 'eof',
  plugins: [svelte],
});
for (const target of ['chrome', 'firefox', 'safari']) {
  const dir = 'dist/' + target;
  await mkdir(dir, { recursive: true });
  const manifest = {
    ...common,
    background:
      target === 'chrome' ? { service_worker: 'background.js' } : { scripts: ['background.js'] },
    ...(target === 'firefox' && {
      // Firefox otherwise upgrades even loopback ws: relays to wss:.
      // Keep scripts local and allow plaintext connections only on loopback.
      content_security_policy: {
        extension_pages:
          common.content_security_policy.extension_pages +
          "; connect-src 'self' https: wss: http://localhost:* http://127.0.0.1:* http://[::1]:* ws://localhost:* ws://127.0.0.1:* ws://[::1]:*",
      },
      browser_specific_settings: {
        gecko_android: { strict_min_version: '142.0' },
        gecko: {
          id: 'nostr-backup@extensions.local',
          strict_min_version: '140.0',
          data_collection_permissions: {
            required: ['websiteContent', 'personallyIdentifyingInfo', 'personalCommunications', 'authenticationInfo', 'browsingActivity'],
            optional: ['financialAndPaymentInfo'],
          },
        },
      },
    }),
  };
  const files: Record<string, Uint8Array> = {
    'LICENSE.txt': await readFile('LICENSE'),
    'manifest.json': new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n'),
  };
  for (const name of assets) files[name] = await readFile('ui/' + name);
  for (const file of bundles.outputFiles)
    files[file.path.split('/').pop()!] = file.contents;
  for (const [name, bytes] of Object.entries(files)) await writeFile(dir + '/' + name, bytes);
  await writeFile(
    'dist/social-backup-' + target + '.zip',
    zipSync(files, { level: 6, mtime: new Date(1980, 0, 1) }),
  );
  console.log('Built ' + dir);
}
