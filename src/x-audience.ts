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
    ...(timeMs % 1000 ? { timeMs } : {}),
    text: parts.join('\n\n'),
    visibility: 'public',
    ...(posters.length ? { posters } : {}),
  };
}

export interface PublicProfile {
  name: string;
  about?: string;
  picture?: string;
  banner?: string;
  website?: string;
}

const webAddress = (value: unknown) => {
  try {
    const url = new URL(String(value));
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && url.href.length <= 300) return url.href;
  } catch { /* Not a web address. */ }
};

/** Name, bio, avatar, banner and website from the profile result embedded in X's signed-out profile page. */
export function publicXProfile(html: string, handle: string): PublicProfile | undefined {
  for (const [literal] of html.matchAll(/"\{\\"data\\":\{\\"user_result_by_screen_name\\":(?:[^"\\]|\\.)*"/g)) {
    let user;
    try {
      user = JSON.parse(JSON.parse(literal))?.data?.user_result_by_screen_name?.result;
    } catch {
      continue;
    }
    // The page also embeds partial results for the same account; the full one has its avatar.
    if (user?.__typename !== 'User' || user.core?.screen_name?.toLowerCase() !== handle ||
        typeof user.core.name !== 'string' || !user.avatar) continue;
    const text = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
    let about = text(user.profile_bio?.description, 1000);
    for (const link of user.profile_bio?.entities?.description?.urls ?? [])
      if (typeof link?.url === 'string' && typeof link.expanded_url === 'string')
        about = about.split(link.url).join(link.expanded_url);
    const avatar = text(user.avatar.image_url, 300), banner = text(user.banner?.image_url, 300);
    const website = webAddress(user.profile_bio?.entities?.url?.urls?.[0]?.expanded_url);
    return {
      name: text(user.core.name, 100),
      ...(about ? { about } : {}),
      // X's default avatar lives elsewhere, so it is left out.
      ...(/^https:\/\/pbs\.twimg\.com\/profile_images\/[\w/.-]+$/.test(avatar)
        ? { picture: avatar.replace(/_normal(\.\w+)$/, '_400x400$1') } : {}),
      ...(/^https:\/\/pbs\.twimg\.com\/profile_banners\/\d+\/\d+$/.test(banner) ? { banner: banner + '/1500x500' } : {}),
      ...(website ? { website } : {}),
    };
  }
}

export async function readPublicXProfile(handle: string, fetcher = fetch, signal = AbortSignal.timeout(8000)) {
  const url = 'https://x.com/' + handle;
  const response = await fetcher(url, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal });
  if (response.url.toLowerCase() !== url) return;
  return publicXProfile(await readPublicPage(response), handle);
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
