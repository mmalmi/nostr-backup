import type { SocialCapture } from './types.ts';

const base = 'https://www.facebook.com';
const handlePath = /^\/([a-z0-9.]{1,80})\/?$/i;
const postPath = /^\/([a-z0-9.]{1,80})\/posts\/(pfbid[a-z0-9]{8,100}|\d{1,25})\/?$/i;
const postID = /^(?:pfbid[a-z0-9]{8,100}|\d{1,25})$/i;
const reserved = new Set(('about ads business checkpoint events friends gaming groups help home ' +
  'login logout marketplace messages notifications pages people photo photos privacy professional_dashboard ' +
  'recover reel reels saved search settings share sharer stories video videos watch').split(' '));

function facebookURL(value: string) {
  try {
    const url = new URL(value, base);
    if (!url.username && !url.password && [base, 'https://facebook.com'].includes(url.origin)) return url;
  } catch { /* Invalid or foreign link. */ }
}

export function facebookProfile(value: string): string | undefined {
  const url = facebookURL(value);
  if (!url) return;
  if (url.pathname === '/profile.php') {
    const id = url.searchParams.get('id') ?? '';
    if (/^\d{1,25}$/.test(id) && !url.searchParams.has('sk')) return id;
    return;
  }
  const name = handlePath.exec(url.pathname)?.[1].toLowerCase();
  if (name && !name.endsWith('.php') && !reserved.has(name) && !url.searchParams.has('sk')) return name;
}

export function facebookPermalink(value: string, handle: string): string | undefined {
  const url = facebookURL(value);
  if (!url) return;
  const match = postPath.exec(url.pathname);
  if (match?.[1].toLowerCase() === handle) return match[2];
  if (/^\/(?:permalink|story)\.php$/.test(url.pathname) && url.searchParams.get('id') === handle &&
      /^\d{1,25}$/.test(handle)) {
    const id = url.searchParams.get('story_fbid') ?? '';
    if (postID.test(id)) return id;
  }
}

function cdn(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 16384) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        /(?:^|\.)fbcdn\.net$/.test(url.hostname)) return url.href;
  } catch { /* Incomplete media. */ }
}

function post(handle: string, id: string, time: number, text: string, media: string[],
              visibility: SocialCapture['visibility'], posters: string[] = []): SocialCapture | undefined {
  const attachments = [...new Set(media)];
  if (!Number.isSafeInteger(time) || time < 1 || time > Date.now() / 1000 + 300 ||
      (!text && !attachments.length)) return;
  return {source: 'facebook', id, author: handle, url: base + '/' + handle + '/posts/' + id, time,
    text: text || attachments.join('\n\n'), visibility,
    ...(attachments.length ? {media: attachments} : {}), ...(posters.length ? {posters} : {})};
}

interface FBActor { id?: string; url?: string }
interface FBMedia {
  __typename?: string;
  photo_image?: {uri?: string};
  playable_url_quality_hd?: string;
  playable_url?: string;
  preferred_thumbnail?: {image?: {uri?: string}};
}
interface FBAttachment {
  media?: FBMedia;
  styles?: {attachment?: FBAttachment};
  all_subattachments?: {count?: number; nodes?: FBAttachment[]};
  web_link?: {url?: string};
}
interface FBStory {
  __typename?: string; id?: string; post_id?: string; actors?: FBActor[]; permalink_url?: string;
  creation_time?: number; sponsored_data?: unknown; work_is_repost?: boolean; attached_story?: unknown;
  to?: unknown;
  attachments?: FBAttachment[];
  comet_sections?: {
    content?: {story?: {id?: string; post_id?: string; message?: {text?: string}; target_group?: unknown; attached_story?: unknown}};
    context_layout?: {story?: {comet_sections?: {metadata?: {
      __typename?: string; story?: {id?: string; privacy_scope?: {icon_image?: {name?: string}}}
    }[]}}};
  };
}

