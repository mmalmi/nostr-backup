import { fromHex } from '@hashtree/core';
import type { Event, VerifiedEvent } from 'nostr-tools/pure';
import type { Capture, RelayKindFilter } from './types.ts';
import { getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { decode } from 'nostr-tools/nip19';

// Eligible for public sharing. Relay downloads have their own per-account filter.
export const PUBLIC_POST_KINDS = [0, 1, 6, 16, 20, 21, 22, 1063, 1111, 30023];
export const handlePattern = /^[a-z0-9_]{1,15}$/i;
export { toHex as hex, fromHex as unhex } from '@hashtree/core';

export function identity(value: string) {
  value = value.trim();
  if (/^[a-f0-9]{64}$/.test(value)) return value;
  const key = decode(value);
  if (key.type !== 'npub') throw Error('Enter a valid user ID.');
  return key.data;
}

export function secretKey(value: string) {
  try {
    const text = value.trim();
    const decoded = /^[a-f0-9]{64}$/i.test(text)
      ? { type: 'nsec', data: fromHex(text) }
      : decode(text);
    if (decoded.type === 'nsec') {
      getPublicKey(decoded.data);
      return decoded.data;
    }
  } catch {
    /* Never include a private key in a validation message. */
  }
  throw Error('Enter a valid secret key.');
}

export function loginKey(value: string) {
  const key = value.trim();
  try {
    if (/^npub1/i.test(key)) return { type: 'watch' as const, key: identity(key) };
    secretKey(key);
    return { type: 'login' as const, key };
  } catch {
    throw Error('Check your secret key or user ID and try again.');
  }
}

export function relayList(input: string) {
  const urls = input
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => {
      const url = new URL(s);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (
        !(url.protocol === 'wss:' || (local && url.protocol === 'ws:')) ||
        url.username ||
        url.password ||
        url.hash
      )
        throw Error('Use wss:// relay URLs, or ws:// on localhost.');
      return url.href;
    });
  if (urls.length > 12) throw Error('Choose up to 12 relays.');
  return [...new Set(urls)];
}

function validKind(kind: number) {
  return Number.isInteger(kind) && kind >= 0 && kind <= 65535;
}

export function parseRelayKinds(mode: string, list: string): RelayKindFilter | undefined {
  if (mode === 'all') return undefined;
  if (mode !== 'include' && mode !== 'exclude') throw Error('Choose a download filter.');
  const tokens = list.trim().split(/[\s,]+/).filter(Boolean);
  if (!tokens.length || tokens.some(token => !/^\d+$/.test(token) || !validKind(Number(token))))
    throw Error('Enter kind numbers from 0 to 65535, separated by commas or spaces.');
  return { mode, kinds: [...new Set(tokens.map(Number))].sort((a, b) => a - b) };
}

export function relayKindScope(filter?: RelayKindFilter) {
  return filter ? filter.mode + ':' + filter.kinds.join(',') : 'all';
}

export function matchesRelayKind(kind: number, filter?: RelayKindFilter) {
  return !filter || filter.kinds.includes(kind) === (filter.mode === 'include');
}

export function isOwnEvent(event: Event, pubkey: string): event is VerifiedEvent {
  try {
    return (
      event.pubkey === pubkey &&
      validKind(event.kind) &&
      Number.isSafeInteger(event.created_at) &&
      event.created_at >= 0 &&
      verifyEvent(event)
    );
  } catch {
    return false;
  }
}

export function xTemplate(post: Capture, handle: string) {
  if (
    !handlePattern.test(handle) ||
    post.author !== handle ||
    !/^\d{1,20}$/.test(post.id) ||
    !Number.isSafeInteger(post.time) ||
    post.time < 1 ||
    post.time > Date.now() / 1000 + 300 ||
    typeof post.text !== 'string' ||
    !post.text.trim() ||
    (post.posters !== undefined &&
      !(
        Array.isArray(post.posters) &&
        post.posters.every((url) => typeof url === 'string' && post.text.includes(url))
      )) ||
    post.text.length > 120000
  )
    throw Error('Invalid X post.');
  const url = 'https://x.com/' + handle + '/status/' + post.id;
  const tags = [
    ['r', url],
    ['i', url],
    ['k', 'web'],
    ['client', 'Social Backup'],
  ];
  // Modern X IDs encode milliseconds above their low 22 worker/sequence bits.
  // Cross-check with the independent DOM date before using that precision.
  const idMillis = Number((BigInt(post.id) >> 22n) + 1288834974657n);
  const ms = post.timeMs ?? idMillis;
  if (Number.isSafeInteger(ms) && Math.floor(ms / 1000) === post.time)
    tags.push(['ms', String(ms)]);
  return { kind: 1, created_at: post.time, content: post.text, tags };
}
