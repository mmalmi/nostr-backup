import { nhashDecode, nhashEncode, objectKeyFromHex, toHex, type CID } from '@hashtree/core';
import { decode as nip19Decode } from 'nostr-tools/nip19';

export interface TreeAddress {
  root: { cid: CID } | { npub: string; pubkey: string; name: string };
  path: string[];
  trailingSlash: boolean;
  search: string;
  fragment: string;
}

export function treeAddress(value: string): TreeAddress {
  if (value.length > 4096) throw Error('Hashtree address is too long.');
  // URL normalizes dot segments. Inspect the original path before constructing any HTTP URL.
  const match = /^htree:\/\/([a-z0-9]+)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/i.exec(value);
  if (!match) throw Error('Invalid Hashtree address.');
  const [, head, pathname = '', search = '', fragment = ''] = match;
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
    root = { npub: head, pubkey: owner.data, name };
  }
  if (segments.some(s => s.includes('/'))) throw Error('Invalid file path.');
  return { root, path: segments, trailingSlash: pathname.endsWith('/'), search, fragment };
}

// Iris Drive uses RFC 4648 lowercase base32 without padding for immutable site origins.
function siteLabel(hash: Uint8Array) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let label = '', bits = 0, value = 0;
  for (const byte of hash) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      label += alphabet[(value >>> bits) & 31];
    }
  }
  return bits ? label + alphabet[(value << (5 - bits)) & 31] : label;
}

export function irisDriveURL(value: string) {
  const { root, path, search, fragment, trailingSlash } = treeAddress(value);
  let host: string;
  if ('cid' in root) host = siteLabel(root.cid.hash) + '.sites.iris.localhost';
  else if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(root.name))
    host = root.name + '.' + root.npub + '.iris.localhost';
  else {
    host = 'iris.localhost';
    path.unshift(root.npub, root.name);
  }
  const url = new URL('http://' + host + ':17321');
  url.pathname = '/' + path.map(encodeURIComponent).join('/') + (path.length && trailingSlash ? '/' : '');
  url.search = search;
  if ('cid' in root && root.cid.key) url.searchParams.set('k', toHex(root.cid.key));
  url.hash = fragment;
  return url.href;
}

// Iris Drive publishes the Iris Apps catalog under its publisher's "sites" tree.
export const IRIS_APPS_ADDRESS = 'htree://npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/sites/';

export function openSiteURL(input: string, local: boolean) {
  const value = input.trim().replace(/^htree:\/\//i, '');
  const address = 'htree://' + value;
  const { root, path, trailingSlash, search, fragment } = treeAddress(address);
  if (local) {
    const url = new URL(irisDriveURL(address));
    if (url.hostname === 'iris.localhost')
      throw Error('Choose Browser for a site with this tree name.');
    return url.href;
  }
  const params = new URLSearchParams(search);
  // An immutable decryption key goes in the nhash, inside the launcher's fragment.
  if ('cid' in root) params.delete('k');
  if (params.size || fragment)
    throw Error('Open this address with Iris Drive to keep its query or page fragment.');
  if (!path.length || trailingSlash) path.push('index.html');
  const parts = 'cid' in root ? [nhashEncode(root.cid)] : [root.npub, root.name];
  return 'https://apps.iris.to/#/' + [...parts, ...path].map(encodeURIComponent).join('/') + '?htree=1';
}
