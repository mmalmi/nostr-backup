import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
// Rasters of ui/icon.svg: resvg -w SIZE ui/icon.svg ui/icon-SIZE.png
const icons = { 16: 'icon-16.png', 32: 'icon-32.png', 48: 'icon-48.png', 128: 'icon-128.png' };
const common = {
  manifest_version: 3,
  name: 'Nostr Backup',
  version: pkg.version,
  description: 'Archive your X and Nostr posts locally, publish to your relays, and export a ZIP.',
  permissions: ['storage', 'alarms', 'scripting', 'activeTab', 'unlimitedStorage'],
  host_permissions: ['https://x.com/*'],
  optional_host_permissions: ['https://*/*'],
  icons,
  action: { default_title: 'Nostr Backup', default_icon: icons },
  options_ui: { page: 'archive.html', open_in_tab: true },
  content_scripts: [{ matches: ['https://x.com/*'], js: ['content.js'], run_at: 'document_idle' }],
};
const bundles = await build({
  entryPoints: [
    'src/background.ts',
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
});
for (const target of ['chrome', 'firefox', 'safari']) {
  const dir = 'dist/' + target;
  await mkdir(dir, { recursive: true });
  await cp('ui', dir, { recursive: true });
  const manifest = {
    ...common,
    background:
      target === 'chrome' ? { service_worker: 'background.js' } : { scripts: ['background.js'] },
    ...(target === 'firefox' && {
      // Firefox otherwise upgrades even loopback ws: relays to wss:.
      // Keep scripts local and allow plaintext connections only on loopback.
      content_security_policy: {
        extension_pages:
          "script-src 'self'; object-src 'self'; connect-src 'self' https: wss: ws://localhost:* ws://127.0.0.1:* ws://[::1]:*",
      },
      browser_specific_settings: {
        gecko: {
          id: 'nostr-backup@extensions.local',
          strict_min_version: '140.0',
          data_collection_permissions: {
            required: ['websiteContent', 'personallyIdentifyingInfo'],
          },
        },
      },
    }),
  };
  await writeFile(dir + '/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  for (const file of bundles.outputFiles)
    await writeFile(dir + '/' + file.path.split('/').pop(), file.contents);
  const files: Record<string, Uint8Array> = {};
  for (const name of (await readdir(dir)).sort())
    files[name] = new Uint8Array(await readFile(dir + '/' + name));
  await writeFile(
    'dist/nostr-backup-' + target + '.zip',
    zipSync(files, { level: 6, mtime: new Date(1980, 0, 1) }),
  );
  console.log('Built ' + dir);
}
