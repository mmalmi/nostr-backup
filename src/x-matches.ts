import type { Event } from 'nostr-tools/pure';
import type { Archive, Capture } from './types.ts';

const daySeconds = 86400;
const wordOrSymbol = /https?:\/\/[^\s]+|[@#]?[\p{L}\p{M}\p{N}]+(?:'[\p{L}]+)?|[^\s]/gu;

function tokens(text: string) {
  return (text.normalize('NFKC').replace(/[‘’]/g, "'").match(wordOrSymbol) ?? []).map((token) =>
    /^https?:\/\//i.test(token) ? token : token.toLowerCase(),
  );
}

function words(tokens: string[]) {
  return tokens.filter((token) => !/^[.,!?“”"():;\-–—]$/.test(token));
}

function important(tokens: string[]) {
  return tokens
    .filter(
      (token) =>
        /\p{N}|^https?:\/\/|^[@#]|n't$|^(?:no|not|never|without|cannot|can|can't|won't|must|mustn't|only)$/u.test(
          token,
        ) || /\p{Extended_Pictographic}|[<>=+%]/u.test(token),
    )
    .join(' ');
}

// Bounded word edits keep order significant. Short captions require an exact match.
function similarity(left: string[], right: string[]) {
  if (!left.length || !right.length) return 0;
  if (left.length === right.length && left.every((token, i) => token === right[i])) return 1;
  const a = words(left),
    b = words(right);
  if (Math.min(a.length, b.length) < 12 || Math.max(a.length, b.length) > 180) return 0;
  const limit = Math.floor(Math.min(a.length, b.length) * 0.16);
  if (Math.abs(a.length - b.length) > limit || important(a) !== important(b)) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = Array<number>(b.length + 1).fill(limit + 1);
    row[0] = i;
    for (let j = Math.max(1, i - limit); j <= Math.min(b.length, i + limit); j++) {
      row[j] = Math.min(
        previous[j] + 1,
        row[j - 1] + 1,
        previous[j - 1] + Number(a[i - 1] !== b[j - 1]),
      );
    }
    if (Math.min(...row) > limit) return 0;
    previous = row;
  }
  const edits = previous[b.length];
  return edits <= limit ? 1 - edits / Math.max(a.length, b.length) : 0;
}

function passages(content: string) {
  const full = tokens(content);
  const parts = [full];
  // A thread on X can be a single multi-paragraph Nostr note.
  for (const paragraph of content.split(/\n\s*\n/)) {
    if (paragraph === content) break;
    const part = tokens(paragraph);
    if (words(part).length >= 12) parts.push(part);
  }
  return parts;
}

interface Candidate {
  event: Event;
  passages: string[][];
}

export async function findCrossposts(db: Archive, owner: string, posts: Capture[]) {
  const held = new Set(await db.getAllKeys('heldEvents'));
  const days = new Map<number, Candidate[]>();
  const matches = new Map<string, string>();
  for (const post of posts) {
    const since = post.time - (post.time % daySeconds);
    let candidates = days.get(since);
    if (!candidates) {
      const range = IDBKeyRange.bound(since, since + daySeconds, false, true);
      const events = await db.getAllFromIndex('events', 'created_at', range);
      candidates = events
        .filter(
          (event) =>
            event.pubkey === owner &&
            event.kind === 1 &&
            !held.has(event.id) &&
            !event.tags.some(
              ([type, url]) =>
                (type === 'r' || type === 'i') &&
                /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/\w+\/status\/\d+\/?$/i.test(url),
            ),
        )
        .map((event) => ({ event, passages: passages(event.content) }));
      days.set(since, candidates);
    }
    const capture = tokens(post.text);
    let best = 0,
      nearest = Infinity;
    for (const candidate of candidates) {
      const distance = Math.abs(candidate.event.created_at - post.time);
      for (const part of candidate.passages) {
        const score = similarity(capture, part);
        if (score > best || (score > 0 && score === best && distance < nearest)) {
          best = score;
          nearest = distance;
          matches.set(post.id, candidate.event.id);
        }
      }
    }
  }
  return matches;
}