// Read the post's actual media. Images in actor, feedback and comment records are unrelated.
function readAttachment(item: FBAttachment, media: string[], posters: string[], links: string[]): boolean {
  const attachment = item?.styles?.attachment ?? item;
  if (!attachment) return false;
  const children = attachment.all_subattachments;
  if (children) {
    return Array.isArray(children.nodes) && children.nodes.length > 0 &&
      (children.count === undefined || children.count === children.nodes.length) &&
      children.nodes.every(child => readAttachment(child, media, posters, links));
  }
  const object = attachment.media;
  if (object?.__typename === 'Photo') {
    const photo = cdn(object.photo_image?.uri);
    if (photo) media.push(photo);
    return !!photo;
  }
  if (object?.__typename === 'Video') {
    const video = cdn(object.playable_url_quality_hd) ?? cdn(object.playable_url);
    if (video) { media.push(video); return true; }
    const poster = cdn(object.preferred_thumbnail?.image?.uri);
    if (poster) { media.push(poster); posters.push(poster); }
    return !!poster;
  }
  const link = attachment.web_link?.url;
  if (typeof link === 'string' && /^https?:\/\//i.test(link)) { links.push(link); return true; }
  return false;
}

function readStory(story: FBStory, owner: string, handle: string, originals: SocialCapture[], nested = false): SocialCapture | undefined {
  if (story?.__typename !== 'Story' || !story.id || !story.post_id ||
      story.sponsored_data || story.to ||
      !Array.isArray(story.actors) || story.actors.length !== 1) return;
  const actor = story.actors[0];
  if (!actor || actor.id !== owner || typeof actor.url !== 'string') return;
  const actorHandle = facebookProfile(actor.url);
  if (!actorHandle || (actorHandle !== handle && owner !== handle)) return;
  const id = story.permalink_url && (facebookPermalink(story.permalink_url, actorHandle) ??
    facebookPermalink(story.permalink_url, owner));
  const content = story.comet_sections?.content?.story;
  if (!id || !content || content.id !== story.id || content.post_id !== story.post_id ||
      content.target_group || !Array.isArray(story.attachments)) return;
  const attached = (story.attached_story ?? content.attached_story) as FBStory | undefined;
  if (story.work_is_repost && !attached) return;
  let quoted: string | undefined;
  if (attached) {
    if (nested || !attached.permalink_url || !facebookPermalink(attached.permalink_url, handle) ||
        facebookPermalink(attached.permalink_url,handle) === id) return;
    quoted = attached.permalink_url;
    // The child independently passes the same byline, timestamp and audience checks.
    const child = readStory(attached, owner, handle, originals, true);
    if (child) originals.push(child);
  }
  const metadata = story.comet_sections?.context_layout?.story?.comet_sections?.metadata;
  const audiences = Array.isArray(metadata) ? metadata.filter(section =>
    section?.__typename === 'CometFeedStoryAudienceStrategy' && section.story?.id === story.id) : [];
  const scope = audiences.length === 1 ? audiences[0].story?.privacy_scope?.icon_image?.name : undefined;
  const visibility = scope === 'everyone' ? 'public' : scope ? 'private' : 'unknown';
  const media: string[] = [], posters: string[] = [], links: string[] = [];
  if (!story.attachments.every(item => readAttachment(item, media, posters, links))) return;
  if (quoted) links.push(quoted);
  const message = content.message?.text;
  if (message != null && typeof message !== 'string') return;
  const body = [message?.trim(), ...links.filter(link => !message?.includes(link))].filter(Boolean).join('\n\n');
  return post(handle, id, story.creation_time ?? 0, body, media, visibility, posters);
}

type Timeline = {id?: string; timeline_list_feed_units?: {edges?: {node: FBStory}[]}};
function timelinePosts(json: unknown, handle: string): SocialCapture[] {
  const stack: unknown[] = [json], posts: SocialCapture[] = [];
  while (stack.length) {
    const item = stack.pop();
    if (!item || typeof item !== 'object') continue;
    const user = item as Timeline;
    const edges = user.timeline_list_feed_units?.edges;
    if (Array.isArray(edges) && typeof user.id === 'string') {
      for (const edge of edges) {
        const captured = readStory(edge?.node, user.id, handle, posts);
        if (captured) posts.push(captured);
      }
    } else {
      for (const child of Object.values(item)) if (child && typeof child === 'object') stack.push(child);
    }
  }
  return posts;
}

const scriptCache = new WeakMap<Element, {handle: string; posts: SocialCapture[]}>();
export function captureFacebookPosts(doc: Document, url: string, handle?: string): SocialCapture[] {
  if (!handle || facebookProfile(url) !== handle) return [];
  const captures = new Map<string, SocialCapture>();
  for (const script of doc.querySelectorAll('script[type="application/json"]')) {
    let cached = scriptCache.get(script);
    if (cached?.handle !== handle) {
      const data = script.textContent ?? '';
      let posts: SocialCapture[] = [];
      if (data.length <= 5000000 && data.includes('"timeline_list_feed_units"')) {
        try { posts = timelinePosts(JSON.parse(data), handle); } catch { /* Incomplete timeline. */ }
      }
      cached = {handle, posts};
      scriptCache.set(script, cached);
    }
    for (const captured of cached.posts) captures.set(captured.id, captured);
  }
  return [...captures.values()];
}

/** The account's posts mounted on the page, each with its permalink link. */
export function facebookPostLinks(doc: Document, handle: string) {
  const result = new Map<string, Element>();
  for (const article of doc.querySelectorAll('[role="article"]')) {
    if (article.parentElement?.closest('[role="article"]')) continue;
    const name = article.querySelector('[data-ad-rendering-role="profile_name"] a[href]');
    if (!name || name.closest('[role="article"]') !== article ||
        facebookProfile(name.getAttribute('href') ?? '') !== handle) continue;
    for (const link of article.querySelectorAll('a[href]')) {
      if (link.closest('[role="article"]') !== article ||
          link.closest('[data-ad-rendering-role="story_message"],[data-ad-preview="message"]') ||
          !(name.compareDocumentPosition(link) & 4)) continue;
      const id = facebookPermalink(link.getAttribute('href') ?? '', handle);
      if (id) { result.set(id, link); break; }
    }
  }
  return result;
}

function embedText(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  for (const link of copy.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href');
    if (!href) continue;
    try {
      let url = new URL(href, base);
      if (url.origin === 'https://l.facebook.com' && url.pathname === '/l.php')
        url = new URL(url.searchParams.get('u') ?? '');
      const label = link.textContent?.trim() ?? '';
      if (/^https?:$/.test(url.protocol) && (!facebookURL(url.href) || postPath.test(url.pathname) || ['/permalink.php','/story.php'].includes(url.pathname)) && !url.username && !url.password &&
          label !== url.href) link.replaceWith(label ? label + ' (' + url.href + ')' : url.href);
    } catch { /* Preserve the visible label when a link is malformed. */ }
  }
  for (const br of copy.querySelectorAll('br')) br.replaceWith('\n');
  for (const p of copy.querySelectorAll('p,div')) p.append('\n');
  return (copy.textContent ?? '').trim();
}

async function anonymousPage(doc: Document, request: string, fetcher: typeof fetch, signal: AbortSignal) {
  const response = await fetcher(request, {credentials: 'omit', referrerPolicy: 'no-referrer',
    redirect: 'error', cache: 'no-store', signal});
  if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) return;
  const html = await response.text();
  if (html.length > 2000000) return;
  const parsed = doc.createElement('template');
  parsed.innerHTML = html;
  return parsed.content;
}

