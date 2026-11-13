import { publicMediaURL } from './media-refs.ts';
import { finalizeEvent } from 'nostr-tools/pure';
import type { Archive, Capture, Entry } from './types.ts';
import { errorMessage } from './types.ts';
import { xTemplate } from './model.ts';
import { accountFetch, download, openMediaBlocks, storeDownloadedFile } from './media-files.ts';

// Only X's image CDN is an automatic download source. Other links remain part of the post.
const linkPattern = /https?:\/\/[^\s<>"`]+/gi;
const trimLink = (token: string) => token.replace(/[.,!?;:\])}]+$/, '');
function isXImage(link: string) {
  try {
    const url = new URL(link);
    return url.host === 'pbs.twimg.com' && !url.username && !url.password;
  } catch {
    return false;
  }
}
export function publicImageURL(value: string) {
  return publicMediaURL(value) && !isXImage(value);
}

export function xImageURLs(text: string) {
  return [
    ...new Set(
      Array.from(text.matchAll(linkPattern), (match) => trimLink(match[0])).filter(isXImage),
    ),
  ];
}

export async function readyXEntry(
  db: Archive,
  post: Capture,
  servers: string[],
  secret: Uint8Array,
): Promise<Entry | undefined> {
  const event = xTemplate(post, post.author);
  const urls = new Map<string, string>();
  for (const source of xImageURLs(post.text)) {
    const saved = await db.get('xMedia', source);
    if (!saved?.hash) return;
    const file = await db.get('mediaFiles', saved.hash);
    const publicUrls = servers
      .filter(publicMediaURL)
      .map(
        (server) => file?.copyUrls?.[server] ?? (saved.server === server ? saved.url : undefined),
      )
      .filter((url): url is string => !!url && publicImageURL(url));
    const [url, ...mirrors] = [...new Set(publicUrls)];
    if (!url) return;
    urls.set(source, url);
    event.tags.push([
      'imeta',
      'url ' + url,
      'x ' + saved.hash,
      ...mirrors.map((mirror) => 'fallback ' + mirror),
    ]);
  }
  if (urls.size) {
    event.content = event.content.replace(linkPattern, (token) => {
      const link = trimLink(token);
      return urls.has(link) ? urls.get(link)! + token.slice(link.length) : token;
    });
  }
  return {
    event: finalizeEvent(event, secret),
    source: 'x:' + post.id,
    posters: post.posters?.map((url) => urls.get(url) ?? url),
  };
}

export async function cacheXImage(
  db: Archive,
  source: string,
  server: string,
  maxMiB: number,
  signal: AbortSignal,
) {
  const previous = await db.get('xMedia', source);
  if (previous?.hash && (await db.getKey('mediaFiles', previous.hash))) return previous.hash;
  if (previous?.retryAt && previous.retryAt > Date.now()) return;
  const blocks = openMediaBlocks(db);
  try {
    const url = new URL(source);
    url.protocol = 'https:';
    const result = await download(url.href, undefined, maxMiB * 1048576, accountFetch(signal));
    signal.throwIfAborted();
    if (!result.mime?.startsWith('image/'))
      throw Error('The X image source did not return an image.');
    const file = await storeDownloadedFile(db, blocks, result);
    await db.put('xMedia', { hash: file.sha256, server }, source);
    return file.sha256;
  } catch (error) {
    signal.throwIfAborted();
    await db.put(
      'xMedia',
      { server, retryAt: Date.now() + 300000, error: errorMessage(error) },
      source,
    );
  } finally {
    blocks.close();
  }
}
