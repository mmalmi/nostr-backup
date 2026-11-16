import { bech32 } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

const numberFromWords = (words: number[]) => words.reduce((value, word) => value * 32 + word, 0);

/** Decode the signed, fixed-amount BOLT11 invoice. Expiry is in Unix seconds. */
export function invoiceDetails(invoice: string) {
  try {
    if (typeof invoice !== 'string' || invoice.length > 8192) return;
    const { prefix, words } = bech32.decode(invoice as `${string}1${string}`, 8192);
    const amount = /^ln(bc|tb|bcrt|tbs)([1-9]\d{0,18})([munp]?)$/.exec(prefix);
    if (!amount || words.length < 111) return;
    const factors: Record<string, bigint> = {
      '': 1_000_000_000_000n,
      m: 1_000_000_000n,
      u: 1_000_000n,
      n: 1000n,
      p: 1n,
    };
    const pico = BigInt(amount[2]) * factors[amount[3]];
    const msats = Number(pico / 10n);
    if (pico % 10n || !Number.isSafeInteger(msats) || !msats) return;
    const end = words.length - 104;
    const timestamp = numberFromWords(words.slice(0, 7));
    let paymentHash: string | undefined, descriptionHash: string | undefined, payee: string | undefined;
    let description = false,
      expiry: number | undefined;
    for (let cursor = 7; cursor < end;) {
      if (cursor + 3 > end) return;
      const tag = words[cursor++],
        len = words[cursor++] * 32 + words[cursor++];
      if (cursor + len > end) return;
      const value = words.slice(cursor, cursor + len);
      cursor += len;
      if (tag === 1) {
        // p
        if (paymentHash || len !== 52) return;
        paymentHash = bytesToHex(bech32.fromWords(value));
      } else if (tag === 23) {
        // h
        if (descriptionHash || description || len !== 52) return;
        descriptionHash = bytesToHex(bech32.fromWords(value));
      } else if (tag === 13) {
        // d
        if (descriptionHash || description) return;
        description = true;
      } else if (tag === 19) {
        // n
        if (payee || len !== 53) return;
        payee = bytesToHex(bech32.fromWords(value));
      } else if (tag === 6) {
        // x
        if (expiry !== undefined || len > 10) return;
        expiry = numberFromWords(value);
      }
    }
    if (!paymentHash || !(descriptionHash || description)) return;
    const signature = bech32.fromWords(words.slice(end));
    if (signature[64] > 3) return;
    // BOLT11 signs the HRP followed by the data words padded to a whole byte.
    const padded = words.slice(0, end);
    while (padded.length % 8) padded.push(0);
    const data = bech32.fromWords(padded).subarray(0, Math.ceil((end * 5) / 8));
    const digest = sha256(concatBytes(utf8ToBytes(prefix), data));
    const recovered = secp256k1.recoverPublicKey(
      concatBytes(signature.slice(64), signature.slice(0, 64)),
      digest,
      { prehash: false },
    );
    if (payee && bytesToHex(recovered) !== payee) return;
    return {
      network: amount[1],
      paymentHash,
      msats,
      descriptionHash,
      expiresAt: timestamp + (expiry ?? 3600),
    };
  } catch {
    return;
  }
}
