import { xPermalink } from './x.ts';
import type { Capture } from './types.ts';

function decode(value: string) {
  const symbols: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/gi, (entity, name: string) => {
    if (name in symbols) return symbols[name];
    if (!name.startsWith('#')) return entity;
    const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}
const normalized = (value: string) => value.replace(/\s+/g, ' ').trim();
function embedText(value: string) {
  return normalized(decode(value.replace(/<br\s*\/?\s*>/gi, ' ').replace(/<[^>]*>/g, '')));
}

function matchesEmbed(caption: string, html: string) {
  const body = /<blockquote\b[^>]*class="twitter-tweet"[^>]*>\s*<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html)?.[1];
  if (body === undefined) return false;
  const links = /<a\b[^>]*href="(https?:\/\/[^"]+)"[^>]*>[\s\S]*?<\/a>/gi;
  return normalized(caption) === embedText(body) || normalized(caption) === embedText(body.replace(links, '$1'));
}

// The public status page includes author-scoped media records in the page data.
// These records bind each CDN asset to its parent post, even in a multi-photo post.
function publicPageMatches(html: string, postURL: string, caption: string, assets: string[]) {
  const metadata = new Map<string, string>();
  for (const match of html.matchAll(/<meta\s+property="(og:url|og:description)"\s+content="([^"]*)"[^>]*>/gi))
    metadata.set(match[1], decode(match[2]));
  if (metadata.get('og:url')?.toLowerCase() !== postURL ||
      !metadata.has('og:description') || normalized(metadata.get('og:description')!) !== normalized(caption)) return false;
  if (!assets.length) return true;
  // X serializes the public result as a JSON string in its page hydration data.
  const record = tweetRecord(html);
  if (record?.__typename !== 'Tweet' || String(record.rest_id) !== postURL.split('/').pop() ||
      record.core?.user_results?.result?.core?.screen_name?.toLowerCase() !== postURL.split('/')[3] ||
      !Array.isArray(record.media_entities2)) return false;
  const known = new Set<string>();
  for (const item of record.media_entities2) {
    if (typeof item.expanded_url !== 'string' ||
        !item.expanded_url.toLowerCase().startsWith(postURL + '/')) continue;
    if (typeof item.media_url_https === 'string') known.add(assetKey(item.media_url_https));
    for (const variant of item.video_info?.variants ?? []) {
      if (typeof variant.url === 'string') known.add(assetKey(variant.url));
    }
  }
  return assets.every(asset => known.has(assetKey(asset)));
}
function assetKey(value: string) {
  const url = new URL(value);
  if (url.origin === 'https://pbs.twimg.com' && [...url.searchParams.keys()].every(key => key === 'name' || key === 'format'))
    return url.origin + url.pathname.replace(/\.(jpe?g|png|webp|avif)$/i, '');
  return url.href;
}

function tweetRecord(html: string) {
  const data = /"\{\\"data\\":\{\\"tweet_result_by_rest_id\\":(?:[^"\\]|\\.)*"/.exec(html)?.[0];
  if (!data) return;
  return JSON.parse(JSON.parse(data))?.data?.tweet_result_by_rest_id?.result;
}

