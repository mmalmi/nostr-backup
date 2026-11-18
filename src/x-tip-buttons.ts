import type { CaptureConfig, Message, TipTarget } from './types.ts';
import type { IssuedInvoice } from './x-tips.ts';
import type { TipSummary, TipLocation } from './tip-history.ts';
import { followingHandle, postArticles, profileHandle, xPermalink } from './x.ts';
import { formatFiat, tipCurrency, tipPresets } from './rates.ts';
import qrcode from 'qrcode-generator';
import { npubEncode } from 'nostr-tools/nip19';

// Adds a quiet Social Backup flower button to X posts and a "Tip" button to profiles with a local Nostr link claim.
// Proof and address are checked on click.
// The ordinary menu opens wallet review. Quick tips use the account's explicit, fixed-amount setting.

type Send = (message: Message) => Promise<{ ok: boolean; value?: unknown; error?: string } | undefined>;
// Small, medium and large tips, with Iris's emoji.
const EMOJI = ['👍', '💯', '🔥'];
export const MARK = 'data-social-backup-tip';
const POST = 'data-social-backup-post';
// Profile pills share one fixed height, with or without an icon.
const PILL = 'box-sizing:border-box;height:28px;padding:0 10px;background:transparent;border:1px solid currentColor;' +
  'border-radius:999px;font:600 13px/1 system-ui;margin-inline-start:4px';
// The Social Backup forget-me-not (ui/icon.svg), with IDs that cannot clash with X's page.
export const FLOWER =
  // 18.75px like X's own action icons; an inline size so page styles cannot change it.
  '<svg viewBox="0 0 512 512" aria-hidden="true" style="flex:none;width:18.75px;height:18.75px;display:block">' +
  '<defs><linearGradient id="sb-tip-petal" x1="96" y1="96" x2="416" y2="416" gradientUnits="userSpaceOnUse">' +
  '<stop offset="0" stop-color="#9ad8ff"/><stop offset="1" stop-color="#4f7dff"/></linearGradient>' +
  '<mask id="sb-tip-cuts" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512"><rect width="512" height="512" fill="#fff"/>' +
  '<path fill="none" stroke="#000" stroke-linecap="round" stroke-width="10" d="M256 256l77.6-106.8M256 256l125.5 40.8M256 256v132M256 256l-125.5 40.8M256 256l-77.6-106.8"/>' +
  '<circle cx="256" cy="256" r="56"/></mask></defs>' +
  '<g transform="translate(256 256) scale(1.44) translate(-256 -246.5)"><g fill="url(#sb-tip-petal)" mask="url(#sb-tip-cuts)">' +
  '<circle cx="256" cy="156" r="76"/><circle cx="351.1" cy="225.1" r="76"/><circle cx="314.8" cy="336.9" r="76"/>' +
  '<circle cx="197.2" cy="336.9" r="76"/><circle cx="160.9" cy="225.1" r="76"/></g>' +
  '<circle cx="256" cy="256" r="38" fill="#ffd66e"/></g></svg>';

function author(article: Element) {
  for (const link of article.querySelectorAll('[data-testid="User-Name"] a[href]')) {
    if (link.closest('article') !== article) continue;
    // The header links to the author's profile and to the post, which also names the author.
    const href = link.getAttribute('href') ?? '';
    const handle = profileHandle(href) ?? xPermalink(href)?.author;
    if (handle) return handle;
  }
  // Without X's name header, the post's own timestamp permalink still names its author.
  const time = Array.from(article.querySelectorAll('a[href] time')).find((t) => t.closest('article') === article);
  return xPermalink(time?.closest('a')?.getAttribute('href') ?? '')?.author;
}
// The post's ID, time and opening text, used to find its Nostr copy when a tip popover opens.
interface Post {
  id: string;
  time?: number;
  text?: string;
}
const postTime = (article: Element) => Array.from(article.querySelectorAll('a[href] time')).find(t => t.closest('article') === article);
function postInfo(article: Element): Post | undefined {
  const time = postTime(article);
  const id = xPermalink(time?.closest('a')?.getAttribute('href') ?? '')?.id;
  if (!id) return;
  const seconds = Math.floor(Date.parse(time?.getAttribute('datetime') ?? '') / 1000);
  const text = Array.from(article.querySelectorAll('[data-testid="tweetText"]')).find((t) => t.closest('article') === article);
  return {
    id,
    ...(Number.isSafeInteger(seconds) ? { time: seconds } : {}),
    ...(text?.textContent ? { text: text.textContent.slice(0, 280) } : {}),
  };
}

