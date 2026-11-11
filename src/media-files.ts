import type { Archive, MediaReference, MediaFile } from './types.ts';
import { errorMessage } from './types.ts';
import type { Event } from 'nostr-tools/pure';
import type { Store } from '@hashtree/core';
import { readOnlyStore } from './blocks.ts';
import { HashTree, sha256 } from '@hashtree/core';
import { DexieStore } from '@hashtree/dexie';
import { encodeAuthorizationHeader } from 'nostr-tools/nipb7';
import { hex, unhex } from './model.ts';
import { blossomHash, httpsURL } from './media-refs.ts';

type Progress = (done: number, total: number) => void;
interface DownloadOptions {
  server?: string;
  maxBytes: number;
  fetcher: typeof fetch;
  resolveServers: () => Promise<string[]>;
  signal?: AbortSignal;
}
interface BackupOptions extends Partial<Omit<DownloadOptions, 'maxBytes'>> {
  maxMiB?: number;
  progress?: Progress;
}

export const openMediaBlocks = (db: Pick<Archive, 'name'>) => new DexieStore(db.name + '-media');
export const DEFAULT_MEDIA_MIB = 64;

// Keep the request timeout and the account's cancellation signal active through the response body.
export function accountFetch(signal: AbortSignal): typeof fetch {
  return (url, options) => {
    const timeout = options?.signal;
    if (!timeout) return fetch(url, { ...options, signal });
    if (AbortSignal.any)
      return fetch(url, { ...options, signal: AbortSignal.any([signal, timeout]) });
    signal.throwIfAborted();
    timeout.throwIfAborted();
    const controller = new AbortController();
    for (const source of [signal, timeout])
      source.addEventListener('abort', () => controller.abort(source.reason), {
        once: true,
        signal: controller.signal,
      });
    return fetch(url, { ...options, signal: controller.signal });
  };
}

