import { isMetaMedia } from './social-media.ts';
import type { SocialCapture } from './types.ts';

const handlePart = '[a-z0-9._]{1,30}';
const profilePath = new RegExp('^/(' + handlePart + ')(?:/reels)?/?$', 'i');
const postPath = new RegExp('^/(?:(' + handlePart + ')/)?(p|reel)/([A-Za-z0-9_-]{1,32})/?$', 'i');
const reserved = new Set(['accounts', 'about', 'api', 'challenge', 'developer', 'direct', 'directory',
  'emails', 'explore', 'legal', 'oauth', 'p', 'press', 'privacy', 'reel', 'reels', 'stories',
  'terms', 'web', 'your_activity']);

function siteURL(value: string, base?: string) {
  try {
    const url = new URL(value, base);
    if ((url.origin === 'https://www.instagram.com' || url.origin === 'https://instagram.com') &&
        !url.username && !url.password) return url;
  } catch { /* Ignore other origins and incomplete links. */ }
}

export function instagramProfile(value: string) {
  const url = siteURL(value);
  const handle = url && (profilePath.exec(url.pathname)?.[1] ?? postPath.exec(url.pathname)?.[1])?.toLowerCase();
  return handle && !reserved.has(handle) ? handle : undefined;
}

function detail(value: string, handle: string, base?: string) {
  const url = siteURL(value, base);
  const match = url && postPath.exec(url.pathname);
  if (!match || (match[1] && match[1].toLowerCase() !== handle)) return;
  return { id: match[3], url: url.origin + '/' + match[2].toLowerCase() + '/' + match[3] + '/' };
}

export function instagramPermalink(value: string, handle: string) {
  return detail(value, handle)?.id;
}

type Item = { id: string; url: string };
type ParsePage = (html: string) => ParentNode;
type Timestamp = Pick<SocialCapture, 'time' | 'timePrecision'>;
type ObjectRecord = Record<string, unknown>;
function record(value: unknown): ObjectRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectRecord : undefined;
}

function fromCalendarDate(value: string): Timestamp | undefined {
  const day = /\b(January|February|March|April|May|June|July|August|September|October|November|December) (\d\d?), (\d{4})\b/.exec(value);
  if (!day) return;
  const millis = Date.parse(day[1] + ' ' + day[2] + ', ' + day[3] + ' 00:00:00 UTC');
  if (Number.isFinite(millis) && new Date(millis).getUTCDate() === Number(day[2]))
    return { time: millis / 1000, timePrecision: 'day' };
}

function mediaUrl(value: unknown) {
  return typeof value === 'string' && isMetaMedia(value) ? value : undefined;
}

function capture(item: Item, author: string, timestamp: Timestamp, caption: string, media: string[],
  visibility: SocialCapture['visibility'], posters: string[] = []): SocialCapture {
  return { source: 'instagram', ...item, author, ...timestamp, visibility,
    text: caption.trim() || media.join('\n\n'), media, ...(posters.length ? { posters } : {}) };
}

// Instagram inserts its server-supplied profile/detail records in application/json
// scripts. Repeated scroll/mutation observations share the parsed, per-script result.
const scripts = new WeakMap<Element, ObjectRecord[]>();
function pageMedia(script: Element) {
  const cached = scripts.get(script);
  if (cached) return cached;
  const records: ObjectRecord[] = [];
  const input = script.textContent || '';
  if (!input) return records;
  scripts.set(script, records);
  if (input.length > 4_000_000 || !input.includes('"media_type"') || !input.includes('"code"')) return records;
  function walk(value: unknown) {
    if (Array.isArray(value)) { for (const child of value) walk(child); return; }
    const obj = record(value);
    if (!obj) return;
    if (typeof obj.code === 'string' && record(obj.user)?.username && typeof obj.media_type === 'number') {
      records.push(obj);
      return;
    }
    for (const child of Object.values(obj)) walk(child);
  }
  try { walk(JSON.parse(input)); } catch { /* Partial or unsupported page data. */ }
  return records;
}

