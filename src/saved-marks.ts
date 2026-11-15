import type { SocialNetwork } from './types.ts';
import { FLOWER, MARK as TIP } from './x-tip-buttons.ts';
import { articlePost, postArticles } from './x.ts';
import { instagramPostLinks } from './instagram.ts';
import { facebookPostLinks } from './facebook.ts';

// Marks the user's own posts that are in the backup: the Social Backup flower with a check.
// Which posts are saved is read from the backup on this device. Nothing is asked of the network.

type Ask = (ids: string[]) => Promise<{ ok: boolean; value?: unknown } | undefined>;
type Kind = 'bar' | 'tip' | 'tile' | 'date';
/** A place for one post's mark: in `host`, right after `after`, or else before `before` or at the end. */
interface Spot {
  id: string;
  host: Element;
  after?: Element;
  before?: Element | null;
  kind: Kind;
}
const MARK = 'data-social-backup-saved';
const LABEL = 'Saved in your backup';
const LOOKS: Record<Kind, { size: number; flower: boolean; style: string }> = {
  // In X's action bar, sized and spaced like the tip button.
  bar: { size: 18.75, flower: true, style: 'padding:0 10px' },
  // On the user's own tip button, which already shows the flower: the check moves onto it.
  tip: { size: 18.75, flower: false, style: 'margin-left:-10px' },
  // Over a corner of an Instagram profile tile.
  tile: { size: 20, flower: true, style: 'position:absolute;left:8px;bottom:8px;z-index:1;filter:drop-shadow(0 1px 2px #0009)' },
  // Beside a post's date on Instagram and Facebook.
  date: { size: 14, flower: true, style: 'margin-inline-start:6px;vertical-align:middle' },
};

export function createSavedMarks(network: 'x' | SocialNetwork, ask: Ask, doc: Document = document) {
  const saved = new Set<string>();
  const asking = new Set<string>();
  // A post not saved yet is asked about again later, or as soon as it has been captured.
  const retryAt = new Map<string, number>();
  let generation = 0;

  function mark(id: string, kind: Kind) {
    const { size, flower, style } = LOOKS[kind];
    const check = Math.round(size * 0.55);
    // An <i>, so the tip button's own label <span> stays the only span in it.
    const node = doc.createElement('i');
    node.setAttribute(MARK, id);
    node.setAttribute('data-kind', kind);
    node.setAttribute('role', 'img');
    node.setAttribute('aria-label', LABEL);
    node.title = LABEL;
    // The check sits on the flower's lower right corner, whatever height the row around it has.
    node.innerHTML = (flower ? FLOWER : '') +
      `<svg viewBox="0 0 16 16" aria-hidden="true" style="flex:none;display:block;width:${check}px;height:${check}px;` +
      `margin:${size - check}px 0 0 ${flower ? -Math.round(check * 0.6) : 0}px">` +
      '<circle cx="8" cy="8" r="8" fill="#12a15f"/>' +
      '<path d="M4.4 8.4l2.4 2.4 4.8-5.2" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    node.style.cssText = 'display:inline-flex;align-items:center;flex:none;font-style:normal;line-height:0;' + style;
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
        const own = (node: Element) => node.closest('article') === article;
        const tip = Array.from(article.querySelectorAll('[' + TIP + ']')).find(own);
        // In the action bar, or at the end of the post if X's page no longer has one.
        const bar = Array.from(article.querySelectorAll('[role="group"]')).filter(own).at(-1);
        const id = articlePost(article)!.id;
        found.push(tip ? { id, host: tip, before: tip.querySelector('span'), kind: 'tip' } : { id, host: bar ?? article, kind: 'bar' });
      }
    } else if (network === 'instagram') {
      for (const { id, link, tile } of instagramPostLinks(doc, doc.location?.href ?? '', handle)) {
        // Beside the date itself: Instagram lays the date out as a block, so a mark after its link wraps to a new line.
        const time = tile ? undefined : link.querySelector('time')!;
        const host = time ? time.parentElement : tileBox(link);
        if (host) found.push(time ? { id, host, after: time, kind: 'date' } : { id, host, kind: 'tile' });
      }
    } else {
      // At the end of the date link, so it stays on the date's line.
      for (const [id, link] of facebookPostLinks(doc, handle)) found.push({ id, host: link, kind: 'date' });
    }
    return found;
  }

  function show({ id, host, after, before, kind }: Spot) {
    const current = Array.from(host.children).find((node) => node.hasAttribute(MARK));
    if (current?.getAttribute(MARK) === id && current.getAttribute('data-kind') === kind) return current;
    current?.remove();
    const node = mark(id, kind);
    if (after) after.after(node);
    else host.insertBefore(node, before ?? null);
    return node;
  }

  /** Marks the saved posts of `handle` on the page and removes marks that no longer belong. */
  function scan(handle: string) {
    if (!handle) return;
    const found = spots(handle);
    const now = Date.now();
    const unknown = [...new Set(found.map((spot) => spot.id))]
      .filter((id) => !saved.has(id) && !asking.has(id) && (retryAt.get(id) ?? 0) <= now)
      .slice(0, 50);
    if (unknown.length) {
      for (const id of unknown) asking.add(id);
      const active = generation;
      void ask(unknown)
        .catch(() => undefined)
        .then((reply) => {
          if (active !== generation) return;
          const hits = new Set(reply?.ok && Array.isArray(reply.value) ? (reply.value as string[]) : []);
          for (const id of unknown) {
            asking.delete(id);
            if (hits.has(id)) saved.add(id);
            else retryAt.set(id, Date.now() + 60000);
          }
          while (saved.size > 5000) saved.delete(saved.values().next().value!);
          while (retryAt.size > 5000) retryAt.delete(retryAt.keys().next().value!);
          if (hits.size) scan(handle);
        });
    }
    const kept = new Set<Element>();
    for (const spot of found) if (saved.has(spot.id)) kept.add(show(spot));
    // The page reuses its elements for other posts as it scrolls.
    for (const node of doc.querySelectorAll('[' + MARK + ']')) if (!kept.has(node)) node.remove();
  }
  /** These posts were just captured: ask about them again on the next scan. */
  function refresh(ids: string[]) {
    for (const id of ids) retryAt.delete(id);
  }
  function reset() {
    generation++;
    saved.clear();
    asking.clear();
    retryAt.clear();
    for (const node of doc.querySelectorAll('[' + MARK + ']')) node.remove();
  }
  return { scan, refresh, reset };
}
