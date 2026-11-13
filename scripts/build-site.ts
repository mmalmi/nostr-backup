import { copyFile, cp, mkdir, rm } from 'node:fs/promises';

const output = 'website/dist';
await rm(output, { recursive: true, force: true });
await mkdir(output + '/downloads', { recursive: true });
await cp('website/public', output, { recursive: true });
await copyFile('ui/icon.svg', output + '/icon.svg');
for (const browser of ['chrome', 'firefox', 'safari']) {
  const archive = `social-backup-${browser}.zip`;
  await copyFile('dist/' + archive, output + '/downloads/' + archive);
}
console.log('Built ' + output);