function visibleItems(doc: Document, url: string, handle: string) {
  const current = detail(url, handle);
  if (current) return [current];
  if (instagramProfile(url) !== handle) return [];
  const items = new Map<string, Item>();
  for (const link of doc.querySelectorAll('main a[href], [role="main"] a[href]')) {
    const href = link.getAttribute('href');
    const item = href && detail(href, handle, url);
    if (item) items.set(item.id, item);
  }
  return [...items.values()];
}

/**
 * Where the account's posts show on the page: its profile tiles, and the date link of an open post or a feed post.
 * Feed dates leave out the account's name, so they all count; only posts in the backup get a mark.
 */
export function instagramPostLinks(doc: Document, url: string, handle: string) {
  const found: { id: string; link: Element; tile: boolean }[] = [];
  for (const link of doc.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')) {
    const href = link.getAttribute('href') ?? '';
    const item = detail(href, handle, url);
    if (!item) continue;
    if (link.querySelector('time')) found.push({ id: item.id, link, tile: false });
    // The account's own tiles name it in their link. Other grids, such as Explore, are left alone.
    else if (link.querySelector('img') && instagramProfile(siteURL(href, url)!.href) === handle)
      found.push({ id: item.id, link, tile: true });
  }
  return found;
}

function mountedMedia(node: ObjectRecord, posters: string[]): string | undefined {
  const video = node.media_type === 2;
  const variants = video && Array.isArray(node.video_versions) ? node.video_versions : [];
  const src = variants.map(v => mediaUrl(record(v)?.url)).find(Boolean);
  if (src) return src;
  const images = record(node.image_versions2)?.candidates;
  const image = (Array.isArray(images) && images.map(v => mediaUrl(record(v)?.url)).find(Boolean)) ||
    mediaUrl(node.display_uri);
  if (video && image) posters.push(image);
  return image;
}

export function captureInstagramPosts(doc: Document, url: string, handle?: string): SocialCapture[] {
  if (!handle) return [];
  const items = new Map(visibleItems(doc, url, handle).map(item => [item.id, item]));
  if (!items.size) return [];
  const results = new Map<string, SocialCapture>();
  for (const script of doc.querySelectorAll('script[type="application/json"]')) {
    for (const node of pageMedia(script)) {
      const author = record(node.user);
      const item = items.get(String(node.code));
      if (!item || author?.username !== handle) continue;
      const time = node.taken_at;
      const timestamp = typeof time === 'number' && Number.isSafeInteger(time) && time > 0 ?
        { time } : fromCalendarDate(String(node.accessibility_caption ?? '').split('. ')[0]);
      if (!timestamp) continue;
      const carousel = node.media_type === 8;
      // A profile tile may contain only the cover. Opening the post loads the slides.
      if (carousel && (!Array.isArray(node.carousel_media) || !node.carousel_media.length)) continue;
      const nodes = carousel ? node.carousel_media as unknown[] : [node];
      const media = [], posters: string[] = [];
      for (const part of nodes) {
        const attachment = record(part);
        const src = attachment && mountedMedia(attachment, posters);
        if (src) media.push(src);
      }
      const caption = record(node.caption)?.text;
      if (media.length !== nodes.length || (caption !== undefined && typeof caption !== 'string')) continue;
      // A signed-in page can include restricted posts even on a public account.
      const restricted = author.is_private === true || node.audience === 'besties';
      results.set(item.id, capture(item, handle, timestamp, caption ?? '', media, restricted ? 'private' : 'unknown', posters));
    }
  }
  return [...results.values()];
}

function embedText(node: Node): string {
  if (node.nodeType === 3) return node.textContent || '';
  if (node.nodeType !== 1) return '';
  const el = node as Element;
  if (el.matches('.CaptionUsername,.CaptionComments')) return '';
  if (el.tagName === 'A') {
    const href = el.getAttribute('href');
    const url = href && siteURL(href, 'https://www.instagram.com/');
    if (url && postPath.test(url.pathname)) return url.href;
  }
  if (el.tagName === 'BR') return '\n';
  return Array.from(el.childNodes, embedText).join('');
}