async function download(
  url: string,
  expected: string | undefined,
  maxBytes: number,
  fetcher: typeof fetch,
  retryHash?: boolean,
) {
  const response = await fetcher(url, {
    cache: retryHash ? 'reload' : expected ? 'force-cache' : 'default',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(90000),
  });
  const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  const reader = response.body?.getReader();
  if (!reader) throw Error('Empty response.');
  try {
    if (!response.ok || response.status === 206) throw Error('HTTP ' + response.status);
    if (!expected && /^(text\/html|application\/xhtml\+xml)$/.test(mime ?? ''))
      throw Error('Source returned a web page.');
    const limitMessage = 'Exceeds the ' + maxBytes / 1048576 + ' MiB file limit.';
    if (Number(response.headers.get('content-length')) > maxBytes) throw Error(limitMessage);
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw Error(limitMessage);
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const hash = hex(await sha256(bytes));
    if (expected && hash !== expected) throw Error('SHA-256 mismatch.');
    return { bytes, hash, mime };
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function fetchAttachment(
  ref: MediaReference,
  { server, resolveServers, maxBytes, fetcher, signal }: DownloadOptions,
) {
  const tried = new Set();
  let failure = 'No download location for this hash.';
  async function trySources(urls: string[]) {
    for (const url of urls) {
      const source = httpsURL(url);
      if (!source || tried.has(url)) continue;
      tried.add(url);
      try {
        return await download(
          url,
          ref.expected || blossomHash(source),
          maxBytes,
          fetcher,
          ref.error?.includes('SHA-256 mismatch'),
        );
      } catch (error) {
        signal?.throwIfAborted();
        failure = new URL(url).host + ' — ' + errorMessage(error);
      }
    }
  }
  const hashed = (servers: (string | undefined)[]) =>
    servers.filter(Boolean).map((s) => new URL('/' + ref.expected, s).href);
  const direct = await trySources([
    ref.url,
    ...ref.fallbacks,
    ...(ref.expected ? hashed([...ref.servers, server]) : []),
  ]);
  if (direct) return direct;
  if (ref.expected) {
    const mirrored = await trySources(hashed(await resolveServers()));
    if (mirrored) return mirrored;
  }
  throw Error(failure);
}

async function saveReference(
  db: Archive,
  blocks: DexieStore,
  ref: MediaReference,
  options: DownloadOptions,
) {
  if (ref.invalidHash) throw Error('Conflicting or invalid SHA-256 metadata.');
  let hash = ref.expected;
  if (!hash) {
    const matches = await db.getAllFromIndex('mediaRefs', 'url', ref.url);
    hash = matches.find((row) => row.sha256)?.sha256;
  }
  let file = hash && (await db.get('mediaFiles', hash));
  if (!file) {
    const result = await fetchAttachment(ref, options);
    hash = result.hash;
    file = await db.get('mediaFiles', hash);
    if (!file) {
      const keys = new Set<string>();
      // DexieStore returns false on a failed write. Commit the CID only after
      // every immutable block is durable. Interrupted writes are safe to repeat.
      const tree = new HashTree({
        store: {
          get: (key) => blocks.get(key),
          has: (key) => blocks.has(key),
          delete: (key) => blocks.delete(key),
          async put(key, bytes) {
            if (!(await blocks.has(key)) && !(await blocks.put(key, bytes)))
              throw Error('Could not write the media block to IndexedDB.');
            keys.add(hex(key));
            return true;
          },
        },
      });
      const { cid, size } = await tree.putFile(result.bytes);
      file = {
        sha256: hash,
        size,
        mime: result.mime || ref.mime || 'application/octet-stream',
        cid: { hash: hex(cid.hash), key: hex(cid.key!) },
        blocks: [...keys],
        copies: [],
      };
    }
  }
  if (!hash) throw Error('Missing media digest.');
  const tx = db.transaction(['mediaFiles', 'mediaRefs'], 'readwrite');
  if (!(await tx.objectStore('mediaFiles').getKey(hash)))
    await tx.objectStore('mediaFiles').add(file);
  await tx
    .objectStore('mediaRefs')
    .put({ ...ref, error: undefined, sha256: hash, status: ref.poster ? 'poster only' : 'saved' });
  await tx.done;
}

export async function backupMedia(
  db: Archive,
  {
    server,
    maxMiB = DEFAULT_MEDIA_MIB,
    resolveServers = async () => [],
    progress = () => {},
    fetcher = fetch,
    signal,
  }: BackupOptions = {},
) {
  const refs = (await db.getAll('mediaRefs')).filter((ref) => !ref.sha256);
  const blocks = openMediaBlocks(db);
  let unavailable = 0,
    done = 0;
  try {
    for (const ref of refs) {
      progress(done, refs.length);
      try {
        await saveReference(db, blocks, ref, {
          server,
          maxBytes: maxMiB * 1048576,
          fetcher,
          resolveServers,
          signal,
        });
      } catch (error) {
        signal?.throwIfAborted();
        await db.put('mediaRefs', { ...ref, status: 'unavailable', error: errorMessage(error) });
        unavailable++;
      }
      done++;
    }
  } finally {
    blocks.close();
  }
  return { saved: done - unavailable, unavailable };
}

export async function readMediaFile(store: Pick<Store, 'get'>, file: MediaFile) {
  const cid = { hash: unhex(file.cid.hash), key: unhex(file.cid.key) };
  const bytes = await new HashTree({ store: readOnlyStore(store.get.bind(store)) }).readFile(cid, {
    maxBytes: file.size,
  });
  if (!bytes || bytes.length !== file.size || hex(await sha256(bytes)) !== file.sha256)
    throw Error('Could not restore media file ' + file.sha256 + '.');
  return bytes;
}

export async function uploadMedia(
  db: Archive,
  server: string,
  authorize: (hash: string, server: string) => Promise<Event>,
  progress: Progress = () => {},
  fetcher = fetch,
) {
  const files = (await db.getAll('mediaFiles')).filter((file) => !file.copies.includes(server));
  const blocks = openMediaBlocks(db);
  let done = 0;
  try {
    for (const file of files) {
      progress(done, files.length);
      const bytes = await readMediaFile(blocks, file);
      const auth = await authorize(file.sha256, server);
      await putBlossom(server, file.sha256, bytes, file.mime, auth, fetcher);
      await db.put('mediaFiles', { ...file, copies: [...file.copies, server] });
      done++;
    }
  } finally {
    blocks.close();
  }
  return done;
}

async function putBlossom(
  server: string,
  hash: string,
  bytes: Uint8Array,
  mime: string,
  auth: Event,
  fetcher = fetch,
) {
  const res = await fetcher(new URL('/upload', server).href, {
    method: 'PUT',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    headers: {
      Authorization: encodeAuthorizationHeader(auth),
      'Content-Type': mime,
      'X-SHA-256': hash,
    },
    body: bytes as Uint8Array<ArrayBuffer>,
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw Error('Blossom upload returned HTTP ' + res.status + '.');
  const descriptor = await res.json();
  const location = httpsURL(descriptor?.url);
  if (
    !location ||
    blossomHash(location) !== hash ||
    descriptor.sha256 !== hash ||
    descriptor.size !== bytes.byteLength
  )
    throw Error('Blossom returned a mismatched file descriptor.');
}
