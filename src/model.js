import { getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { decode } from 'nostr-tools/nip19';

export const POST_KINDS = [1, 6, 16, 20, 1111, 30023];
export const handlePattern = /^[a-z0-9_]{1,15}$/i;
export const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
export const unhex = (value) => Uint8Array.from(value.match(/../g), (b) => parseInt(b, 16));

export function identity(value) {
  value = value.trim();
  if (/^[a-f0-9]{64}$/.test(value)) return value;
  const key = decode(value);
  if (key.type !== 'npub') throw Error('Enter an npub or a hex public key.');
  return key.data;
}

export function secretKey(value) {
  const key = decode(value.trim());
  if (key.type !== 'nsec') throw Error('Enter a Nostr secret key beginning with nsec1.');
  getPublicKey(key.data);
  return key.data;
}

export function relayList(input) {
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

export function isOwnPost(event, pubkey) {
  try {
    return (
      event.pubkey === pubkey &&
      POST_KINDS.includes(event.kind) &&
      Number.isSafeInteger(event.created_at) &&
      event.created_at >= 0 &&
      verifyEvent(event)
    );
  } catch {
    return false;
  }
}

export function xTemplate(post, handle) {
  if (
    !handlePattern.test(handle) ||
    post.author !== handle ||
    !/^\d{1,20}$/.test(post.id) ||
    !Number.isSafeInteger(post.time) ||
    post.time < 1 ||
    post.time > Date.now() / 1000 + 300 ||
    typeof post.text !== 'string' ||
    !post.text.trim() ||
    post.text.length > 120000
  )
    throw Error('Invalid X post.');
  const url = 'https://x.com/' + handle + '/status/' + post.id;
  const tags = [
    ['r', url],
    ['i', url],
    ['k', 'web'],
  ];
  // Modern X IDs encode milliseconds above their low 22 worker/sequence bits.
  // Cross-check with the independent DOM date before using that precision.
  const idMillis = Number((BigInt(post.id) >> 22n) + 1288834974657n);
  const ms = post.timeMs ?? idMillis;
  if (Number.isSafeInteger(ms) && Math.floor(ms / 1000) === post.time)
    tags.push(['ms', String(ms)]);
  return { kind: 1, created_at: post.time, content: post.text, tags };
}