export function createTipButtons(send: Send, doc: Document = document) {
  const targets = new Map<string, TipTarget | null>();
  const asking = new Set<string>();
  // A miss can be checked locally again after a directory refresh.
  const retryAt = new Map<string, number>();
  const followingRows = new Map<HTMLElement, { direction: string; align: string }>();
  function restoreFollowingRow(row: HTMLElement) {
    const before = followingRows.get(row);
    if (!before) return;
    row.style.flexDirection = before.direction;
    row.style.alignItems = before.align;
    followingRows.delete(row);
  }
  let generation = 0;
  let quickTip: CaptureConfig['quickTip'];
  const started = new Set<string>();
  let press: {node: HTMLButtonElement; id: number; x: number; y: number; released: boolean} | undefined;
  let holdTimer: ReturnType<typeof setTimeout> | undefined, tapTimer: ReturnType<typeof setTimeout> | undefined;
  let delayed: HTMLButtonElement | undefined, ignorePointer: number | undefined;
  function cancelGesture() {
    clearTimeout(holdTimer);
    clearTimeout(tapTimer);
    press = undefined;
    delayed = undefined;
  }
  // Pointer events from X scripts cannot arm or complete a payment. Any second press on
  // the same flower during the double-click interval cancels the first tap as well.
  doc.addEventListener('pointerdown', event => {
    if (!event.isTrusted) return;
    ignorePointer = delayed && event.composedPath().includes(delayed) ? event.pointerId : undefined;
    cancelGesture();
  }, true);
  doc.addEventListener('pointermove', event => {
    if (event.isTrusted && press && event.pointerId === press.id && !press.released &&
        Math.hypot(event.clientX - press.x, event.clientY - press.y) > 6) cancelGesture();
  }, true);
  doc.addEventListener('pointerup', event => {
    if (!event.isTrusted || !press || event.pointerId !== press.id) return;
    clearTimeout(holdTimer);
    if (event.isPrimary && event.button === 0 && event.composedPath().includes(press.node) &&
      Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 6) press.released = true;
    else cancelGesture();
  }, true);
  doc.addEventListener('pointercancel', cancelGesture, true);
  doc.addEventListener('scroll', cancelGesture, { capture: true, passive: true });
  doc.defaultView?.addEventListener('scroll', cancelGesture, { passive: true });
  doc.defaultView?.addEventListener('blur', cancelGesture);
  doc.addEventListener('visibilitychange', cancelGesture);
  let popover: HTMLElement | undefined, opener: HTMLElement | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;
  // One fiat rate per page, for showing tip amounts in the chosen currency or the browser's region's.
  let currency = tipCurrency(undefined, navigator.languages ?? []);
  let rate: Promise<number | null> | undefined;
  // Local private amounts and click-only public totals live outside X's DOM.
  const amounts = new Map<string, number>(), totals = new Map<string, string>();
  const checked = new Map<string, number>(), checking = new Set<string>();
  const labels = new WeakMap<Element, HTMLElement>();
  const locationKey = (target: TipLocation) => target.pubkey + ':' + (target.post ?? '');
  const satLabel = (sats: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(sats) + (sats === 1 ? ' sat' : ' sats');
  function paint(node: Element, key: string) {
    const label = labels.get(node);
    if (!label) return;
    const yours = amounts.get(key) ?? 0;
    const total = totals.get(key);
    const text = [yours ? '✓' : '', total ?? ''].filter(Boolean).join(' ');
    if (label.textContent !== text) label.textContent = text;
    label.title = yours ? 'You tipped ' + satLabel(yours) : '';
    if (yours) label.setAttribute('aria-label', label.title);
    else label.removeAttribute('aria-label');
  }
  function paintAll() {
    for (const node of doc.querySelectorAll('button[' + MARK + ']')) {
      const handle = node.getAttribute(MARK)!, target = targets.get(handle);
      const post = node.getAttribute(POST) ?? undefined;
      if (target && (post || node.closest('[data-testid="UserName"]'))) paint(node, locationKey({ pubkey: target.pubkey, post }));
    }
  }
  function markVisible(locations: TipLocation[]) {
    const now = Date.now(), active = generation;
    const batch = Array.from(new Map(locations.map(t => [locationKey(t), t])).values())
      .filter(t => !checking.has(locationKey(t)) && (checked.get(locationKey(t)) ?? 0) <= now);
    for (let i = 0; i < batch.length; i += 50) {
      const group = batch.slice(i, i + 50);
      for (const target of group) checking.add(locationKey(target));
      void send({ type: 'tipMarks', targets: group }).then(reply => {
        if (generation !== active || !reply?.ok || !Array.isArray(reply.value) || reply.value.length !== group.length) return;
        const values = reply.value;
        group.forEach((target, index) => {
          const key = locationKey(target), sats = values[index];
          if (typeof sats === 'number' && Number.isFinite(sats) && sats >= 0)
            amounts.set(key, Math.max(sats, amounts.get(key) ?? 0));
          checked.set(key, now + 30000);
        });
        paintAll();
      }).catch(() => {}).finally(() => {
        if (generation === active) for (const target of group) checking.delete(locationKey(target));
      });
    }
  }
  // Returning from the extension wallet prompts the normal content scan to reread local history.
  doc.defaultView?.addEventListener('focus', () => checked.clear());
  doc.addEventListener('visibilitychange', () => { if (!doc.hidden) checked.clear(); });

  function close() {
    clearTimeout(poll);
    poll = undefined;
    const returnFocus = popover && doc.activeElement === popover;
    popover?.remove();
    popover = undefined;
    if (returnFocus && opener?.isConnected) opener.focus({ preventScroll: true });
    opener = undefined;
  }
  function button(handle: string, post: Post | undefined, placement: 'profile' | 'post', article?: Element, parent?: Element) {
    const node = doc.createElement('button');
    node.type = 'button';
    node.setAttribute(MARK, handle);
    if (post) node.setAttribute(POST, post.id);
    node.innerHTML = FLOWER;
    if (placement === 'profile') node.append('Tip');
    const host = doc.createElement('span'), label = doc.createElement('span');
    host.attachShadow({ mode: 'closed' }).append(label);
    node.append(host);
    labels.set(node, label);
    const target = targets.get(handle);
    if (target && (placement === 'profile' || post)) paint(node, locationKey({ pubkey: target.pubkey, post: post?.id }));
    node.title = 'Tip @' + handle + ' with Bitcoin';
    node.setAttribute('aria-label', node.title);
    node.style.cssText = 'display:inline-flex;align-items:center;gap:4px;cursor:pointer;color:inherit;white-space:nowrap;' +
      (placement === 'profile' ? PILL : 'background:none;border:0;font:13px/1 system-ui;padding:0 10px');
    // In a pill the flower matches the label's size; on posts it matches X's action icons.
    if (placement === 'profile') Object.assign(node.querySelector('svg')!.style, { width: '16px', height: '16px' });
    if (quickTip && post && article && target) {
      node.style.setProperty('touch-action', 'manipulation');
      node.style.setProperty('user-select', 'none');
      node.style.setProperty('-webkit-touch-callout', 'none');
      node.title += ' · Hold or Shift-click for tip options';
      node.setAttribute('aria-label', node.title);
      const key = locationKey({ pubkey: target.pubkey, post: post.id });
      const settings = quickTip;
      const flower = node.querySelector('svg')!;
      const currentPost = () => {
        const link = xPermalink(postTime(article)?.closest('a')?.getAttribute('href') ?? '');
        return node.isConnected && node.closest('article') === article && node.parentElement === parent && author(article) === handle &&
          link?.author === handle && link.id === post.id && targets.get(handle)?.pubkey === target.pubkey && quickTip === settings;
      };
      const currentHit = (x: number, y: number) => {
        if (!currentPost() || doc.hidden || !node.contains(doc.elementFromPoint(x, y))) return false;
        const rect = flower.getBoundingClientRect(), bounds = article.getBoundingClientRect();
        if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return false;
        // Check the visible flower itself, including its small padding hit area. An unrelated
        // or stretched element elsewhere on the page can never stand in for this gesture.
        return rect.width >= 12 && rect.height >= 12 && rect.width <= 40 && rect.height <= 40 &&
          x >= rect.left - 12 && x <= rect.right + 12 && y >= rect.top - 6 && y <= rect.bottom + 6 &&
          flower.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) === true;
      };
      const modified = (event: MouseEvent) => event.shiftKey || event.ctrlKey || event.altKey || event.metaKey;
      const canQuickTip = () => amounts.get(key) === 0 && !started.has(key);
      node.addEventListener('pointerdown', event => {
        if (!event.isTrusted || !event.isPrimary || event.button !== 0 || event.buttons !== 1 ||
          ignorePointer === event.pointerId || modified(event) || !canQuickTip() || !currentHit(event.clientX, event.clientY)) return;
        const gesture = { node, id: event.pointerId, x: event.clientX, y: event.clientY, released: false };
        press = gesture;
        holdTimer = setTimeout(() => {
          if (press !== gesture || gesture.released) return;
          cancelGesture();
          if (currentHit(gesture.x, gesture.y)) void open(node, handle, post);
        }, 500);
      });
      node.addEventListener('contextmenu', event => {
        if (event.isTrusted && currentPost()) {
          event.preventDefault();
          event.stopPropagation();
          cancelGesture();
          if (opener !== node) void open(node, handle, post);
        }
      });
      node.addEventListener('click', event => {
        if (!event.isTrusted) return;
        event.preventDefault();
        event.stopPropagation();
        if (!currentPost() || event.detail > 1) return;
        // Keyboard/assistive activation and modifier clicks always choose a payment in the menu.
        if (event.detail === 0 || modified(event) || !canQuickTip() || typeof flower.checkVisibility !== 'function') {
          cancelGesture();
          void open(node, handle, post);
          return;
        }
        if (!press?.released || press.node !== node || !currentHit(event.clientX, event.clientY)) return;
        const {x, y} = press;
        cancelGesture();
        delayed = node;
        tapTimer = setTimeout(async () => {
          delayed = undefined;
          if (!currentHit(x, y) || !canQuickTip()) return;
          started.add(key);
          const reply = await send({type: 'quickTip', account: settings.account, sats: settings.sats, handle, pubkey: target.pubkey, post: post.id}).catch(() => undefined);
          if (!currentPost()) return;
          checked.delete(key);
          markVisible([{pubkey: target.pubkey, post: post.id}]);
          if (!reply?.ok || (reply.value as {state?: string})?.state !== 'opened')
            void open(node, handle, post, reply?.ok ? undefined : reply?.error ?? 'Quick tip unavailable. Choose a payment below.');
        }, 500);
      });
    } else node.addEventListener('click', event => {
      if (!event.isTrusted || !node.isConnected) return;
      event.preventDefault();
      event.stopPropagation();
      void open(node, handle, post);
    });
    return node;
  }

  // An empty popover below `anchor`, in its own shadow DOM so X's styles and ours never mix.
  function popoverAt(anchor: HTMLElement, label: string) {
    close();
    opener = anchor;
    popover = doc.createElement('div');
    const rect = anchor.getBoundingClientRect();
    // Below the button, centred on it, and always inside the window.
    const view = doc.defaultView, height = view?.innerHeight ?? 768, viewWidth = view?.innerWidth ?? 1024;
    const width = Math.min(270, viewWidth - 16);
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, viewWidth - width - 8));
    const above = height - rect.bottom < 390 && rect.top > height - rect.bottom;
    const edge = above ? 'bottom:' + (height - rect.top + 6) : 'top:' + (rect.bottom + 6);
    const available = Math.max(80, (above ? rect.top : height - rect.bottom) - 14);
    popover.style.cssText = `position:fixed;z-index:2147483647;${edge}px;left:${Math.round(left)}px`;
    // Clicks inside the popover never reach X or the close-on-outside-click handler.
    popover.addEventListener('click', (event) => event.stopPropagation());
    const root = popover.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      .box{font:14px/1.4 system-ui,sans-serif;background:#fff;color:#1c2434;border:1px solid #dce2ec;border-radius:12px;
        box-sizing:border-box;padding:12px 14px;width:${width}px;max-height:${available}px;overflow:auto;box-shadow:0 8px 24px #0002}
      @media (prefers-color-scheme:dark){.box{background:#181c26;color:#e9ecf3;border-color:#2a3142}}
      p{margin:0 0 10px} small{opacity:.7;display:block;margin-top:8px} small:empty{display:none}
      .row{display:flex;gap:6px}.cashu{width:100%;margin-bottom:8px}.kind{margin:-3px 0 9px}
      button,a{flex:1;font:600 13px system-ui;border-radius:8px;padding:7px 0;cursor:pointer;
        text-align:center;text-decoration:none;border:1px solid #2a4fbd;background:#2a4fbd;color:#fff}
      .custom{display:flex;gap:6px;margin:8px 0 0}.custom input{box-sizing:border-box;min-width:0;flex:1;padding:7px 8px;
        border-radius:8px;border:1px solid #8993a2;background:transparent;color:inherit;font:13px system-ui}
      .defaultTip{font-size:13px;cursor:pointer}.defaultTip:not([hidden]){display:flex;align-items:center;gap:5px;margin-top:8px}.defaultTip input{margin:0}
      .custom button{flex:0 0 auto;padding:7px 10px}
      .method{display:flex;align-items:center;gap:8px;margin:0 0 9px;font-size:13px}
      .method select{flex:1;min-width:0;background:transparent;color:inherit;border:1px solid #8993a2;border-radius:6px;padding:4px}
      button.alt{background:none;color:inherit;border-color:#dce2ec}
      button.balance{display:block;margin:8px 0 0;padding:2px 0;background:none;border:0;color:inherit;text-decoration:underline;text-underline-offset:3px}
      .qr{width:176px;height:176px;margin:4px auto 12px;background:#fff;border-radius:8px;padding:6px}
      .qr svg{width:100%;height:100%;display:block}
      .address{display:flex;align-items:center;gap:6px} .address button{flex:0;padding:2px 8px;font-weight:400}
    </style><div class="box" role="dialog"></div>`;
    const box = root.querySelector<HTMLElement>('.box')!;
    box.tabIndex = -1;
    box.setAttribute('aria-label', label);
    doc.body.append(popover);
    box.focus({ preventScroll: true });
    return { box, dialog: popover, show: (html: string) => {
      box.innerHTML = html;
      if (popover === root.host && !root.activeElement) box.focus({ preventScroll: true });
    } };
  }

  // The verified Nostr profile, opened on Iris. The proof is checked first, so a copied claim never links.
  async function openLink(anchor: HTMLElement, handle: string) {
    if (!targets.get(handle)) return;
    const { box, dialog, show } = popoverAt(anchor, 'Nostr profile');
    show('<p>Checking X proof…</p>');
    const reply = await send({ type: 'nostrLink', handle }).catch(() => undefined);
    if (dialog !== popover) return;
    const pubkey = (reply?.value as { pubkey?: string } | undefined)?.pubkey;
    if (!reply?.ok || !pubkey || !/^[0-9a-f]{64}$/.test(pubkey)) {
      box.textContent = reply?.error ?? 'This account has no verified Nostr profile.';
      return;
    }
    show('<p>@' + handle + ' is on Nostr. Their X account proves it.</p><div class="row"><a target="_blank" rel="noopener noreferrer">Open on Iris</a></div>');
    box.querySelector('a')!.setAttribute('href', 'https://iris.to/' + npubEncode(pubkey));
  }

  // "Nostr ↗" next to the Tip button on a profile.
  function nostrButton(handle: string, flower = false) {
    const node = doc.createElement('button');
    node.type = 'button';
    node.setAttribute(MARK, handle);
    if (flower) node.innerHTML = FLOWER;
    else node.textContent = 'Nostr ↗';
    node.title = 'Open @' + handle + '’s Nostr profile';
    node.setAttribute('aria-label', node.title);
    node.style.cssText = 'display:inline-flex;align-items:center;cursor:pointer;color:inherit;white-space:nowrap;' + PILL;
    if (flower) node.style.cssText += ';width:22px;height:22px;margin-left:3px;padding:2px;border:0;justify-content:center;flex-shrink:0';
    node.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      event.preventDefault();
      event.stopPropagation();
      void openLink(node, handle);
    });
    return node;
  }

  async function open(anchor: HTMLElement, handle: string, post: Post | undefined, quickError?: string) {
    const target = targets.get(handle);
    if (!target) return;
    const { box, dialog, show } = popoverAt(anchor, 'Tip');
    function explainFailure() {
      if (!quickError) return;
      const error = doc.createElement('p');
      error.setAttribute('role', 'alert');
      error.textContent = quickError;
      box.prepend(error);
    }
    const key = locationKey({ pubkey: target.pubkey, post: post?.id });
    show('<p>Checking X proof and Lightning address…</p><small></small>');
    explainFailure();
    if (amounts.get(key)) box.querySelector('small')!.textContent = 'You tipped ' + satLabel(amounts.get(key)!);
    const reply = await send({ type: 'tipProfile', handle }).catch(() => undefined);
    if (dialog !== popover) return;
    const recipient = reply?.value as { pubkey: string; lightning: string; walletEnabled?: boolean } | undefined;
    if (!reply?.ok || !recipient?.lightning || recipient.pubkey !== target.pubkey) {
      box.querySelector('p:not([role=alert])')!.textContent = reply?.error ?? 'This account has no current verified Lightning address.';
      return;
    }
    show('<p>Tip @' + handle + ' with Bitcoin</p><div class="row"></div><form class="custom" novalidate><input aria-label="Custom amount in sats" placeholder="Custom amount (sats)" inputmode="numeric" autocomplete="off"><button class="alt" type="submit">Continue</button></form><small class="amountError" role="status"></small><small class="onNostr"></small><small class="address"><span></span><button class="alt">Copy</button></small>');
    explainFailure();
    // Paying the lightning address directly also works, without the zap.
    box.querySelector('.address span')!.textContent = recipient.lightning;
    box.querySelector('.address button')!.addEventListener('click', () => void navigator.clipboard.writeText(recipient.lightning));
    const row = box.querySelector('.row')!;
    let balanceSats: number | undefined;
    let method: HTMLSelectElement | undefined;
    let defaultAmount: HTMLInputElement | undefined;
    if (recipient.walletEnabled) {
      void send({type: 'tipBalance'}).then(result => {
        const sats = result?.value;
        if (dialog !== popover || !row.isConnected || !result?.ok || typeof sats !== 'number' || !Number.isSafeInteger(sats) || sats < 0) return;
        balanceSats = sats;
        if (sats > 0) {
          const label = doc.createElement('label');
          label.className = 'method';
          label.innerHTML = 'Pay with <select><option value="cashu">Cashu wallet</option><option value="external">External wallet</option></select>';
          method = label.querySelector('select')!;
          row.before(label);
          const preference = doc.createElement('label');
          preference.className = 'defaultTip';
          preference.innerHTML = '<input type="checkbox"> Set as default for one-click post tips';
          defaultAmount = preference.querySelector('input')!;
          box.querySelector('.custom')!.after(preference);
          const paymentMethod = method;
          paymentMethod.addEventListener('change', () => {
            preference.hidden = paymentMethod.value !== 'cashu';
          });
        }
        const balance = doc.createElement('button');
        balance.type = 'button';
        balance.className = 'balance';
        balance.textContent = 'Wallet balance · ' + satLabel(sats);
        balance.title = 'Open Cashu wallet';
        balance.addEventListener('click', async event => {
          if (!event.isTrusted) return;
          const opened = await send({type: 'openTipWallet'}).catch(() => undefined);
          if (opened?.ok && dialog === popover) close();
          else balance.textContent = opened?.error ?? 'Could not open wallet';
        });
        box.querySelector('.amountError')!.after(balance);
      }).catch(() => {});
    }
    const currentRate = rate ??= send({ type: 'tipRate', currency })
      .then((reply) => (reply?.ok && typeof reply.value === 'number' ? reply.value : null))
      .catch(() => null);
    const history = (invoice?: string) => send({ type: 'tipPost', handle,
      ...(post && { post: post.id, time: post.time, text: post.text }), ...(invoice && { invoice }),
    }).then(reply => reply?.ok ? reply.value as TipSummary : undefined).catch(() => undefined);
    function display(found: TipSummary, perBitcoin: number | null) {
      if (dialog !== popover) return;
      const value = (sats: number) => perBitcoin ? formatFiat(sats * perBitcoin / 1e8, currency) : satLabel(sats);
      const yours = Math.max(found.ownSats || 0, amounts.get(key) ?? 0);
      const others = found.tips - (found.ownTips || 0);
      const parts: string[] = [];
      if (yours) parts.push('You tipped ' + value(yours));
      if (others > 0) parts.push(value(found.sats - (found.ownSats || 0)) + ' from ' + others + (others === 1 ? ' other tip' : ' other tips'));
      const line = box.querySelector('.onNostr');
      if (line) line.textContent = parts.join(' · ') || (found.note ? 'This post is on Nostr.' : '');
      amounts.set(key, yours);
      if (found.tips) totals.set(key, value(found.sats));
      paintAll();
    }
    const line = box.querySelector('.onNostr')!;
    if (amounts.get(key)) line.textContent = 'You tipped ' + satLabel(amounts.get(key)!);
    // Only opening the menu looks up this recipient's Nostr receipts.
    void history().then(found => {
      if (found) { display(found, null); void currentRate.then(perBitcoin => display(found, perBitcoin)); }
    });
    let choosing = false;
    const choose = async (sats: number, label: string) => {
      if (choosing || dialog !== popover) return;
      choosing = true;
      const selected = method?.value;
      const setDefault = selected === 'cashu' && defaultAmount?.checked === true;
      const review = selected === 'cashu' && balanceSats !== undefined && sats <= balanceSats;
      show('<p>Getting an invoice…</p>');
      const reply = await send({ type: 'tipInvoice', handle, pubkey: recipient.pubkey, lightning: recipient.lightning, sats, ...(post ? { post: post.id } : {}) }).catch(() => undefined);
      if (dialog !== popover) return;
      const issued = reply?.value as Pick<IssuedInvoice, 'invoice' | 'kind'> | undefined;
      if (!reply?.ok || typeof issued?.invoice !== 'string') {
        box.textContent = '';
        const error = doc.createElement('p');
        error.textContent = reply?.error ?? 'Social Backup is unavailable.';
        box.append(error);
        return;
      }
      const invoice = issued.invoice;
      if (!/^ln[a-z0-9]+$/i.test(invoice)) return show('<p>The invoice is not valid.</p>');
      // The ordinary menu always opens a review before a Cashu payment can proceed.
      let reviewStatus = '';
      if (review) {
        const opened = await send({ type: 'openTipWallet', invoice, ...(setDefault && {setDefault: true}) }).catch(() => undefined);
        if (dialog !== popover) return;
        reviewStatus = opened?.ok ? 'Review this payment in Social Backup.' : opened?.error ?? 'Could not open the wallet. You can use the invoice below.';
      }
      // Scan with a phone wallet, or open the wallet on this computer.
      let image = '';
      try {
        const qr = qrcode(0, 'M');
        qr.addData('LIGHTNING:' + invoice.toUpperCase(), 'Alphanumeric');
        qr.make();
        image = '<div class="qr" role="img" aria-label="Invoice QR code">' + qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true }) + '</div>';
      } catch { /* A long invoice can still be opened or copied. */ }
      show('<p>Pay <b></b> to @' + handle + '</p>' +
        (issued.kind === 'lightning' ? '<small class="kind">Lightning tip · no public zap receipt</small>' : '') +
        (recipient.walletEnabled && selected !== 'external' ? '<button class="cashu">Review in Cashu</button>' : '') +
        image + '<div class="row"><a>Open wallet</a><button class="alt">Copy invoice</button></div><small role="status"></small>');
      box.querySelector('b')!.textContent = label;
      box.querySelector('[role=status]')!.textContent = reviewStatus;
      box.querySelector('a')!.setAttribute('href', 'lightning:' + invoice);
      box.querySelector('.alt')!.addEventListener('click', () => void navigator.clipboard.writeText(invoice));
      const cashu = box.querySelector<HTMLButtonElement>('.cashu');
      cashu?.addEventListener('click', async () => {
        cashu.disabled = true;
        const opened = await send({ type: 'openTipWallet', invoice, ...(setDefault && {setDefault: true}) }).catch(() => undefined);
        cashu.disabled = false;
        const status = box.querySelector('[role=status]');
        if (status) status.textContent = opened?.ok ? 'Review this payment in Social Backup.' : opened?.error ?? 'Could not open the wallet.';
      });
      // A new tip by someone else is never evidence that this particular invoice was paid.
      let remaining = 24;
      const check = async () => {
        if (dialog !== popover) return;
        const found = await history(invoice);
        if (dialog !== popover) return;
        if (found) {
          display(found, await currentRate);
          if (found.paid) return show('<p>Your tip arrived.</p>');
        }
        if (--remaining > 0) poll = setTimeout(() => void check(), 5000);
      };
      poll = setTimeout(() => void check(), 5000);
    };
    const form = box.querySelector<HTMLFormElement>('.custom')!, input = form.querySelector('input')!;
    form.addEventListener('submit', event => {
      event.preventDefault();
      const raw = input.value.trim(), sats = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(sats) || sats < 1 || sats > 1_000_000) {
        input.setAttribute('aria-invalid', 'true');
        box.querySelector('.amountError')!.textContent = 'Enter a whole number from 1 to 1,000,000 sats.';
        input.focus();
        return;
      }
      void choose(sats, satLabel(sats));
    });
    input.addEventListener('input', () => {
      input.removeAttribute('aria-invalid');
      box.querySelector('.amountError')!.textContent = '';
    });
    void currentRate.then((perBitcoin) => {
      if (dialog !== popover || !row.isConnected) return;
      if (!perBitcoin) rate = undefined;
      const presets = perBitcoin ? tipPresets(currency, perBitcoin).map(({ sats, fiat }) => ({ sats, label: formatFiat(fiat, currency) }))
        : [21, 100, 1000].map(sats => ({ sats, label: satLabel(sats) }));
      presets.forEach(({ sats, label }, i) => {
        const choice = doc.createElement('button');
        choice.textContent = EMOJI[i] + ' ' + label;
        choice.addEventListener('click', () => void choose(sats, label));
        row.append(choice);
      });
    });
  }

  doc.defaultView?.addEventListener('pagehide', close);
  doc.addEventListener('keydown', (event) => event.key === 'Escape' && close());
  doc.addEventListener('click', close);

  /** Adds buttons for known targets and asks about new handles. `own` is the user's X handle. */
  function scan(own = '', tipsEnabled = true) {
    const articles = tipsEnabled ? postArticles(doc) : [];
    // Paths like /home look like profiles; a profile page also shows the profile name header.
    const name = tipsEnabled ? doc.querySelector('[data-testid="UserName"]') : null;
    const profile = name ? profileHandle(doc.location?.href) : undefined;
    const cells = followingHandle(doc.location?.href)
      ? Array.from(doc.querySelectorAll('[data-testid="primaryColumn"] [data-testid="UserCell"]')) : [];
    const rows = cells.map(cell => {
      const link = Array.from(cell.querySelectorAll('a[href]')).find(a =>
        a.textContent?.trim() && profileHandle(a.getAttribute('href') ?? ''));
      return { cell, link, handle: profileHandle(link?.getAttribute('href') ?? '') };
    });
    const handles = new Set([...articles.map(author), profile, ...rows.map(row => row.handle)].filter((h): h is string => !!h));
    const now = Date.now();
    const unknown = [...handles]
      .filter((h) => !asking.has(h) && (retryAt.get(h) ?? 0) <= now)
      .slice(0, 50);
    if (unknown.length) {
      for (const handle of unknown) asking.add(handle);
      const active = generation;
      send({ type: 'tipTargets', handles: unknown })
        .then((reply) => {
          if (active !== generation) return;
          const found = reply?.ok ? (reply.value as Record<string, TipTarget | null>) : {};
          for (const handle of unknown) {
            if (Object.hasOwn(found, handle) && found[handle]) targets.set(handle, found[handle]);
            else targets.delete(handle);
            retryAt.set(handle, Date.now() + 60000);
          }
        })
        .catch(() => {
          if (active === generation) for (const handle of unknown) retryAt.set(handle, Date.now() + 60000);
        })
        .finally(() => {
          if (active === generation) {
            for (const handle of unknown) asking.delete(handle);
            scan(own, tipsEnabled);
          }
        });
    }
    for (const { cell, link, handle } of rows) {
      const existing = cell.querySelector('button[' + MARK + ']');
      const known = handle && targets.get(handle);
      if (existing && (!known || existing.getAttribute(MARK) !== handle)) {
        if (existing.parentElement) restoreFollowingRow(existing.parentElement);
        existing.remove();
      }
      const row = link?.parentElement;
      if (known && row && handle && !cell.querySelector('button[' + MARK + ']')) {
        if (!followingRows.has(row)) followingRows.set(row, { direction: row.style.flexDirection, align: row.style.alignItems });
        row.style.flexDirection = 'row';
        row.style.alignItems = 'center';
        row.append(nostrButton(handle, true));
      }
    }
    for (const row of followingRows.keys()) if (!row.isConnected) restoreFollowingRow(row);
    const visible: TipLocation[] = [];
    for (const article of articles) {
      const handle = author(article), target = handle && targets.get(handle), post = postInfo(article);
      const existing = Array.from(article.querySelectorAll<HTMLElement>('button[' + MARK + ']')).find(b => b.closest('article') === article);
      // X can reuse an article element for a different post while scrolling.
      const current = existing && target && handle !== own && existing.getAttribute(MARK) === handle && existing.getAttribute(POST) === (post?.id ?? null);
      if (existing && !current) existing.remove();
      if (!target || !handle || handle === own) continue;
      if (post) visible.push({ pubkey: target.pubkey, post: post.id });
      if (current) continue;
      const bar = Array.from(article.querySelectorAll('[role="group"]')).filter((g) => g.closest('article') === article).at(-1);
      (bar ?? article).append(button(handle, post, 'post', article, bar ?? article));
    }
    // On the name row, after the name and badges, rather than on a line of its own.
    if (name) for (const old of name.querySelectorAll('button[' + MARK + ']'))
      if (old.getAttribute(MARK) !== profile) old.remove();
    const profileTarget = profile && targets.get(profile);
    if (profileTarget) visible.push({ pubkey: profileTarget.pubkey });
    if (name && profile && profileTarget && !name.querySelector(`[${MARK}]`)) {
      const row = name.firstElementChild ?? name;
      row.append(button(profile, undefined, 'profile'));
      if (profile !== own) row.append(nostrButton(profile));
    }
    markVisible(visible);
  }
  function reset(nextQuickTip?: CaptureConfig['quickTip']) {
    for (const row of followingRows.keys()) restoreFollowingRow(row);
    quickTip = nextQuickTip;
    cancelGesture();
    started.clear();
    close();
    targets.clear();
    asking.clear();
    checked.clear();
    checking.clear();
    amounts.clear();
    totals.clear();
    retryAt.clear();
    for (const node of doc.querySelectorAll('[' + MARK + ']')) node.remove();
    generation++;
  }
  // The currency chosen in the Tips settings; nothing chosen follows the browser's region.
  function useCurrency(chosen?: string) {
    const next = tipCurrency(chosen, navigator.languages ?? []);
    if (next === currency) return;
    currency = next;
    rate = undefined;
    totals.clear();
  }
  function useQuickTip(next: CaptureConfig['quickTip']) {
    if (quickTip?.account === next?.account && quickTip?.sats === next?.sats) return;
    reset(next);
  }
  return { scan, reset, useCurrency, useQuickTip };
}