function richEmbed(doc: ParentNode, item: Item, handle: string) {
  // Rich embeds deliver a double-encoded JSON string inside an initialization
  // script. Read only that JSON value, without running Instagram's JavaScript.
  for (const script of doc.querySelectorAll('script')) {
    const input = script.textContent || '';
    if (!input.includes('PolarisEmbedSimple') || !input.includes('shortcode_media')) continue;
    const literal = /"contextJSON"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(input)?.[1];
    if (!literal) continue;
    try {
      const node = JSON.parse(JSON.parse(literal))?.gql_data?.shortcode_media;
      if (node?.shortcode === item.id && node.owner?.username === handle) return record(node);
    } catch { /* Ignore unsupported embed formats. */ }
  }
}

export async function readInstagramQuote(parse: ParsePage, item: Item, handle: string, signal: AbortSignal, request: typeof fetch) {
  const embed = await anonymousPage(parse, item.url + 'embed/captioned/', signal, request);
  if (!embed) return;
  const card = embed.querySelector('.Embed[data-permalink][data-media-type]');
  const byline = card?.querySelector('.Header a.Username[href]')?.getAttribute('href');
  const owner = byline && instagramProfile(byline);
  if (!owner || !card || detail(card.getAttribute('data-permalink') ?? '', owner)?.id !== item.id) return;
  if (owner !== handle) return 'other-author' as const;
  return readInstagramPost(parse, item, handle, signal, request, embed);
}

function publicMedia(doc: ParentNode, item: Item, handle: string) {
  const embed = doc.querySelector('.Embed[data-permalink][data-media-type]');
  if (!embed || detail(embed.getAttribute('data-permalink')!, handle)?.id !== item.id) return;
  const byline = embed.querySelector('.Header a.Username[href]')?.getAttribute('href');
  if (!byline || instagramProfile(byline) !== handle) return;
  const captionEl = embed.querySelector('.Caption');
  const captionAuthor = captionEl?.querySelector('a.CaptionUsername')?.getAttribute('href');
  if (captionEl && (!captionAuthor || instagramProfile(captionAuthor) !== handle)) return;
  const caption = captionEl ? embedText(captionEl).trim() : '';
  const kind = embed.getAttribute('data-media-type');
  if (kind === 'GraphImage') {
    const imageLink = embed.querySelector('.Content a.EmbeddedMedia');
    if (detail(imageLink?.getAttribute('href') || '', handle)?.id !== item.id) return;
    const image = mediaUrl(imageLink?.querySelector('img.EmbeddedMediaImage')?.getAttribute('src'));
    if (image) return { caption, media: [image], posters: [] };
    return;
  }
  if (kind !== 'GraphSidecar' && kind !== 'GraphVideo') return;
  const graph = richEmbed(doc, item, handle);
  if (graph?.__typename !== kind) return;
  const edges = record(graph.edge_sidecar_to_children)?.edges;
  const nodes = kind === 'GraphSidecar' && Array.isArray(edges) ? edges.map(edge => record(record(edge)?.node)) :
    kind === 'GraphVideo' ? [graph] : [];
  if (!nodes.length) return;
  const media: string[] = [], posters: string[] = [];
  for (const node of nodes) {
    if (!node || typeof node.is_video !== 'boolean') return;
    const video = node.is_video && mediaUrl(node.video_url);
    const image = mediaUrl(node.display_url);
    const src = video || image;
    if (!src) return;
    if (node.is_video && !video) posters.push(src);
    media.push(src);
  }
  const captions = record(graph.edge_media_to_caption)?.edges;
  const text = Array.isArray(captions) && record(record(captions[0])?.node)?.text;
  return { caption: typeof text === 'string' ? text : caption, media, posters };
}

