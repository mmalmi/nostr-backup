import type { Event } from 'nostr-tools/pure';
import type { MediaReference } from './types.ts';
import { parseBlossomURI } from 'nostr-tools/nipb7';

const hashPattern = /^[a-f0-9]{64}$/;
const mediaPath =
  /\.(avif|gif|hei[cf]|jpe?g|png|svg|webp|m4a|mp3|oga|ogg|opus|wav|flac|mov|mp4|m4v|ogv|webm|pdf)$/i;
const posterPath = /^\/(?:ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//;

export function httpsURL(value?: string) {
  try {
    if (!value) return;
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url;
  } catch {
    /* A post can contain incomplete links. */
  }
}

export function blossomHash(url: URL) {
  return /\/([0-9a-f]{64})(?:\.[a-z0-9]+)?$/i.exec(url.pathname)?.[1].toLowerCase();
}

export function blossomOrigin(value: string) {
  const url = httpsURL(value);
  if (!url || url.pathname !== '/' || url.search || url.hash)
    throw Error('Enter a Blossom server origin such as https://media.example.com.');
  return url.origin;
}

// Record signed metadata before looking at bare URLs so a content link cannot
// bypass an advertised digest. Keep a separate reference for each signed event.
export function mediaReferences(event: Event, posters: string[] = []) {
  const refs = new Map<string, MediaReference>();
  function add(
    value: string | undefined,
    {
      digest,
      fallbacks = [],
      tagged = false,
      mime,
    }: { digest?: string; fallbacks?: string[]; tagged?: boolean; mime?: string } = {},
  ) {
    if (!value || refs.has(value)) return;
    const url = httpsURL(value);
    let addressHash,
      servers: string[] = [];
    if (url) {
      addressHash = blossomHash(url);
      if (
        !tagged &&
        !posters.includes(value) &&
        !addressHash &&
        !mediaPath.test(url.pathname) &&
        !(
          url.hostname === 'pbs.twimg.com' &&
          (/^\/media\//.test(url.pathname) || posterPath.test(url.pathname))
        )
      )
        return;
    } else {
      try {
        const blossom = parseBlossomURI(value);
        addressHash = blossom.sha256;
        servers = blossom.servers
          .map((s) => httpsURL(s.includes('://') ? s : 'https://' + s)?.origin)
          .filter((url): url is string => !!url);
      } catch {
        return;
      }
    }
    const expected = digest?.toLowerCase() || addressHash || undefined;
    const invalidHash =
      !!digest &&
      (!hashPattern.test(digest.toLowerCase()) || (!!addressHash && expected !== addressHash));
    const poster =
      posters.includes(value) ||
      (url?.hostname === 'pbs.twimg.com' && posterPath.test(url.pathname));
    refs.set(value, {
      eventId: event.id,
      url: value,
      expected,
      invalidHash,
      poster: !!poster,
      mime,
      fallbacks: fallbacks.filter((s) => httpsURL(s)),
      servers,
      status: 'pending',
    });
  }
  for (const [kind, ...fields] of event.tags) {
    if (kind !== 'imeta') continue;
    const values = (key: string) =>
      fields.filter((s) => s.startsWith(key + ' ')).map((s) => s.slice(key.length + 1));
    add(values('url')[0], {
      tagged: true,
      digest: values('x')[0],
      mime: values('m')[0],
      fallbacks: values('fallback'),
    });
  }
  if (event.kind === 1063) {
    const values = (key: string) => event.tags.filter((t) => t[0] === key).map((t) => t[1]);
    add(values('url')[0], {
      tagged: true,
      digest: values('x')[0],
      mime: values('m')[0],
      fallbacks: values('fallback'),
    });
  }
  // Repost content can be serialized JSON from another author.
  if (![6, 16].includes(event.kind)) {
    for (const match of event.content.matchAll(/(?:https:\/\/|blossom:)[^\s<>"'\x60]+/gi))
      add(match[0].replace(/[.,!?;:\])}]+$/, ''));
  }
  return [...refs.values()];
}
