import type { SocialNetwork } from './types.ts';
import { FLOWER } from './x-tip-buttons.ts';
import { articlePost, postArticles } from './x.ts';
import { instagramPostLinks } from './instagram.ts';
import { facebookPostLinks } from './facebook.ts';

// Marks the user's own posts that are in the backup: the Social Backup flower with a check.
// Which posts are saved is read from the backup on this device. Nothing is asked of the network.
// A click on the mark of a post with a public copy opens that copy on Iris. The extension opens it,
// so the page never learns which Nostr note belongs to the post.

type Ask = (ids: string[]) => Promise<{ ok: boolean; value?: unknown } | undefined>;
type Kind = 'bar' | 'tile' | 'date';
/** One of the user's posts on the page and the place for its mark: in `host`, right after `after` or else at the end. */
interface Spot {
  id: string;
  /** Missing when the page has no fitting place: the post gets no mark. */
  host?: Element;
  after?: Element;
  kind: Kind;
}
const MARK = 'data-social-backup-saved';
const LABELS = { link: 'Backed up. See it on Iris', local: 'Backed up on this device' };
const LOOKS: Record<Kind, { size: number; flower: boolean; style: string }> = {
  // In X's action bar, sized and spaced like the tip button on other people's posts.
  bar: { size: 18.75, flower: true, style: 'padding:0 10px' },
  // Over a corner of an Instagram profile tile.
  tile: { size: 20, flower: true, style: 'position:absolute;left:8px;bottom:8px;z-index:1;filter:drop-shadow(0 1px 2px #0009)' },
  // Beside a post's date on Instagram and Facebook.
  date: { size: 14, flower: true, style: 'margin-inline-start:6px;vertical-align:middle' },
};

