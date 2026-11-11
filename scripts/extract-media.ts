import type { MediaFile } from '../src/types.ts';
// Restore ordinary files using only an exported ZIP (no extension or relay).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { getExtension } from 'nostr-tools/nipb7';
import { readMediaFile } from '../src/media-files.ts';
import { hex } from '../src/model.ts';

const [archive, directory] = process.argv.slice(2);
if (!archive || !directory)
  throw Error(
    'Usage: node --experimental-strip-types scripts/extract-media.ts archive.zip output-directory',
  );
const zip = unzipSync(await readFile(archive), {
  filter: (f) => f.name === 'media.json' || f.name.startsWith('blocks/'),
});
if (!zip['media.json']) throw Error('This ZIP predates media backups.');
const { files }: { files: MediaFile[] } = JSON.parse(strFromU8(zip['media.json']));
const store = { get: async (hash: Uint8Array) => zip['blocks/' + hex(hash)] ?? null };
await mkdir(directory, { recursive: true });
for (const file of files) {
  const bytes = await readMediaFile(store, file);
  const name = file.sha256 + (getExtension(file.mime) || '.bin');
  await writeFile(join(directory, name), bytes);
}
console.log('Restored ' + files.length + ' verified media files.');
