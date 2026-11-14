// Known-follower counts for the popup's Nostr card, from the nostr-social-graph snapshot that
// src/x-graph-seed.json comes from. A count is how many of the people whose follow lists the
// snapshot holds follow a key. A single known follower says little, so those keys are left out,
// which halves the table.
// node scripts/graph-followers.ts <nostr-social-graph ES module> <socialGraph.bin>
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SNAPSHOT = 'df349a23122993183b9b9d2d056b7c655a984bdc86bc72f747202ad772de4d8f';
const ROOT = '336f319763657d6b0e65a5b5876719e8c8dcdcf9396852be71ee26b73368b29b';
const [module, path] = process.argv.slice(2);
if (!module || !path) throw Error('Usage: node scripts/graph-followers.ts <nostr-social-graph module> <socialGraph.bin>');
const data = await readFile(path);
if (createHash('sha256').update(data).digest('hex') !== SNAPSHOT) throw Error('Unexpected graph snapshot.');
const { SocialGraph } = await import(pathToFileURL(resolve(module)).href);
const graph = await SocialGraph.fromBinary(ROOT, new Uint8Array(data));
// 80-bit prefixes are too long to grind a lookalike key. Mistyped follows of a real key can share
// one, and only real keys can prove an X account, so a shared prefix keeps the larger count.
const counts = new Map<string, number>();
for (const key of graph.userIterator() as Iterable<string>) {
  const count = graph.followerCount(key) as number, prefix = key.slice(0, 20);
  if (count > (counts.get(prefix) ?? 0)) counts.set(prefix, count);
}
const rows = [...counts].filter(([, count]) => count > 1).sort(([a], [b]) => (a < b ? -1 : 1));
// 12-byte rows sorted by key: the key's first 10 bytes, then the count as a big-endian uint16.
const table = Buffer.alloc(rows.length * 12);
rows.forEach(([prefix, count], i) => {
  table.write(prefix, i * 12, 'hex');
  table.writeUInt16BE(Math.min(count, 0xffff), i * 12 + 10);
});
await writeFile('ui/graph-followers.bin', table);
console.log(rows.length + ' keys, ' + table.length + ' bytes');