// Read only the public embed returned anonymously. Never combine its visibility with
// signed-in caption or media bytes; an audience change cannot expose the older copy.
export async function publicFacebookPost(doc: Document, url: string, handle: string, fetcher: typeof fetch, signal: AbortSignal) {
  const id = facebookPermalink(url, handle);
  if (!id) return;
  const endpoint = new URL('/plugins/post.php', url);
  endpoint.searchParams.set('href', url);
  endpoint.searchParams.set('show_text', 'true');
  const parsed = await anonymousPage(doc, endpoint.href, fetcher, signal);
  if (!parsed) return;
  const feeds = parsed.querySelectorAll('[data-testid="newsFeedStream"] [role="feed"]');
  if (feeds.length !== 1) return;
  const feed = feeds[0];
  const ownQuotes: string[] = [];
  const articles = Array.from(feed.querySelectorAll('[role="article"],article'));
  const outerArticles = articles.filter(article => !article.parentElement?.closest('[role="article"],article'));
  if (outerArticles.length > 1) return;
  const outer = outerArticles.length === 1 ? outerArticles[0] : feed;
  // Remove separately attributed child cards before extracting the outer text,
  // timestamp or attachments. Only carry their original permalinks forward.
  for (const card of outer.querySelectorAll('[role="article"],article')) {
    const byline = Array.from(card.querySelectorAll('a[href]')).find(a =>
      a.querySelector('img[aria-label]') && facebookProfile(a.getAttribute('href') ?? '') === handle);
    const href = card.querySelector('a[href] abbr[data-utime]')?.closest('a')?.getAttribute('href');
    if (!byline || !href || !facebookPermalink(href,handle) || facebookPermalink(href,handle) === id) return;
    ownQuotes.push(facebookURL(href)!.href);
    card.remove();
  }
  const times = outer.querySelectorAll('a[href] abbr[data-utime]');
  if (times.length !== 1) return;
  const returned = facebookPermalink(times[0].closest('a')?.getAttribute('href') ?? '', handle);
  if (!returned) return;
  if (returned !== id) {
    // Facebook resolves opaque post IDs to a numeric ID on the embed. Verify the
    // equivalence using the public permalink's own canonical URL.
    if (!id.startsWith('pfbid') || !/^\d+$/.test(returned)) return;
    const page = await anonymousPage(doc, url, fetcher, signal);
    const canonical = page?.querySelector('link[rel="canonical"]')?.getAttribute('href');
    const canonicalURL = canonical && facebookURL(canonical);
    if (!canonicalURL) return;
    const match = /^\/([a-z0-9.]+)\/posts\/(?:[^/]+\/)?(\d{1,25})\/?$/i.exec(canonicalURL.pathname);
    if (!match || match[1].toLowerCase() !== handle || match[2] !== returned) return;
  }
  const profile = Array.from(outer.querySelectorAll('a[href]')).find(a =>
    facebookProfile(a.getAttribute('href') ?? '') === handle && a.querySelector('img[aria-label]'));
  if (!profile) return;
  const messages = outer.querySelectorAll('[data-testid="post_message"]');
  if (messages.length > 1 || outer.querySelector('.text_exposed_hide,.see_more_link')) return;
  const media: string[] = [], posters: string[] = [];
  for (const video of outer.querySelectorAll('video')) {
    const videoURL = cdn(video.getAttribute('src')) ?? cdn(video.querySelector('source[src]')?.getAttribute('src'));
    if (videoURL) { media.push(videoURL); continue; }
    const poster = cdn(video.getAttribute('poster'));
    if (!poster) return;
    media.push(poster); posters.push(poster);
  }
  for (const link of outer.querySelectorAll('a[href]')) {
    const uri = facebookURL(link.getAttribute('href') ?? '');
    if (!uri || !/^\/photo(?:\.php|\/)?$/.test(uri.pathname)) continue;
    for (const image of link.querySelectorAll('img[src]')) {
      const photo = cdn(image.getAttribute('src'));
      if (!photo) return;
      media.push(photo);
    }
  }
  return post(handle, id, Number(times[0].getAttribute('data-utime')),
    [messages[0] ? embedText(messages[0]) : '', ...new Set(ownQuotes)].filter(Boolean).join('\n\n'), media, 'public', posters);
}

