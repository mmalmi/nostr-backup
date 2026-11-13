import type { Capture, SocialCapture } from './types.ts';
import { parseHTML } from 'linkedom/worker';
import { readPublicXOriginal } from './x-audience.ts';
import { publicFacebookPost } from './facebook.ts';
import { readInstagramQuote } from './instagram.ts';
import { type QuoteTarget } from './quotes.ts';

export async function verifySocialCapture(post: SocialCapture): Promise<SocialCapture> {
  if (post.visibility !== 'public') return post;
  const network = post.source;
  const url = network === 'facebook'
    ? 'https://www.facebook.com/' + post.author + '/posts/' + post.id
    : 'https://www.instagram.com/' + (new URL(post.url).pathname.includes('/reel/') ? 'reel/' : 'p/') + post.id + '/';
  const original = await readQuoteOriginal({
    network, handle: post.author, id: post.id, url, link: url, attributed: true,
  }, AbortSignal.timeout(15000)).catch(() => undefined);
  if (original && original !== 'other-author' && 'source' in original &&
      original.source === network && original.author === post.author && original.id === post.id &&
      original.visibility === 'public') return original;
  return { ...post, visibility: 'unknown' };
}

export async function readQuoteOriginal(
  target: QuoteTarget,
  signal: AbortSignal,
): Promise<SocialCapture | Capture | 'other-author' | undefined> {
  if (target.network === 'x') return readPublicXOriginal(target.handle, target.id, fetch, signal);
  // The background service worker has no browser DOM. Parse public markup in
  // memory using the same owner-checked readers as the timeline collectors.
  const { document } = parseHTML('<html></html>');
  if (target.network === 'facebook')
    return publicFacebookPost(document, target.url, target.handle, fetch, signal);
  return readInstagramQuote(
    document,
    { id: target.id, url: target.url },
    target.handle,
    signal,
    fetch,
  );
}
