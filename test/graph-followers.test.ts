import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { knownFollowers } from '../src/graph-followers.ts';
import seed from '../src/x-graph-seed.json' with { type: 'json' };

test('known followers come from the graph snapshot table', async () => {
  const table = new Uint8Array(await readFile(new URL('../ui/graph-followers.bin', import.meta.url)));
  assert.equal(table.length % 12, 0);
  // Rows are sorted by key without repeats, so a lookup can binary search.
  for (let row = 12; row < table.length; row += 12)
    assert.ok(Buffer.compare(table.subarray(row - 12, row - 2), table.subarray(row, row + 10)) < 0);
  for (let row = 0; row < table.length; row += 12) assert.ok(((table[row + 10] << 8) | table[row + 11]) > 1);
  // Most people in the directory seed are followed by several people in the snapshot.
  assert.ok(seed.filter((key: string) => knownFollowers(table, key) > 1).length > 300);
  assert.equal(knownFollowers(table, 'f'.repeat(64)), 0);
  assert.equal(knownFollowers(table, 'not a key'), 0);
  // A key that differs from a followed one only after its first 10 bytes shares its count.
  const one = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1, 44]);
  assert.equal(knownFollowers(one, '0102030405060708090a' + '0'.repeat(44)), 300);
  assert.equal(knownFollowers(one, '0102030405060708090b' + '0'.repeat(44)), 0);
});
