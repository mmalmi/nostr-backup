import { finalizeEvent } from 'nostr-tools/pure';
import { createUploadAuth } from 'nostr-tools/nipb7';
import { sha256 } from '@hashtree/core';
import type { NewProfile } from './types.ts';
import { putBlossom } from './media-files.ts';
import { hex } from './model.ts';

const MAX_BYTES = 8 * 1048576;

/** Instagram and Facebook picture links are signed and expire, so only a copy can stay in a profile. */
export function expiringImage(value: string) {
  try {
    return /(^|\.)(cdninstagram\.com|fbcdn\.net)$/.test(new URL(value).hostname);
  } catch {
    return false;
  }
}

function imageType(bytes: Uint8Array) {
  const head = String.fromCharCode(...bytes.subarray(0, 12));
  if (head.startsWith('\xff\xd8\xff')) return 'image/jpeg';
  if (head.startsWith('\x89PNG\r\n\x1a\n')) return 'image/png';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  if (/^GIF8[79]a/.test(head)) return 'image/gif';
}

async function copyImage(value: string, key: Uint8Array, server: string, fetcher: typeof fetch) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw Error('Unsupported image address.');
  const response = await fetcher(url.href, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok || Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) throw Error('Image unavailable.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  const mime = bytes.byteLength <= MAX_BYTES && imageType(bytes);
  if (!mime) throw Error('Unsupported image.');
  const hash = hex(await sha256(bytes));
  const auth = await createUploadAuth(async (event) => finalizeEvent(event, key), hash, {
    servers: server,
    expiration: Math.floor(Date.now() / 1000) + 300,
  });
  return putBlossom(server, hash, bytes, mime, auth, fetcher);
}

/**
 * The profile with its own copies of its picture and banner on a Blossom server, so they outlast
 * the account they came from. A failed copy keeps a lasting link and drops an expiring one.
 */
export async function withCopiedImages(profile: NewProfile, key: Uint8Array, server: string, fetcher: typeof fetch = fetch) {
  const next = { ...profile };
  await Promise.all(
    (['picture', 'banner'] as const).map(async (field) => {
      const value = next[field];
      if (!value) return;
      try {
        next[field] = await copyImage(value, key, server, fetcher);
      } catch {
        if (expiringImage(value)) delete next[field];
      }
    }),
  );
  return next;
}