function publicTimestamp(doc: ParentNode, item: Item, handle: string): Timestamp | undefined {
  const meta = (key: string) => doc.querySelector('meta[property="' + key + '"]')?.getAttribute('content') ?? '';
  const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute('href');
  if (meta('og:type') !== 'article' || detail(canonical ?? '', handle)?.id !== item.id ||
      detail(meta('og:url'), handle)?.id !== item.id) return;
  const exact = Date.parse(meta('article:published_time'));
  if (Number.isFinite(exact)) return { time: Math.floor(exact / 1000) };
  // Instagram's two English description formats put its own byline before or
  // after the caption. Never accept a date mentioned in the user's caption.
  // A post without a caption ends right after the byline's date.
  const description = meta('og:description');
  const byline = / - @([a-z0-9._]+) on ([A-Za-z]+ \d\d?, \d{4})\s*$/i.exec(description) ||
    /^[\d,.KM]+ likes?, [\d,.KM]+ comments? - ([a-z0-9._]+) on ([A-Za-z]+ \d\d?, \d{4})(?:: "|\s*$)/i.exec(description);
  if (byline?.[1].toLowerCase() === handle) return fromCalendarDate(byline[2]);
}

// Limit reads as well as concurrency. Parse fetched pages in an inert template:
// an ordinary parsed HTML document can load images/frames carrying user cookies.
async function anonymousPage(parse: ParsePage, url: string, signal: AbortSignal, request: typeof fetch) {
  const response = await request(url, { credentials: 'omit', referrerPolicy: 'no-referrer',
    redirect: 'error', cache: 'no-store', signal });
  if (response.status === 429 || response.status >= 500) throw Error('Instagram temporarily unavailable');
  if (!response.ok || response.redirected || response.url !== url ||
      !/^text\/html\b/i.test(response.headers.get('content-type') || '')) return;
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let html = '', bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > 3_000_000) { await reader.cancel(); return; }
    html += decoder.decode(chunk.value, { stream: true });
  }
  return parse(html + decoder.decode());
}

async function readInstagramPost(parse: ParsePage, item: Item, handle: string, signal: AbortSignal, request: typeof fetch, fetchedEmbed?: ParentNode) {
  const embed = fetchedEmbed ?? await anonymousPage(parse, item.url + 'embed/captioned/', signal, request);
  const post = embed && publicMedia(embed, item, handle);
  if (!post) return;
  const page = await anonymousPage(parse, item.url, signal, request);
  const timestamp = page && publicTimestamp(page, item, handle);
  if (timestamp) return capture(item, handle, timestamp, post.caption, post.media, 'public', post.posters);
}

export function createInstagramCollector(onPosts: (posts: SocialCapture[]) => void, request: typeof fetch = fetch) {
  const session = new AbortController();
  const queue = new Map<string, { doc: Document; item: Item; handle: string }>();
  const active = new Set<string>(), retryAt = new Map<string, number>();
  let resumeAt = 0;
  async function run() {
    while (!session.signal.aborted && active.size < 2 && queue.size && Date.now() >= resumeAt) {
      const [key, { doc, item, handle }] = queue.entries().next().value!;
      queue.delete(key);
      active.add(key);
      try {
        const signal = AbortSignal.any([session.signal, AbortSignal.timeout(15000)]);
        const post = await readInstagramPost(html => {
          const template = doc.createElement('template');
          template.innerHTML = html;
          return template.content;
        }, item, handle, signal, request);
        if (session.signal.aborted) return;
        if (post) onPosts([post]);
        retryAt.set(key, post ? Infinity : Date.now() + 10 * 60_000);
      } catch {
        if (!session.signal.aborted) {
          retryAt.set(key, Date.now() + 60_000);
          resumeAt = Date.now() + 60_000;
        }
      } finally {
        active.delete(key);
        if (retryAt.size > 2000) retryAt.delete(retryAt.keys().next().value!);
      }
    }
  }
  return {
    collect(doc: Document, url: string, handle?: string) {
      if (session.signal.aborted || !handle || Date.now() < resumeAt) return;
      for (const item of visibleItems(doc, url, handle)) {
        if (queue.size >= 100) break;
        const key = handle + '/' + item.id;
        if (!active.has(key) && (retryAt.get(key) ?? 0) <= Date.now())
          queue.set(key, { doc, item, handle });
      }
      void run();
      void run();
    },
    stop() { session.abort(); queue.clear(); retryAt.clear(); },
    /** Posts are still waiting to be read. */
    busy: () => queue.size > 0 || active.size > 0,
  };
}
