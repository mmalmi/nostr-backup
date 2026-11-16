import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { bech32 } from '@scure/base';
import { finalizeEvent } from 'nostr-tools/pure';

/** A signed, description-hash BOLT11 invoice using a test-only payee key. */
export function signedInvoice(sats: number, description: string, time = Math.floor(Date.now() / 1000), plain = false) {
  const prefix = 'lnbc' + Math.round(sats * 10) + 'n';
  const timeWords = Array.from({ length: 7 }, (_, i) => Math.floor(time / 32 ** (6 - i)) % 32);
  const hash = sha256(utf8ToBytes(description));
  const wordTag = (type: number, bytes: Uint8Array) => {
    const words = bech32.toWords(bytes);
    return [type, words.length >> 5, words.length & 31, ...words];
  };
  const secret = new Uint8Array(32).fill(7);
  const words = [...timeWords, ...wordTag(1, sha256(hash)), ...(plain ? wordTag(13, utf8ToBytes(description)) : wordTag(23, hash)), ...wordTag(19, secp256k1.getPublicKey(secret))];
  const padded = [...words];
  while (padded.length % 8) padded.push(0);
  const input = concatBytes(utf8ToBytes(prefix), bech32.fromWords(padded).subarray(0, Math.ceil(words.length * 5 / 8)));
  const sig = secp256k1.sign(input, secret, { format: 'recovered' });
  return bech32.encode(prefix, [...words, ...bech32.toWords(concatBytes(sig.slice(1), sig.slice(0, 1)))], 8192);
}

export function signedZap(payer: Uint8Array, provider: Uint8Array, pubkey: string, sats: number, note?: string) {
  const tags = [['p', pubkey], ...(note ? [['e', note]] : [])];
  const request = finalizeEvent({ kind: 9734, created_at: 10, content: '', tags: [...tags, ['amount', String(sats * 1000)]] }, payer);
  const description = JSON.stringify(request);
  const invoice = signedInvoice(sats, description);
  const receipt = finalizeEvent({ kind: 9735, created_at: 11, content: '',
    tags: [...tags, ['P', request.pubkey], ['description', description], ['bolt11', invoice]] }, provider);
  return { receipt, request, invoice };
}
