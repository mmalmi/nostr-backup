import type { Event } from 'nostr-tools/pure';
import type { Archive, TipTarget } from './types.ts';
import { IDENTITY_KIND, checkXProof, xClaims, type XClaim } from './x-identity.ts';
import { isOwnEvent } from './model.ts';
import seed from './x-graph-seed.json' with { type: 'json' };

export interface DirectoryRow {
  pubkey: string;
  kind: number;
  created_at: number;
  id: string;
  handles: string[];
  claims: XClaim[];
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
    await tx.store.put({ pubkey, kind, created_at, id, claims, handles: claims.map(c => c.handle) });
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