export function createFacebookCollector(onPosts: (posts: SocialCapture[]) => void, fetcher: typeof fetch = fetch) {
  const known = new Map<string, number>();
  const queued = new Map<string, string>();
  const seen = new Map<string, SocialCapture>();
  let controller = new AbortController(), current = '', running = false;
  function stop() {
    controller.abort(); controller = new AbortController();
    current = ''; queued.clear(); known.clear(); seen.clear(); running = false;
  }
  function remember(id: string, expiry: number) {
    known.delete(id); known.set(id, expiry);
    if (known.size > 2000) {
      const oldest = known.keys().next().value!;
      known.delete(oldest); seen.delete(oldest);
    }
  }
  async function flush(doc: Document, handle: string) {
    if (running) return;
    running = true;
    const signal = controller.signal;
    try {
      while (!signal.aborted && queued.size) {
        const [id, url] = queued.entries().next().value!;
        queued.delete(id);
        remember(id, Date.now() + 60000);
        try {
          if (facebookProfile(doc.URL) !== handle) { queued.clear(); break; }
          const captured = await publicFacebookPost(doc, url, handle, fetcher, AbortSignal.any([signal, AbortSignal.timeout(10000)]));
          if (!signal.aborted && !seen.has(id) && facebookProfile(doc.URL) === handle && captured) {
            remember(id, Infinity); onPosts([captured]);
          }
        } catch { /* Login walls, unavailable embeds and transient errors yield no public capture. */ }
      }
    } finally { if (!signal.aborted) running = false; }
  }
  /** Posts are still waiting to be read. */
  const busy = () => running || queued.size > 0;
  return {stop, busy, collect(doc: Document, url: string, handle?: string) {
    if (!handle || facebookProfile(url) !== handle) { stop(); return; }
    if (current !== handle) { stop(); current = handle; }
    const found = captureFacebookPosts(doc, url, handle).filter(item => seen.get(item.id) !== item);
    if (found.length) {
      for (const item of found) { remember(item.id, Infinity); seen.set(item.id, item); queued.delete(item.id); }
      onPosts(found);
    }
    const origin = new URL(url).origin;
    for (const id of facebookPostLinks(doc, handle).keys()) {
      if ((known.get(id) ?? 0) <= Date.now() && queued.size < 20) queued.set(id, origin + '/' + handle + '/posts/' + id);
    }
    void flush(doc, handle);
  }};
}
