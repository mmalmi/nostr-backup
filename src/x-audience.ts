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
  const data = /"\{\\"data\\":\{\\"tweet_result_by_rest_id\\":(?:[^"\\]|\\.)*"/.exec(html)?.[0];
  if (!data) return false;
  const record = JSON.parse(JSON.parse(data))?.data?.tweet_result_by_rest_id?.result;
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
      if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json')) return false;
      const embed = await response.json();
      if (embed?.type !== 'rich' || embed.url?.toLowerCase() !== url || embed.author_url?.toLowerCase() !== author ||
          typeof embed.html !== 'string') return false;
      if (matchesEmbed(caption, embed.html)) return true;
    }
    // X redirects lowercase handles to their canonical case. Only accept a
    // response for the same HTTPS permalink after those redirects.
    const page = await fetcher(url, { ...options, redirect: 'follow' });
    if (page.url.toLowerCase() !== url) return false;
    return publicPageMatches(await readPublicPage(page), url, caption, assets);
  } catch {
    return false;
  }
}
