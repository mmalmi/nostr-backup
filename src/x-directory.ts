import type { Event } from 'nostr-tools/pure';
import type { Archive, Profile, TipTarget } from './types.ts';
import { profileFromEvent } from './profile.ts';
import { IDENTITY_KIND, checkXProof, xClaims, type XClaim } from './x-identity.ts';
import { isOwnEvent } from './model.ts';
import seed from './x-graph-seed.json' with { type: 'json' };
import legacy from './x-legacy-proofs.json' with { type: 'json' };

// This index is only a hint. X must still show the account's proof, and any newer NIP-39
// identity list supersedes it. No request to a directory server reveals which handles are viewed.
const legacyClaims = new Map<string, XClaim[]>();
for (const [handle, pubkey, proof] of legacy) {
  const claims = legacyClaims.get(handle) ?? [];
  claims.push({ handle, pubkey, proof, created_at: 0 });
  legacyClaims.set(handle, claims);
}

export interface DirectoryRow {
  pubkey: string;
  kind: number;
  created_at: number;
  id: string;
  handles: string[];
  claims: XClaim[];
  /** From a kind 0 row, so profiles show without asking relays while you browse. */
  profile?: Profile;
}

// Two-hop owners projected from nostr-social-graph's checksum-pinned October 29 bootstrap.
export function directoryAuthors(owner: string, contacts?: Event) {
  const contactsKeys = (contacts?.tags ?? []).filter(([t, key]) => t === 'p' && /^[a-f0-9]{64}$/.test(key)).map(t => t[1]);
  return [...new Set([owner, ...contactsKeys, ...seed])];
}

export async function saveDirectory(db: Archive, events: Event[]) {
  const tx = db.transaction('xDirectory', 'readwrite');
  for (const event of events) {
    if (![0, IDENTITY_KIND].includes(event.kind) || !isOwnEvent(event, event.pubkey)) continue;
    const previous = await tx.store.get([event.pubkey, event.kind]);
    if (previous && (previous.created_at > event.created_at ||
        (previous.created_at === event.created_at && previous.id <= event.id))) continue;
    const { pubkey, kind, created_at, id } = event;
    const claims = xClaims(event);
    const profile = kind === 0 ? profileFromEvent(event) : undefined;
    await tx.store.put({ pubkey, kind, created_at, id, claims, handles: claims.map(c => c.handle), ...(profile ? { profile } : {}) });
  }
  await tx.done;
}

export async function directoryClaims(db: Archive, handle: string) {
  const rows = await db.getAllFromIndex('xDirectory', 'handles', handle);
  const claims: XClaim[] = [];
  for (const row of rows) {
    // A dedicated identity list, including an empty replacement, supersedes legacy profile tags.
    if (row.kind === 0 && await db.getKey('xDirectory', [row.pubkey, IDENTITY_KIND])) continue;
    claims.push(...row.claims.filter(c => c.handle === handle));
  }
  for (const claim of legacyClaims.get(handle) ?? []) {
    if (await db.getKey('xDirectory', [claim.pubkey, IDENTITY_KIND])) continue;
    if (!claims.some(c => c.pubkey === claim.pubkey && c.proof === claim.proof)) claims.push(claim);
  }
  return claims.sort((a, b) => BigInt(a.proof) > BigInt(b.proof) ? -1 : BigInt(a.proof) < BigInt(b.proof) ? 1 : 0);
}

// Once X confirms a newer proof, an unavailable or deleted proof cannot restore an old key.
export async function verifiedTarget(db: Archive, handle: string, check = checkXProof): Promise<TipTarget | undefined> {
  const key = ['xVerifiedProof', handle];
  const previous = (await db.get('meta', key)) as string[] | undefined;
  // Bound live X checks even when a handle attracts many competing claims.
  for (const claim of (await directoryClaims(db, handle)).slice(0, 4)) {
    if (previous && BigInt(claim.proof) < BigInt(previous[0])) break;
    if (!await check(claim)) continue;
    const tx = db.transaction('meta', 'readwrite');
    const latest = (await tx.store.get(key)) as string[] | undefined;
    if (latest && BigInt(claim.proof) < BigInt(latest[0])) return;
    await tx.store.put([claim.proof, claim.pubkey], key);
    await tx.done;
    return { proof: claim.proof, pubkey: claim.pubkey };
  }
}
