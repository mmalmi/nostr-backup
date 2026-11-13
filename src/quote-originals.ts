import type { Capture, SocialCapture } from './types.ts';
import { parseHTML } from 'linkedom/worker';
import { readPublicXOriginal } from './x-audience.ts';
import { publicFacebookPost } from './facebook.ts';
import { readInstagramQuote } from './instagram.ts';
import { type QuoteTarget } from './quotes.ts';

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
