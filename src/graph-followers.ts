import { hexToBytes } from 'nostr-tools/utils';

const PREFIX = 10, ROW = 12;

/**
 * Known followers of a key in Social Backup's nostr-social-graph snapshot, from ui/graph-followers.bin:
 * 12-byte rows sorted by key, each the key's first 10 bytes and a big-endian uint16 count.
 * Keys outside the snapshot, or with a single known follower there, count as none.
 */
export function knownFollowers(table: Uint8Array, pubkey: string) {
  if (!/^[0-9a-f]{64}$/.test(pubkey)) return 0;
  const prefix = hexToBytes(pubkey.slice(0, PREFIX * 2));
  let low = 0, high = Math.floor(table.length / ROW);
  while (low < high) {
    const middle = (low + high) >> 1, row = middle * ROW;
    let order = 0;
    for (let i = 0; i < PREFIX && !order; i++) order = table[row + i] - prefix[i];
    if (!order) return (table[row + PREFIX] << 8) | table[row + PREFIX + 1];
    if (order < 0) low = middle + 1;
    else high = middle;
  }
  return 0;
}
