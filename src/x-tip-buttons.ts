import type { Message, TipTarget } from './types.ts';
import { profileHandle, xPermalink } from './x.ts';
import { fiatLabel, localCurrency } from './rates.ts';
import qrcode from 'qrcode-generator';

// Adds a quiet ⚡ button to X posts and profiles of people with a verified Nostr profile
// that can receive tips. Paying happens in the user's own wallet via a lightning: link.

type Send = (message: Message) => Promise<{ ok: boolean; value?: unknown; error?: string } | undefined>;
// The same presets as Iris.
const AMOUNTS: [number, string][] = [[21, '👍'], [100, '💯'], [1000, '🔥']];
const MARK = 'data-social-backup-tip';

function author(article: Element) {
  for (const link of article.querySelectorAll('[data-testid="User-Name"] a[href]')) {
    if (link.closest('article') !== article) continue;
    // The header links to the author's profile and to the post, which also names the author.
    const href = link.getAttribute('href') ?? '';
    const handle = profileHandle(href) ?? xPermalink(href)?.author;
    if (handle) return handle;
  }
}
// The post's ID, time and opening text, used to find its Nostr copy when a tip popover opens.
interface Post {
  id: string;
  time?: number;
  text?: string;
}
function postInfo(article: Element): Post | undefined {
  const time = Array.from(article.querySelectorAll('a[href] time')).find((t) => t.closest('article') === article);
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
  // Handles without an answer yet, for example while X limits proof checks, wait before asking again.
  const retryAt = new Map<string, number>();
  let popover: HTMLElement | undefined;
  // One fiat rate per page, for showing tip amounts in the user's currency.
  const currency = localCurrency(navigator.languages ?? []);
  let rate: Promise<number | null> | undefined;

  function close() {
    popover?.remove();
    popover = undefined;
  }
  function button(handle: string, post: Post | undefined, own: boolean) {
    const node = doc.createElement('button');
    node.type = 'button';
    node.setAttribute(MARK, handle);
    node.textContent = '⚡';
    node.title = own ? 'People with Social Backup can tip you here' : 'Tip @' + handle + ' with Bitcoin';
    node.setAttribute('aria-label', node.title);
    node.style.cssText =
      'background:none;border:0;cursor:pointer;font-size:16px;line-height:1;padding:0 10px;color:inherit;opacity:.75';
    node.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      open(node, handle, post, own);
    });
    return node;
  }

  function open(anchor: HTMLElement, handle: string, post: Post | undefined, own: boolean) {
    close();
    const target = targets.get(handle);
    if (!target) return;
    popover = doc.createElement('div');
    const rect = anchor.getBoundingClientRect();
    popover.style.cssText = `position:fixed;z-index:2147483647;top:${Math.round(rect.bottom + 6)}px;left:${Math.max(8, Math.round(rect.left - 120))}px`;
    // Clicks inside the popover never reach X or the close-on-outside-click handler.
    popover.addEventListener('click', (event) => event.stopPropagation());
    const root = popover.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      .box{font:14px/1.4 system-ui,sans-serif;background:#fff;color:#1c2434;border:1px solid #dce2ec;border-radius:12px;
        padding:12px 14px;width:240px;box-shadow:0 8px 24px #0002}
      @media (prefers-color-scheme:dark){.box{background:#181c26;color:#e9ecf3;border-color:#2a3142}}
      p{margin:0 0 10px} small{opacity:.7;display:block;margin-top:8px} small:empty{display:none}
      .row{display:flex;gap:6px} button small{display:block;margin:2px 0 0;font-weight:400}
      button,a{flex:1;font:600 13px system-ui;border-radius:8px;padding:7px 0;cursor:pointer;
        text-align:center;text-decoration:none;border:1px solid #2a4fbd;background:#2a4fbd;color:#fff}
      button.alt{background:none;color:inherit;border-color:#dce2ec}
      .qr{width:176px;height:176px;margin:4px auto 12px;background:#fff;border-radius:8px;padding:6px}
      .qr svg{width:100%;height:100%;display:block}
      .address{display:flex;align-items:center;gap:6px} .address button{flex:0;padding:2px 8px;font-weight:400}
    </style><div class="box" role="dialog" aria-label="Tip"></div>`;
    const box = root.querySelector('.box')!;
    const show = (html: string) => (box.innerHTML = html);
    if (own) {
      box.textContent = '';
      const text = doc.createElement('p');
      text.textContent = 'Tips for your posts go to ' + target.lightning + '.';
      box.append(text);
    } else {
      show('<p>Tip @' + handle + ' with Bitcoin</p><div class="row"></div><small class="onNostr"></small><small>Sent as a Nostr zap from your wallet.</small><small class="address"><span></span><button class="alt">Copy</button></small>');
      // Paying the lightning address directly also works, without the zap.
      box.querySelector('.address span')!.textContent = target.lightning;
      box.querySelector('.address button')!.addEventListener('click', () => void navigator.clipboard.writeText(target.lightning));
      const row = box.querySelector('.row')!;
      // Look for this post's Nostr copy now, not while scrolling, so relays only learn about posts you tip.
      if (post)
        void send({ type: 'tipPost', handle, post: post.id, ...(post.time ? { time: post.time } : {}), ...(post.text ? { text: post.text } : {}) })
          .then((reply) => {
            const found = reply?.ok ? (reply.value as { note?: string; sats: number; tips: number }) : undefined;
            const line = box.querySelector('.onNostr');
            if (!found?.note || !line) return;
            line.textContent = found.tips
              ? 'On Nostr · ' + found.sats.toLocaleString() + ' sats from ' + found.tips + (found.tips === 1 ? ' tip' : ' tips')
              : 'This post is on Nostr.';
          })
          .catch(() => {});
      rate ??= send({ type: 'tipRate', currency })
        .then((reply) => (reply?.ok && typeof reply.value === 'number' ? reply.value : null))
        .catch(() => null);
      for (const [sats, emoji] of AMOUNTS) {
        const choice = doc.createElement('button');
        choice.textContent = emoji + ' ' + sats.toLocaleString();
        void rate.then((perBitcoin) => {
          if (!perBitcoin) return;
          const estimate = doc.createElement('small');
          estimate.textContent = fiatLabel(sats, perBitcoin, currency);
          choice.append(estimate);
        });
        choice.addEventListener('click', async () => {
          show('<p>Getting an invoice…</p>');
          const reply = await send({ type: 'tipInvoice', handle, sats, ...(post ? { post: post.id } : {}) }).catch(() => undefined);
          if (!reply?.ok || typeof reply.value !== 'string') {
            box.textContent = '';
            const error = doc.createElement('p');
            error.textContent = reply?.error ?? 'Social Backup is unavailable.';
            box.append(error);
            return;
          }
          const invoice = reply.value;
          if (!/^ln[a-z0-9]+$/i.test(invoice)) return show('<p>The invoice is not valid.</p>');
          // Scan with a phone wallet, or open the wallet on this computer.
          const qr = qrcode(0, 'M');
          qr.addData('lightning:' + invoice);
          qr.make();
          show('<p>Pay ' + sats.toLocaleString() + ' sats in your wallet.</p><div class="qr" role="img" aria-label="Invoice QR code">' +
            qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true }) +
            '</div><div class="row"><a>Open wallet</a><button class="alt">Copy invoice</button></div>');
          box.querySelector('a')!.setAttribute('href', 'lightning:' + invoice);
          box.querySelector('button')!.addEventListener('click', () => void navigator.clipboard.writeText(invoice));
        });
        row.append(choice);
      }
    }
    doc.body.append(popover);
  }

  doc.addEventListener('keydown', (event) => event.key === 'Escape' && close());
  doc.addEventListener('click', close);

  /** Adds buttons for known targets and asks about new handles. `own` is the user's X handle. */
  function scan(own = '') {
    const articles = Array.from(doc.querySelectorAll('article[data-testid="tweet"]'));
    // Paths like /home look like profiles; a profile page also shows the profile name header.
    const name = doc.querySelector('[data-testid="UserName"]');
    const profile = name ? profileHandle(doc.location?.href) : undefined;
    const handles = new Set([...articles.map(author), profile].filter((h): h is string => !!h));
    const now = Date.now();
    const unknown = [...handles]
      .filter((h) => !targets.has(h) && !asking.has(h) && (retryAt.get(h) ?? 0) <= now)
      .slice(0, 50);
    if (unknown.length) {
      for (const handle of unknown) asking.add(handle);
      send({ type: 'tipTargets', handles: unknown })
        .then((reply) => {
          const found = reply?.ok ? (reply.value as Record<string, TipTarget | null>) : {};
          for (const handle of unknown) {
            if (handle in found) targets.set(handle, found[handle]);
            else retryAt.set(handle, Date.now() + 60000);
          }
        })
        .catch(() => {})
        .finally(() => {
          for (const handle of unknown) asking.delete(handle);
          scan(own);
        });
    }
    for (const article of articles) {
      const handle = author(article);
      if (!handle || !targets.get(handle) || article.querySelector(`[${MARK}]`)) continue;
      const bar = Array.from(article.querySelectorAll('[role="group"]')).filter((g) => g.closest('article') === article).at(-1);
      bar?.append(button(handle, postInfo(article), handle === own));
    }
    if (name && profile && targets.get(profile) && !name.querySelector(`[${MARK}]`))
      name.append(button(profile, undefined, profile === own));
  }
  return { scan, targets };
}
