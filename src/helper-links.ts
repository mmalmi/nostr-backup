import { nhashDecode, objectKeyFromHex, type CID } from '@hashtree/core';
import { decode as nip19Decode } from 'nostr-tools/nip19';

interface TreeAddress {
  root: { cid: CID } | { pubkey: string; name: string };
  path: string[];
}

export function treeAddress(value: string): TreeAddress {
  if (value.length > 4096) throw Error('Hashtree address is too long.');
  // Validate the original path before any URL normalization can remove dot segments.
  const match = /^htree:\/\/([a-z0-9]+)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/i.exec(value);
  if (!match) throw Error('Invalid Hashtree address.');
  const [, head, pathname = '', search = ''] = match;
  const segments = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (segments.length > 64 || segments.some(s => /[\\\x00-\x1f\x7f]/.test(s) || s === '.' || s === '..'))
    throw Error('Invalid Hashtree path.');
  let root: TreeAddress['root'];
  if (head.startsWith('nhash1')) {
    const cid = nhashDecode(head);
    const key = new URLSearchParams(search).get('k');
    if (!cid.key && key !== null) cid.key = objectKeyFromHex(key);
    root = { cid };
  } else {
    const owner = nip19Decode(head);
    const name = segments.shift();
    if (owner.type !== 'npub' || !name || name.split('/').some(s => !s || s === '.' || s === '..'))
      throw Error('Expected a publisher and tree name.');
    root = { pubkey: owner.data, name };
  }
  if (segments.some(s => s.includes('/'))) throw Error('Invalid file path.');
  return { root, path: segments };
}
