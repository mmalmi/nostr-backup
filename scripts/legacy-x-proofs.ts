// Public legacy proof references from nostr.directory; never trusted without a live X check.
// Source: https://storage.googleapis.com/nostrdb-backups/ndjson/2024-08-10.ndjson
// Regenerate: node --experimental-strip-types scripts/legacy-x-proofs.ts <download.ndjson>
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isProofPost } from '../src/x-identity.ts';

const path = process.argv[2];
if (!path) throw Error('Pass the nostr.directory snapshot path.');
const data = await readFile(path);
if (createHash('sha256').update(data).digest('hex') !== 'c07c34c00e9840cee16a92da4233284fed3d830a904be228362168ad2b4558bf')
  throw Error('Unexpected nostr.directory snapshot.');
const rows = new Map<string, [string, string, string]>();
for (const line of data.toString('utf8').split('\n').filter(Boolean)) {
  const { path, data: entry } = JSON.parse(line);
  const handle = String(entry.screenName ?? '').toLowerCase();
  const pubkey = entry.hexPubKey, proof = entry.id_str;
  if (!path.startsWith('twitter/') || entry.isValid !== true || !/^[a-z0-9_]{1,15}$/.test(handle) ||
      typeof pubkey !== 'string' || !/^[a-f0-9]{64}$/.test(pubkey) ||
      typeof proof !== 'string' || !/^\d{1,20}$/.test(proof)) continue;
  const text = entry.extended_tweet?.full_text ?? entry.full_text ?? entry.text;
  if (typeof text !== 'string' || !isProofPost(text, pubkey)) continue;
  rows.set(handle + ':' + proof, [handle, pubkey, proof]);
}
const sorted = [...rows.values()].sort((a, b) => a.join(':') < b.join(':') ? -1 : 1);
await writeFile('src/x-legacy-proofs.json', JSON.stringify(sorted) + '\n');
console.log(sorted.length + ' public proof references');
