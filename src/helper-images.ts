import { BLOB_MAX_BYTES, HashTree, LinkType, sha256, toHex, type CID } from '@hashtree/core';
import { HASHTREE_ROOT_KINDS, parseHashtreeRootEvent } from '@hashtree/nostr';
import { parseBlossomURI } from 'nostr-tools/nipb7';
import { verifyEvent, type Event } from 'nostr-tools/pure';
import { readOnlyStore } from './blocks.ts';
import { openArchive, readPointer } from './archive.ts';
import { imageCache } from './helper-cache.ts';
import { treeAddress } from './helper-links.ts';
import { shareableMediaHashes } from './legacy-x.ts';
import { accountFetch, download, openMediaBlocks, readMediaFile } from './media-files.ts';
import { blossomHash, blossomOrigin, httpsURL, isLoopback, mediaServers } from './media-refs.ts';
import { pool } from './relays.ts';
import type { Settings } from './types.ts';

// Chrome serializes extension messages as JSON. Allow room for base64 and simultaneous images.
export const IMAGE_LIMIT = 8 * 1048576;
const cache = imageCache();

function imageAddress(value: string) {
  if (typeof value !== 'string' || value.length > 4096) throw Error('Invalid image address.');
  if (/^htree:\/\//i.test(value)) return treeAddress(value);
  // Also accept the commonly used // spelling and a bare digest.
  const blossom = /^blossom:(?:\/\/)?([a-f0-9]{64})(\.[a-z0-9]+)?(\?[^#]*)?(?:#.*)?$/i.exec(value);
  if (blossom) {
    const [, digest, ext = '.bin', query = ''] = blossom;
    return { hash: parseBlossomURI('blossom:' + digest.toLowerCase() + ext + query).sha256 };
  }
  const url = httpsURL(value);
  const hash = url && blossomHash(url);
  if (!hash) throw Error('Expected a hash-addressed image.');
  return { hash };
}

function publicRoot(event: Event, pubkey: string, name: string) {
  if (event.pubkey !== pubkey || !verifyEvent(event)) return;
  const pointer = parseHashtreeRootEvent(event);
  if (pointer?.treeName === name && pointer.visibility === 'public') return pointer.rootCid;
}

async function lookupRoot(pubkey: string, name: string, relays: string[]): Promise<CID> {
  if (!relays.length) throw Error('No relays configured.');
  let sub: ReturnType<typeof pool.subscribe> | undefined;
  const controller = new AbortController();
  try {
    return await new Promise<CID>((resolve, reject) => {
      const miss = () => reject(Error('Public tree pointer unavailable.'));
      const timeout = setTimeout(miss, 5000);
      controller.signal.addEventListener('abort', () => clearTimeout(timeout), { once: true });
      sub = pool.subscribe(relays, { authors: [pubkey], kinds: [...HASHTREE_ROOT_KINDS], '#d': [name], limit: 1 }, {
        onevent(event) {
          const cid = publicRoot(event, pubkey, name);
          if (cid) resolve(cid);
        },
        oneose: miss, onclose: miss, maxWait: 4500, abort: controller.signal,
      });
    });
  } finally {
    controller.abort();
    sub?.close();
  }
}

interface ImageSources {
  cache: Pick<ReturnType<typeof imageCache>, 'get' | 'put'>;
  fetcher: typeof fetch;
  lookupRoot: typeof lookupRoot;
}

export async function resolveImage(value: string, conf: Settings, sources: ImageSources = { cache, fetcher: fetch, lookupRoot }) {
  const address = imageAddress(value);
  const maxBytes = Math.min(IMAGE_LIMIT, (conf.mediaMiB ?? 64) * 1048576);
  const servers = [...new Set(mediaServers(conf).map(blossomOrigin))];
  const deadline = AbortSignal.timeout(30000);
  const fetchUntilDeadline = accountFetch(deadline, sources.fetcher);
  const db = conf.pubkey ? await openArchive(conf.archiveName) : undefined;

  // Even a page that knows a private attachment digest may only read archived public media.
  async function savedImage(hash: string, key?: Uint8Array) {
    if (!db) return;
    const file = key ? await db.getFromIndex('mediaFiles', 'rootHash', hash) : await db.get('mediaFiles', hash);
    if (!file || file.size > maxBytes || (key && file.cid.key !== toHex(key))) return;
    const refs = await db.getAllFromIndex('mediaRefs', 'sha256', file.sha256);
    if (!(await shareableMediaHashes(db, refs)).has(file.sha256)) return;
    const blocks = openMediaBlocks(db);
    try { return await readMediaFile(blocks, file); }
    catch { return; } // A missing archive block can still have a verified remote copy.
    finally { blocks.close(); }
  }

  let reads = 0, charged = 0;
  async function block(hash: string, limit: number): Promise<Uint8Array> {
    deadline.throwIfAborted();
    if (++reads > 1024 || charged > maxBytes * 3 + BLOB_MAX_BYTES) throw Error('Image tree is too large.');
    const cached = await sources.cache.get(hash).catch(() => undefined);
    if (cached && cached.length <= limit && toHex(await sha256(cached)) === hash) {
      charged += cached.length;
      return cached;
    }
    for (const server of servers) {
      deadline.throwIfAborted();
      try {
        const request: typeof fetch = (url, options) => fetchUntilDeadline(url, {
          ...options, redirect: 'error', signal: AbortSignal.timeout(isLoopback(new URL(server)) ? 12000 : 5000),
        });
        const { bytes } = await download(server + '/' + hash, hash, limit, request);
        charged += bytes.length;
        await sources.cache.put(hash, bytes).catch(() => {});
        return bytes;
      } catch { /* Try the next configured source, including after an integrity failure. */ }
    }
    throw Error('Verified image data unavailable.');
  }

  try {
    if ('hash' in address)
      return await savedImage(address.hash) ?? await block(address.hash, maxBytes);
    const { root, path } = address;
    let cid: CID;
    if ('cid' in root) cid = root.cid;
    else {
      const local = db && root.pubkey === conf.pubkey ? await readPointer(db) : undefined;
      cid = (local && publicRoot(local.event, root.pubkey, root.name)) ??
        await sources.lookupRoot(root.pubkey, root.name, conf.relays);
    }
    const saved = (!path.length || (path.length === 1 && 'cid' in root)) && await savedImage(toHex(cid.hash), cid.key);
    if (saved) return saved;
    const tree = new HashTree({ store: readOnlyStore(hash => block(toHex(hash), BLOB_MAX_BYTES)) });
    const node = await tree.getTreeNode(cid);
    if (node?.type === LinkType.Dir || node?.type === LinkType.Fanout) {
      if (!path.length) throw Error('Expected an image file.');
      const entry = await tree.resolvePath(cid, path, deadline);
      if (!entry || (entry.type !== LinkType.File && entry.type !== LinkType.Blob)) throw Error('Image file unavailable.');
      cid = entry.cid;
      const file = await savedImage(toHex(cid.hash), cid.key);
      if (file) return file;
    } else if (path.length > 1 || (path.length && !('cid' in root))) throw Error('Invalid image path.');
    // A single segment on an immutable file root is a filename hint.
    const bytes = await tree.readFile(cid, { maxBytes });
    if (!bytes) throw Error('Image file unavailable.');
    return bytes;
  } finally {
    db?.close();
  }
}

// Only send recognized image formats back to the page. A server's Content-Type is untrusted.
export function imageDataURL(bytes: Uint8Array) {
  const head = String.fromCharCode(...bytes.subarray(0, 32));
  let mime: string;
  if (head.startsWith('\x89PNG\r\n\x1a\n')) mime = 'image/png';
  else if (head.startsWith('\xff\xd8\xff')) mime = 'image/jpeg';
  else if (/^GIF8[79]a/.test(head)) mime = 'image/gif';
  else if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') mime = 'image/webp';
  else if (head.slice(4, 8) === 'ftyp' && /avif|avis/.test(head.slice(8))) mime = 'image/avif';
  else if (head.startsWith('BM')) mime = 'image/bmp';
  else if (head.startsWith('\x00\x00\x01\x00')) mime = 'image/x-icon';
  else if (/^\s*(?:<\?xml\b[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(
    new TextDecoder().decode(bytes.subarray(0, 4096)))) mime = 'image/svg+xml';
  else throw Error('Unsupported image format.');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return 'data:' + mime + ';base64,' + btoa(binary);
}
