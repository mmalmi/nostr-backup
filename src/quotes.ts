import { neventEncode } from 'nostr-tools/nip19';
import type { EventTemplate } from 'nostr-tools/pure';
import type { Archive, Capture, Settings, SocialCapture, SocialNetwork } from './types.ts';
import { instagramPermalink, instagramProfile } from './instagram.ts';
import { facebookPermalink, facebookPostURL } from './facebook.ts';
import { xPermalink } from './x.ts';

const postLinks = /https?:\/\/[^\s<>"`]+/gi;
const trimLink = (token: string) => token.replace(/[.,!?;:\])}]+$/, '');

export interface QuoteTarget {
  network: SocialNetwork | 'x';
  id: string;
  handle: string;
  url: string;
  link: string;
  // Instagram's /p/code/ permalinks do not identify an author.
  attributed: boolean;
}

export function quoteTargets(post: Capture | SocialCapture, conf: Settings): QuoteTarget[] {
  const result: QuoteTarget[] = [];
  for (const match of post.text.matchAll(postLinks)) {
    const link = trimLink(match[0]);
    if (result.some((q) => q.link === link) || !URL.canParse(link)) continue;
    const url = new URL(link);
    const network = ['instagram.com', 'www.instagram.com'].includes(url.hostname)
      ? 'instagram'
      : ['facebook.com', 'www.facebook.com'].includes(url.hostname)
        ? 'facebook'
        : 'x';
    const handle = network === 'x' ? conf.handle : conf.social?.[network]?.handle;
    if (!handle) continue;
    let id: string | undefined, canonical: string | undefined;
    let attributed = true;
    if (network === 'x') {
      const target = xPermalink(link);
      if (target?.author === handle) {
        id = target.id;
        canonical = target.url;
      }
    } else if (network === 'facebook') {
      id = facebookPermalink(link, handle);
      if (id) canonical = facebookPostURL(handle, id);
    } else {
      id = instagramPermalink(link, handle);
      attributed = instagramProfile(link) === handle;
      canonical =
        'https://www.instagram.com/' +
        (url.pathname.includes('/reel/') ? 'reel/' : 'p/') +
        id +
        '/';
    }
    if (!id || !canonical || (network === ('source' in post ? post.source : 'x') && id === post.id))
      continue;
    result.push({ network, handle, id, url: canonical, link, attributed });
  }
  return result;
}

export const targetKey = (target: QuoteTarget) => target.network + ':' + target.id;

// A missing author-qualified original keeps its quoting draft in the archive.
// For unscoped Instagram links, wait for an independent byline check.
export async function resolveQuotes(db: Archive, targets: QuoteTarget[], conf: Settings) {
  const links = new Map<string, string>();
  for (const target of targets) {
    const key = targetKey(target);
    const id = await db.get('sources', key);
    if (id && !(await db.getKey('heldEvents', id))) {
      const original = await db.get('events', id);
      if (original?.pubkey === conf.pubkey && original.kind === 1) {
        links.set(target.link, id);
        continue;
      }
    }
    if (!(target.network === 'x' ? conf.capture : conf.social?.[target.network]?.capture)) {
      // Keep a known self-quote pending until its source account can be captured.
      if (target.attributed) return;
      continue;
    }
    if (
      target.attributed ||
      (await db.getKey('drafts', key)) ||
      (await db.getKey('localCaptures', key))
    )
      return;
    // Unscoped Instagram links need a byline check before the outer post can be signed.
    if (!(await db.get('meta', ['quoteUnowned', target.handle, key]))) return;
  }
  return links;
}

export function applyQuotes(template: EventTemplate, links: Map<string, string>, owner: string) {
  if (!links.size) return template;
  const content = template.content.replace(postLinks, (token) => {
    const link = trimLink(token);
    const id = links.get(link);
    return id
      ? 'nostr:' + neventEncode({ id, author: owner, kind: 1 }) + token.slice(link.length)
      : token;
  });
  return {
    ...template,
    content,
    tags: [...template.tags, ...Array.from(new Set(links.values()), (id) => ['q', id, '', owner])],
  };
}
