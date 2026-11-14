import type { Capture } from './types.ts';

const profile = /^\/([a-z\d_]{1,15})(?:\/(?:with_replies|media))?\/?$/i;
const status = /^\/([a-z\d_]{1,15})\/status\/(\d{1,20})\/?$/i;
const tweet = 'article[data-testid="tweet"]';
function xPath(value?: string | null) {
  try {
    if (!value) return '';
    const url = new URL(value, 'https://x.com');
    return url.origin === 'https://x.com' ? url.pathname : '';
  } catch {
    return '';
  }
}
export function profileHandle(url?: string) {
  return profile.exec(xPath(url))?.[1].toLowerCase();
}
export function xPermalink(value: string) {
  try {
    const url = new URL(value, 'https://x.com');
    if (!['x.com','www.x.com','twitter.com','www.twitter.com'].includes(url.hostname) ||
        !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return;
    const match = status.exec(url.pathname);
    if (match) {
      const author = match[1].toLowerCase(), id = match[2];
      return {author, id, url: 'https://x.com/' + author + '/status/' + id};
    }
  } catch { /* Incomplete permalink. */ }
}
function bodyText(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? '';
  if (node.nodeType !== 1) return '';
  const element = node as Element;
  if (element.tagName === 'BR') return '\n';
  if (element.tagName === 'IMG') return element.getAttribute('alt') || '';
  if (element.getAttribute?.('aria-hidden') === 'true') return '';
  if (element.tagName === 'A') {
    const url = element.getAttribute('title') || element.getAttribute('href');
    const postLink = url && xPermalink(url);
    if (postLink) return postLink.url;
    if (url && /^https?:\/\//i.test(url) && !/^https?:\/\/x\.com\//i.test(url)) return url;
  }
  return Array.from(node.childNodes, bodyText).join('');
}
/** IDs of the account's own posts on any X page whose text passes `isProof`, such as the home timeline right after posting. */
export function proofPostIds(doc: Document, handle: string, isProof: (text: string) => boolean) {
  const ids: string[] = [];
  for (const article of doc.querySelectorAll(tweet)) {
    if (article.parentElement?.closest(tweet)) continue;
    const primary = (selector: string) =>
      Array.from(article.querySelectorAll(selector)).find(
        (node) => node.closest(tweet) === article && !node.closest('[role="link"],[data-testid="quoteTweet"]'),
      );
    const time = primary('[data-testid="User-Name"]')?.querySelector('a[href] time[datetime]');
    const match = status.exec(xPath(time?.closest('a')?.getAttribute('href')));
    const text = primary('[data-testid="tweetText"]');
    if (match && match[1].toLowerCase() === handle && text && isProof(bodyText(text))) ids.push(match[2]);
  }
  return ids;
}
export function capturePosts(doc: Document, url: string, handle?: string): Capture[] {
  if (!handle || profileHandle(url) !== handle) return [];
  const posts = [];
  for (const article of doc.querySelectorAll(tweet)) {
    if (article.parentElement?.closest(tweet)) continue;
    const truncated = !!article.querySelector('[data-testid="tweet-text-show-more-link"]');
    // Quote cards can have their own name, timestamp and text inside a link container.
    const primary = (selector: string) =>
      Array.from(article.querySelectorAll(selector)).find(
        (node) =>
          node.closest(tweet) === article &&
          !node.closest('[role="link"],[data-testid="quoteTweet"]'),
      );
    const header = primary('[data-testid="User-Name"]');
    const time = header?.querySelector<HTMLTimeElement>('a[href] time[datetime]');
    const match = status.exec(xPath(time?.closest('a')?.getAttribute('href')));
    if (!time || !match || match[1].toLowerCase() !== handle) continue;
    const audience = article.querySelector(
      '[data-testid="icon-lock"],[data-testid="protectedIcon"],[data-testid="superFollowsLabel"],' +
      '[data-testid="exclusiveTweetLabel"],[data-testid="trustedFriendsTweetBanner"],' +
      '[aria-label*="protected account" i],[aria-label*="subscriber-only" i],[aria-label*="subscribers only" i]',
    );
    const text = primary('[data-testid="tweetText"]');
    const content = text && bodyText(text).trim();
    const millis = Date.parse(time.dateTime || time.getAttribute('datetime') || '');
    const timestamp = Math.floor(millis / 1000);
    const attachments = [],
      posters = [];
    const photos = Array.from(article.querySelectorAll('[data-testid="tweetPhoto"]')).filter(
      node => node.closest(tweet) === article && !node.closest('[role="link"]:not(a),[data-testid="quoteTweet"]'),
    );
    const readyPhotos = new Set<Element>();
    for (const img of article.querySelectorAll<HTMLImageElement | HTMLVideoElement>(
      '[data-testid="tweetPhoto"] img,video',
    )) {
      if (
        img.closest(tweet) !== article ||
        img.closest('[role="link"]:not(a),[data-testid="quoteTweet"]')
      )
        continue;
      try {
        if (img.tagName === 'VIDEO') {
          const urls = [
            img.currentSrc,
            img.getAttribute('src'),
            ...Array.from(img.querySelectorAll('source[src]'), (s) => s.getAttribute('src')),
          ];
          const video = urls.find(
            (s) => s && /^https:\/\/video\.twimg\.com\/[^?#]*\.mp4(?:[?#]|$)/i.test(s),
          );
          if (video) {
            attachments.push(video);
            const photo = img.closest('[data-testid="tweetPhoto"]');
            if (photo) readyPhotos.add(photo);
            continue;
          }
        }
        const imageSource = img.getAttribute('poster') || img.getAttribute('src');
        if (!imageSource) continue;
        const url = new URL(imageSource);
        if (url.protocol === 'https:' && url.hostname === 'pbs.twimg.com') {
          attachments.push(url.href);
          const photo = img.closest('[data-testid="tweetPhoto"]');
          if (photo) readyPhotos.add(photo);
          if (img.tagName === 'VIDEO') posters.push(url.href);
        }
      } catch {
        /* An image can be present before its source loads. */
      }
    }
    // X sometimes mounts the text one frame before its photo source. Wait for
    // the attachment before committing the immutable signed copy.
    if (photos.some(photo => !readyPhotos.has(photo))) continue;
    const parts = [content, ...new Set(attachments)].filter(Boolean);
    const card = article.querySelector('[data-testid="quoteTweet"]') ??
      Array.from(article.querySelectorAll('div[role="link"]')).find(el =>
        el.querySelector('[data-testid="User-Name"], [data-testid="tweetText"], a[href*="/status/"], time'));
    const quote = card && Array.from(card.querySelectorAll('a[href]')).map(a => xPermalink(a.getAttribute('href')!)).find(Boolean);
    if (quote && quote.id !== match[2] && !content?.includes(quote.url)) parts.push(quote.url);
    if (parts.length && Number.isFinite(timestamp))
      posts.push({
        id: match[2],
        author: handle,
        ...(card ? {hasQuoteCard:true} : {}),
        ...(truncated ? {truncated:true} : {}),
        ...(audience ? { visibility: 'private' as const } : {}),
        time: timestamp,
        ...(millis % 1000 ? { timeMs: millis } : {}),
        ...(posters.length ? { posters } : {}),
        text: parts.join('\n\n'),
      });
  }
  return posts;
}

const following = /^\/([a-z\d_]{1,15})\/following\/?$/i;
/** The handle whose following list this page shows. */
export function followingHandle(url?: string) {
  return following.exec(xPath(url))?.[1].toLowerCase();
}
/** Handles listed on the user's own following page, not suggestions elsewhere on the page. */
export function captureFollows(doc: Document, url: string, handle?: string) {
  if (!handle || followingHandle(url) !== handle) return [];
  const found = new Set<string>();
  for (const cell of doc.querySelectorAll('[data-testid="primaryColumn"] [data-testid="UserCell"]')) {
    const link = Array.from(cell.querySelectorAll('a[href]'))
      .map((a) => profileHandle(a.getAttribute('href') ?? undefined))
      .find(Boolean);
    if (link && link !== handle) found.add(link);
  }
  return [...found];
}