function extractedPost(html: string, author: string, id: string): Capture | undefined {
  const record = tweetRecord(html);
  const user = record?.core?.user_results?.result;
  if (
    record?.__typename !== 'Tweet' ||
    String(record.rest_id) !== id ||
    user?.core?.screen_name?.toLowerCase() !== author ||
    user?.privacy?.protected === true ||
    record.trusted_friends_info_result ||
    record.exclusive_tweet_results ||
    record.legacy?.retweeted_status_result
  )
    return;
  const details = record.details;
  const timeMs = Number(details?.created_at_ms);
  if (
    !Number.isSafeInteger(timeMs) ||
    timeMs <= 0 ||
    timeMs > Date.now() + 300000 ||
    typeof details?.full_text !== 'string' ||
    !Array.isArray(record.media_entities2)
  )
    return;
  const extended = record.note_tweet?.note_tweet_results?.result;
  if (record.note_tweet && typeof extended?.text !== 'string') return;
  const range = details.display_text_range;
  let text =
    extended?.text ??
    (Array.isArray(range)
      ? [...details.full_text].slice(range[0], range[1]).join('')
      : details.full_text);
  const links = extended?.entity_set?.urls ?? record.url_entities ?? [];
  for (const item of links) {
    if (typeof item.url === 'string' && typeof item.expanded_url === 'string')
      text = text.split(item.url).join(item.expanded_url);
  }
  const parts = [decode(text).trim()].filter(Boolean);
  const posters: string[] = [];
  for (const item of record.media_entities2) {
    if (
      typeof item.expanded_url !== 'string' ||
      xPermalink(item.expanded_url.split(/\/(?:photo|video)\//)[0])?.url !==
        'https://x.com/' + author + '/status/' + id
    )
      return;
    const video = item.video_info?.variants
      ?.filter(
        (v: { url?: string }) =>
          typeof v.url === 'string' &&
          /^https:\/\/video\.twimg\.com\/[^?#]+\.mp4(?:[?#]|$)/i.test(v.url),
      )
      .sort(
        (a: { bitrate?: number }, b: { bitrate?: number }) => (b.bitrate ?? 0) - (a.bitrate ?? 0),
      )[0]?.url;
    const asset = video ?? item.media_url_https;
    if (typeof asset !== 'string' || !/^https:\/\/(?:pbs|video)\.twimg\.com\//.test(asset)) return;
    if (!video && item.type !== 'photo') posters.push(asset);
    parts.push(asset);
  }
  const child = record.quoted_tweet_results?.result;
  const childName = child?.core?.user_results?.result?.core?.screen_name;
  const quote = xPermalink(
    record.legacy?.quoted_status_permalink?.expanded ??
      (childName && child?.rest_id
        ? 'https://x.com/' + childName + '/status/' + child.rest_id
        : ''),
  );
  if ((record.quoted_tweet_results || record.legacy?.quoted_status_permalink) && !quote) return;
  if (quote && quote.id !== id && !parts.includes(quote.url)) parts.push(quote.url);
  if (!parts.length) return;
  return {
    id,
    author,
    time: Math.floor(timeMs / 1000),
    timeMs,
    text: parts.join('\n\n'),
    visibility: 'public',
    ...(posters.length ? { posters } : {}),
  };
}

export async function readPublicXOriginal(
  author: string,
  id: string,
  fetcher = fetch,
  signal = AbortSignal.timeout(6000),
) {
  const url = 'https://x.com/' + author + '/status/' + id;
  const response = await fetcher(url, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
    signal,
  });
  if (response.url.toLowerCase() !== url) return;
  return extractedPost(await readPublicPage(response), author, id);
}

async function readPublicPage(response: Response) {
  const max = 4 * 1024 * 1024;
  if (!response.ok || !response.headers.get('content-type')?.startsWith('text/html') || !response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > max) return '';
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

// The timeline may contain protected posts or paid previews. Compare its content
// to the same post fetched without any account or cookies before sharing it.
export async function confirmPublicXPost(post: Capture, fetcher = fetch) {
  if (post.visibility === 'private' || !/^[a-z0-9_]{1,15}$/.test(post.author) || !/^\d{1,20}$/.test(post.id)) return false;
  const author = 'https://x.com/' + post.author;
  const url = author + '/status/' + post.id;
  const query = new URLSearchParams({ url, omit_script: 'true' });
  const options: RequestInit = {
    credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'error',
    signal: AbortSignal.timeout(6000),
  };
  try {
    const paragraphs = post.text.split('\n\n');
    const assets = paragraphs.filter(part => /^https:\/\/(pbs|video)\.twimg\.com\/\S+$/i.test(part));
    const caption = paragraphs.filter(part => !assets.includes(part)).join('\n\n');
    if (!assets.length) {
      const response = await fetcher('https://publish.x.com/oembed?' + query, options);
      if (response.ok && response.headers.get('content-type')?.startsWith('application/json')) {
        const embed = await response.json();
        if (embed?.type !== 'rich' || embed.url?.toLowerCase() !== url || embed.author_url?.toLowerCase() !== author ||
            typeof embed.html !== 'string') return false;
        if (matchesEmbed(caption, embed.html)) return true;
      }
    }
    // X redirects lowercase handles to their canonical case. Only accept a
    // response for the same HTTPS permalink after those redirects.
    const page = await fetcher(url, { ...options, redirect: 'follow' });
    if (page.url.toLowerCase() !== url) return false;
    const html = await readPublicPage(page);
    if (publicPageMatches(html, url, caption, assets)) return true;
    const original = extractedPost(html, post.author, post.id);
    return !!original && normalized(original.text) === normalized(post.text);
  } catch {
    return false;
  }
}