export function createSavedMarks(network: 'x' | SocialNetwork, ask: Ask, open: (id: string) => void, doc: Document = document) {
  // Saved posts, and whether each has a public copy on Nostr.
  const saved = new Map<string, boolean>();
  const asking = new Set<string>();
  // A post that is not saved or not public yet is asked about again later, or as soon as it has been captured.
  const retryAt = new Map<string, number>();
  // When the backup last said that it lacks a post, and the posts found by the latest scan.
  const missedAt = new Map<string, number>();
  let visible: string[] = [];
  let generation = 0;

  function mark(id: string, kind: Kind, onNostr: boolean) {
    const { size, flower, style } = LOOKS[kind];
    const check = Math.round(size * 0.55);
    const node = doc.createElement('i');
    node.setAttribute(MARK, id);
    node.setAttribute('data-kind', kind);
    node.setAttribute('role', onNostr ? 'link' : 'img');
    node.setAttribute('aria-label', onNostr ? LABELS.link : LABELS.local);
    node.title = onNostr ? LABELS.link : LABELS.local;
    if (onNostr) {
      node.tabIndex = 0;
      // The mark can sit inside the page's own link to the post. The click is for the mark alone.
      const go = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        open(id);
      };
      node.addEventListener('click', go);
      node.addEventListener('keydown', (event) => (event as KeyboardEvent).key === 'Enter' && go(event));
    }
    // The check sits on the flower's lower right corner, whatever height the row around it has.
    node.innerHTML = (flower ? FLOWER : '') +
      `<svg viewBox="0 0 16 16" aria-hidden="true" style="flex:none;display:block;width:${check}px;height:${check}px;` +
      `margin:${size - check}px 0 0 ${flower ? -Math.round(check * 0.6) : 0}px">` +
      '<circle cx="8" cy="8" r="8" fill="#12a15f"/>' +
      '<path d="M4.4 8.4l2.4 2.4 4.8-5.2" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    node.style.cssText = 'display:inline-flex;align-items:center;flex:none;font-style:normal;line-height:0;' + (onNostr ? 'cursor:pointer;' : '') + style;
    if (flower) Object.assign(node.querySelector('svg')!.style, { width: size + 'px', height: size + 'px' });
    return node;
  }

  /** The tile's own box, so the mark stays on the tile. Without one the tile gets no mark. */
  function tileBox(link: Element) {
    const placed = (node: Element | null) => {
      try {
        return !!node && ['relative', 'absolute', 'fixed', 'sticky'].includes(doc.defaultView!.getComputedStyle(node).position);
      } catch {
        return false;
      }
    };
    if (placed(link.firstElementChild)) return link.firstElementChild!;
    if (placed(link) || placed(link.parentElement)) return link;
  }

  function spots(handle: string): Spot[] {
    const found: Spot[] = [];
    if (network === 'x') {
      for (const article of postArticles(doc)) {
        if (article.parentElement?.closest('article') || articlePost(article)?.author !== handle) continue;
        // In the action bar, or at the end of the post if X's page no longer has one.
        const bar = Array.from(article.querySelectorAll('[role="group"]')).filter((group) => group.closest('article') === article).at(-1);
        found.push({ id: articlePost(article)!.id, host: bar ?? article, kind: 'bar' });
      }
    } else if (network === 'instagram') {
      for (const { id, link, tile } of instagramPostLinks(doc, doc.location?.href ?? '', handle)) {
        // Beside the date itself: Instagram lays the date out as a block, so a mark after its link wraps to a new line.
        const time = tile ? undefined : link.querySelector('time')!;
        found.push(time ? { id, host: time.parentElement ?? undefined, after: time, kind: 'date' } : { id, host: tileBox(link), kind: 'tile' });
      }
    } else {
      // At the end of the date link, so it stays on the date's line.
      for (const [id, link] of facebookPostLinks(doc, handle)) found.push({ id, host: link, kind: 'date' });
    }
    return found;
  }

  function show({ id, host, after, kind }: Spot & { host: Element }, onNostr: boolean) {
    const current = Array.from(host.children).find((node) => node.hasAttribute(MARK));
    if (current?.getAttribute(MARK) === id && current.getAttribute('data-kind') === kind &&
        (current.getAttribute('role') === 'link') === onNostr) return current;
    current?.remove();
    const node = mark(id, kind, onNostr);
    if (after) after.after(node);
    else host.append(node);
    return node;
  }

  /**
   * Looks up the posts of `handle` on the page, marks the saved ones and removes marks that no longer belong.
   * Without `draw` it only looks them up, for `unsaved`.
   */
  function scan(handle: string, draw = true) {
    if (!handle) return;
    const found = spots(handle);
    visible = [...new Set(found.map((spot) => spot.id))];
    const now = Date.now();
    const unknown = visible
      .filter((id) => !saved.get(id) && !asking.has(id) && (retryAt.get(id) ?? 0) <= now)
      .slice(0, 50);
    if (unknown.length) {
      for (const id of unknown) asking.add(id);
      const active = generation;
      void ask(unknown)
        .catch(() => undefined)
        .then((reply) => {
          if (active !== generation) return;
          const answered = !!reply?.ok && Array.isArray(reply.value);
          const hits = new Map<string, boolean>();
          for (const hit of answered ? (reply!.value as { id?: unknown; onNostr?: unknown }[]) : [])
            if (typeof hit?.id === 'string') hits.set(hit.id, hit.onNostr === true);
          let changed = false;
          for (const id of unknown) {
            asking.delete(id);
            const onNostr = hits.get(id);
            if (onNostr !== undefined) {
              changed ||= saved.get(id) !== onNostr;
              saved.set(id, onNostr);
            } else if (answered && saved.delete(id)) changed = true;
            if (!onNostr) retryAt.set(id, Date.now() + 60000);
            if (onNostr !== undefined) missedAt.delete(id);
            else if (answered) missedAt.set(id, Date.now());
          }
          while (saved.size > 5000) saved.delete(saved.keys().next().value!);
          while (retryAt.size > 5000) retryAt.delete(retryAt.keys().next().value!);
          while (missedAt.size > 5000) missedAt.delete(missedAt.keys().next().value!);
          if (changed) scan(handle, draw);
        });
    }
    const kept = new Set<Element>();
    if (draw) for (const spot of found) {
      const onNostr = saved.get(spot.id);
      if (onNostr !== undefined && spot.host) kept.add(show({ ...spot, host: spot.host }, onNostr));
    }
    // The page reuses its elements for other posts as it scrolls.
    for (const node of doc.querySelectorAll('[' + MARK + ']')) if (!kept.has(node)) node.remove();
  }
  /** These posts were just captured: ask about them again on the next scan. */
  function refresh(ids: string[]) {
    for (const id of ids) retryAt.delete(id);
  }
  /** The posts found by the latest scan that the backup lacks, each with when the backup last said so. */
  function unsaved() {
    return visible.filter((id) => !saved.has(id)).map((id) => ({ id, checked: missedAt.get(id) }));
  }
  function reset() {
    generation++;
    visible = [];
    saved.clear();
    asking.clear();
    retryAt.clear();
    missedAt.clear();
    for (const node of doc.querySelectorAll('[' + MARK + ']')) node.remove();
  }
  return { scan, refresh, unsaved, reset };
}
