import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
const {
  outputFiles: [bundle],
} = await build({
  entryPoints: ['test/browser-check.js'],
  bundle: true,
  write: false,
  format: 'iife',
  minify: true,
});
await mkdir('build', { recursive: true });
await writeFile(
  'build/browser-check.html',
  '<!DOCTYPE html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'"><title>Nostr Backup browser check</title><style>body{font:18px/1.6 system-ui;max-width:45em;margin:4em auto;padding:1em;color:#193d30}output{font-weight:700}</style><h1>Nostr Backup browser check</h1><ol></ol><output>Running…</output><script>' +
    bundle.text.replaceAll('</script', '<\\/script') +
    '</script></html>',
);
