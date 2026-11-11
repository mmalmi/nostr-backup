const profile = /^\/([a-z\d_]{1,15})(?:\/(?:with_replies|media))?\/?$/i;
const status = /^\/([a-z\d_]{1,15})\/status\/(\d{1,20})\/?$/i;
const tweet = 'article[data-testid="tweet"]';
function xPath(value) {
  try {
    const url = new URL(value, 'https://x.com');
    return url.origin === 'https://x.com' ? url.pathname : '';
  } catch {
    return '';
  }
}
export function profileHandle(url) {
  return profile.exec(xPath(url))?.[1].toLowerCase();
}
function bodyText(node) {
  if (node.nodeType === 3) return node.textContent;
  if (node.tagName === 'BR') return '\n';
  if (node.tagName === 'IMG') return node.getAttribute('alt') || '';
  if (node.getAttribute?.('aria-hidden') === 'true') return '';
  if (node.tagName === 'A') {
    const url = node.getAttribute('title') || node.getAttribute('href');
    if (/^https?:\/\//i.test(url) && !/^https?:\/\/x\.com\//i.test(url)) return url;
  }
  return Array.from(node.childNodes, bodyText).join('');
}
export function capturePosts(doc, url, handle) {
  if (!handle || profileHandle(url) !== handle) return [];
  const ownLink = doc.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
  if (profileHandle(ownLink?.getAttribute('href') || '/') !== handle) return [];
  const posts = [];
  for (const article of doc.querySelectorAll(tweet)) {
    if (
      article.parentElement?.closest(tweet) ||
      article.querySelector('[data-testid="tweet-text-show-more-link"]')
    )
      continue;
    // Quote cards can have their own name, timestamp and text inside a link container.
    const primary = (selector) =>
      Array.from(article.querySelectorAll(selector)).find(
        (node) =>
          node.closest(tweet) === article &&
          !node.closest('[role="link"],[data-testid="quoteTweet"]'),
      );
    const header = primary('[data-testid="User-Name"]');
    const time = header?.querySelector('a[href] time[datetime]');
    const match = status.exec(xPath(time?.closest('a')?.getAttribute('href')));
    if (!match || match[1].toLowerCase() !== handle) continue;
    const text = primary('[data-testid="tweetText"]');
    const content = text && bodyText(text).trim();
    const millis = Date.parse(time.dateTime || time.getAttribute('datetime'));
    const timestamp = Math.floor(millis / 1000);
    const attachments = [];
    for (const img of article.querySelectorAll('[data-testid="tweetPhoto"] img,video[poster]')) {
      if (
        img.closest(tweet) !== article ||
        img.closest('[role="link"]:not(a),[data-testid="quoteTweet"]')
      )
        continue;
      try {
        const url = new URL(img.getAttribute('poster') || img.getAttribute('src'));
        if (url.protocol === 'https:' && url.hostname === 'pbs.twimg.com')
          attachments.push(url.href);
      } catch {
        /* An image can be present before its source loads. */
      }
    }
    const parts = [content, ...new Set(attachments)].filter(Boolean);
    const quote = article.querySelector(
      '[data-testid="quoteTweet"] a[href*="/status/"], div[role="link"] a[href*="/status/"]',
    );
    const quoted = status.exec(xPath(quote?.getAttribute('href')));
    if (quoted && quoted[2] !== match[2])
      parts.push('https://x.com/' + quoted[1] + '/status/' + quoted[2]);
    if (parts.length && Number.isFinite(timestamp))
      posts.push({
        id: match[2],
        author: handle,
        time: timestamp,
        ...(millis % 1000 ? { timeMs: millis } : {}),
        text: parts.join('\n\n'),
      });
  }
  return posts;
}
