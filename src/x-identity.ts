import type { Event, EventTemplate } from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';
import { handlePattern } from './model.ts';
import { readPublicXOriginal } from './x-audience.ts';

// NIP-39 links an X account to a Nostr key with an `i` tag and a proof tweet.
// Claims are self-asserted, so every proof is checked against X before it is trusted.
export const IDENTITY_KIND = 10011;

export interface XClaim {
  pubkey: string;
  handle: string;
  proof: string;
  created_at: number;
}

export class XRateLimited extends Error {
  constructor() {
    super('X is limiting checks. Try again later.');
  }
}

export const proofText = (pubkey: string) =>
  'Verifying that I control the following Nostr public key: ' + npubEncode(pubkey);
/** The tweet to post: the NIP-39 wording, then where people can get the tool. */
export const proofTweet = (pubkey: string) => proofText(pubkey) + '\n\nBacked up with https://backup.iris.to';

/** A tweet the user posted on purpose to prove their key: verification wording plus the key. */
export function isProofPost(text: string, pubkey: string) {
  return /verifying/i.test(text) && namesKey(text, pubkey);
}

/** Whether a tweet names this key. NIP-39 and older nostr.directory proofs use the npub or the hex key. */
export function namesKey(text: string, pubkey: string) {
  const lower = text.toLowerCase();
  return lower.includes(npubEncode(pubkey)) || lower.includes(pubkey);
}

/** X claims from a kind 10011 identity list, or from `i` tags in an older kind 0 profile. */
export function xClaims(event: Event): XClaim[] {
  if (event.kind !== IDENTITY_KIND && event.kind !== 0) return [];
  return event.tags.flatMap(([name, identity, proof]) => {
    if (name !== 'i' || typeof identity !== 'string' || !identity.toLowerCase().startsWith('twitter:')) return [];
    const handle = identity.slice('twitter:'.length).toLowerCase();
    if (!handlePattern.test(handle) || !/^\d{1,20}$/.test(proof ?? '')) return [];
    return [{ pubkey: event.pubkey, handle, proof, created_at: event.created_at }];
  });
}

/** True when X shows the proof tweet by the claimed handle naming the claimant's key. */
export async function checkXProof(claim: XClaim, fetcher: typeof fetch = fetch) {
  const limited: typeof fetch = async (input, init) => {
    const response = await fetcher(input, init);
    if (response.status === 429) throw new XRateLimited();
    return response;
  };
  const post = await readPublicXOriginal(claim.handle, claim.proof, limited, AbortSignal.timeout(10000));
  return !!post && post.author === claim.handle && namesKey(post.text, claim.pubkey);
}

/** The identity list with this X claim, keeping claims for other platforms. */
export function identityTemplate(previous: Event | undefined, handle: string, proof: string): EventTemplate {
  const tags = (previous?.tags ?? []).filter(
    ([name, identity]) => name !== 'client' && !(name === 'i' && identity?.toLowerCase().startsWith('twitter:')),
  );
  return {
    kind: IDENTITY_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content: previous?.content ?? '',
    tags: [...tags, ['i', 'twitter:' + handle, proof], ['client', 'Social Backup']],
  };
}

/** The contact list with these keys added. Existing contacts, petnames and content are kept. */
export function contactsTemplate(previous: Event | undefined, add: string[]): EventTemplate {
  const tags = previous?.tags ?? [];
  const known = new Set(tags.filter(([name]) => name === 'p').map(([, key]) => key));
  return {
    kind: 3,
    created_at: Math.max(Math.floor(Date.now() / 1000), (previous?.created_at ?? 0) + 1),
    content: previous?.content ?? '',
    tags: [...tags, ...[...new Set(add)].filter((key) => !known.has(key)).map((key) => ['p', key])],
  };
}

export interface XMatch {
  handle: string;
  pubkey: string;
  name?: string;
}

/**
 * Finds verified Nostr keys for X handles. `query` reads claim events from relays. Each proof is
 * checked once and remembered; checks run one at a time and stop if X starts limiting them.
 */
export async function findXMatches(
  handles: string[],
  options: {
    query: (identities: string[]) => Promise<Event[]>;
    remembered: (claim: XClaim) => Promise<boolean | undefined>;
    remember: (claim: XClaim, ok: boolean) => Promise<void>;
    check?: (claim: XClaim) => Promise<boolean>;
    pause?: () => Promise<void>;
  },
) {
  const wanted = new Set(handles.map((handle) => handle.toLowerCase()));
  const newest = new Map<string, Event>();
  const names = new Map<string, string>();
  const list = [...wanted];
  for (let i = 0; i < list.length; i += 100) {
    for (const event of await options.query(list.slice(i, i + 100).map((handle) => 'twitter:' + handle))) {
      if (event.kind === 0) {
        try {
          const name = JSON.parse(event.content)?.display_name || JSON.parse(event.content)?.name;
          if (typeof name === 'string') names.set(event.pubkey, name.slice(0, 80));
        } catch { /* Profiles without JSON have no name. */ }
      }
      // A key's newest claim wins, so a removed claim is not used.
      const current = newest.get(event.pubkey);
      if (!current || event.created_at > current.created_at || (current.kind === 0 && event.kind === IDENTITY_KIND))
        newest.set(event.pubkey, event);
    }
  }
  const claims = [...newest.values()].flatMap(xClaims).filter((claim) => wanted.has(claim.handle));
  const matches: XMatch[] = [];
  let unchecked = 0;
  for (const claim of claims) {
    let ok = await options.remembered(claim);
    if (ok === undefined && !unchecked) {
      try {
        await options.pause?.();
        ok = await (options.check ?? checkXProof)(claim);
        await options.remember(claim, ok);
      } catch (error) {
        if (!(error instanceof XRateLimited)) throw error;
      }
    }
    if (ok === undefined) unchecked++;
    else if (ok) matches.push({ handle: claim.handle, pubkey: claim.pubkey, ...(names.has(claim.pubkey) ? { name: names.get(claim.pubkey) } : {}) });
  }
  return { matches, unchecked };
}
