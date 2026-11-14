import type { Message, TipTarget } from './types.ts';
import { profileHandle, xPermalink } from './x.ts';
import { formatFiat, localCurrency, tipPresets } from './rates.ts';
import qrcode from 'qrcode-generator';
import { npubEncode } from 'nostr-tools/nip19';

// Adds a quiet Social Backup flower button to X posts and a "Tip" button to profiles with a local Nostr link claim.
// Proof and address are checked on click.
// Paying happens in the user's own wallet via a lightning: link.

type Send = (message: Message) => Promise<{ ok: boolean; value?: unknown; error?: string } | undefined>;
// Small, medium and large tips, with Iris's emoji.
const EMOJI = ['👍', '💯', '🔥'];
const MARK = 'data-social-backup-tip';
const POST = 'data-social-backup-post';
// The Social Backup forget-me-not (ui/icon.svg), with IDs that cannot clash with X's page.
const FLOWER =
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
  // A miss can be checked locally again after a directory refresh.
  const retryAt = new Map<string, number>();
  let generation = 0;
  let popover: HTMLElement | undefined;
  // One fiat rate per page, for showing tip amounts in the user's currency.
  const currency = localCurrency(navigator.languages ?? []);
  let rate: Promise<number | null> | undefined;
  // Tips found for a post after its popover was opened, shown on its button for the rest of the visit.
  const totals = new Map<string, string>();
  const showTotal = (handle: string, post: string, label: string) => {
    totals.set(handle + ':' + post, label);
    for (const node of doc.querySelectorAll(`[${MARK}="${handle}"][${POST}="${post}"] span`)) node.textContent = label;
  };

  function close() {
    popover?.remove();
    popover = undefined;
  }
  function button(handle: string, post: Post | undefined, own: boolean, placement: 'profile' | 'post') {
    const node = doc.createElement('button');
    node.type = 'button';
    node.setAttribute(MARK, handle);
    if (post) node.setAttribute(POST, post.id);
    node.innerHTML = FLOWER + '<span></span>';
    // Like X's own action bar, posts show the icon and a number only once there is one; profiles say "Tip".
    node.querySelector('span')!.textContent = (post && totals.get(handle + ':' + post.id)) || (placement === 'profile' ? 'Tip' : '');
    node.title = own ? 'People with Social Backup can tip you here' : 'Tip @' + handle + ' with Bitcoin';
    node.setAttribute('aria-label', node.title);
    node.style.cssText = 'display:inline-flex;align-items:center;gap:4px;cursor:pointer;color:inherit;white-space:nowrap;' +
      (placement === 'profile'
        ? 'background:transparent;border:1px solid currentColor;border-radius:999px;font:600 13px/1 system-ui;padding:5px 10px;margin-inline-start:4px'
        : 'background:none;border:0;font:13px/1 system-ui;padding:0 10px');
    node.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      open(node, handle, post, own);
    });
    return node;
  }

  // An empty popover below `anchor`, in its own shadow DOM so X's styles and ours never mix.
  function popoverAt(anchor: HTMLElement, label: string) {
    close();
    popover = doc.createElement('div');
    const rect = anchor.getBoundingClientRect();
    // Below the button, centred on it, and always inside the window.
    const width = 268, view = doc.defaultView;
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), (view?.innerWidth ?? 1024) - width - 8);
    popover.style.cssText = `position:fixed;z-index:2147483647;top:${Math.round(rect.bottom + 6)}px;left:${Math.round(left)}px`;
    // Clicks inside the popover never reach X or the close-on-outside-click handler.
    popover.addEventListener('click', (event) => event.stopPropagation());
    const root = popover.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      .box{font:14px/1.4 system-ui,sans-serif;background:#fff;color:#1c2434;border:1px solid #dce2ec;border-radius:12px;
        padding:12px 14px;width:240px;box-shadow:0 8px 24px #0002}
      @media (prefers-color-scheme:dark){.box{background:#181c26;color:#e9ecf3;border-color:#2a3142}}
      p{margin:0 0 10px} small{opacity:.7;display:block;margin-top:8px} small:empty{display:none}
      .row{display:flex;gap:6px}
      button,a{flex:1;font:600 13px system-ui;border-radius:8px;padding:7px 0;cursor:pointer;
        text-align:center;text-decoration:none;border:1px solid #2a4fbd;background:#2a4fbd;color:#fff}
      button.alt{background:none;color:inherit;border-color:#dce2ec}
      .qr{width:176px;height:176px;margin:4px auto 12px;background:#fff;border-radius:8px;padding:6px}
      .qr svg{width:100%;height:100%;display:block}
      .address{display:flex;align-items:center;gap:6px} .address button{flex:0;padding:2px 8px;font-weight:400}
    </style><div class="box" role="dialog"></div>`;
    const box = root.querySelector('.box')!;
    box.setAttribute('aria-label', label);
    doc.body.append(popover);
    return { box, dialog: popover, show: (html: string) => (box.innerHTML = html) };
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
  function nostrButton(handle: string) {
    const node = doc.createElement('button');
    node.type = 'button';
    node.setAttribute(MARK, handle);
    node.textContent = 'Nostr ↗';
    node.title = 'Open @' + handle + '’s Nostr profile';
    node.setAttribute('aria-label', node.title);
    node.style.cssText = 'display:inline-flex;align-items:center;cursor:pointer;color:inherit;white-space:nowrap;background:transparent;' +
      'border:1px solid currentColor;border-radius:999px;font:600 13px/1 system-ui;padding:5px 10px;margin-inline-start:4px';
    node.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void openLink(node, handle);
    });
    return node;
  }

  async function open(anchor: HTMLElement, handle: string, post: Post | undefined, own: boolean) {
    const target = targets.get(handle);
    if (!target) return;
    const { box, dialog, show } = popoverAt(anchor, 'Tip');
    show('<p>Checking X proof and Lightning address…</p>');
    const reply = await send({ type: 'tipProfile', handle }).catch(() => undefined);
    if (dialog !== popover) return;
    const recipient = reply?.value as { pubkey: string; lightning: string } | undefined;
    if (!reply?.ok || !recipient?.lightning) {
      box.textContent = reply?.error ?? 'This account has no verified Lightning address.';
      return;
    }
    if (own) {
      box.textContent = '';
      const text = doc.createElement('p');
      text.textContent = 'Tips for your posts go to ' + recipient.lightning + '.';
      box.append(text);
    } else {
      show('<p>Tip @' + handle + ' with Bitcoin</p><div class="row"></div><small class="onNostr"></small><small>Sent as a Nostr zap from your wallet.</small><small class="address"><span></span><button class="alt">Copy</button></small>');
      // Paying the lightning address directly also works, without the zap.
      box.querySelector('.address span')!.textContent = recipient.lightning;
      box.querySelector('.address button')!.addEventListener('click', () => void navigator.clipboard.writeText(recipient.lightning));
      const row = box.querySelector('.row')!;
      const currentRate = rate ??= send({ type: 'tipRate', currency })
        .then((reply) => (reply?.ok && typeof reply.value === 'number' ? reply.value : null))
        .catch(() => null);
      // How many tips the post had when the popover opened, to notice a new one arriving.
      let tipped: number | undefined;
      // Only a click looks for the author's Nostr copy. The X URL stays local.
      if (post)
        void send({ type: 'tipPost', handle, post: post.id, ...(post.time ? { time: post.time } : {}), ...(post.text ? { text: post.text } : {}) })
          .then((reply) => {
            const found = reply?.ok ? (reply.value as { note?: string; sats: number; tips: number }) : undefined;
            const line = box.querySelector('.onNostr');
            if (!found?.note || !line) return;
            tipped = found.tips;
            const show = (perBitcoin: number | null) => {
              line.textContent = found.tips
                ? 'On Nostr · ' + (perBitcoin ? formatFiat(found.sats * perBitcoin / 1e8, currency) + ' from ' : '') + found.tips + (found.tips === 1 ? ' tip' : ' tips')
                : 'This post is on Nostr.';
              if (found.tips && perBitcoin) showTotal(handle, post.id, formatFiat(found.sats * perBitcoin / 1e8, currency));
            };
            void currentRate.then(show);
          })
          .catch(() => {});
      void currentRate.then((perBitcoin) => {
        if (!perBitcoin) {
          rate = undefined;
          row.textContent = 'Exchange rate unavailable.';
          return;
        }
        tipPresets(currency, perBitcoin).forEach(({ sats, fiat }, i) => {
          const label = formatFiat(fiat, currency);
          const choice = doc.createElement('button');
          choice.textContent = EMOJI[i] + ' ' + label;
          choice.addEventListener('click', async () => {
            show('<p>Getting an invoice…</p>');
            const reply = await send({ type: 'tipInvoice', handle, pubkey: recipient.pubkey, lightning: recipient.lightning, sats, ...(post ? { post: post.id } : {}) }).catch(() => undefined);
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
            show('<p>Pay <b></b> in your wallet.</p><div class="qr" role="img" aria-label="Invoice QR code">' +
              qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true }) +
              '</div><div class="row"><a>Open wallet</a><button class="alt">Copy invoice</button></div>');
            box.querySelector('b')!.textContent = label;
            box.querySelector('a')!.setAttribute('href', 'lightning:' + invoice);
            box.querySelector('button')!.addEventListener('click', () => void navigator.clipboard.writeText(invoice));
            // While the invoice is open, check this post's tips every few seconds to notice the payment.
            if (post) void (async () => {
              for (let i = 0; i < 24 && dialog === popover; i++) {
                await new Promise((resolve) => setTimeout(resolve, 5000));
                if (dialog !== popover) return;
                const reply = await send({ type: 'tipPost', handle, post: post.id, ...(post.time ? { time: post.time } : {}), ...(post.text ? { text: post.text } : {}) }).catch(() => undefined);
                const found = reply?.ok ? (reply.value as { note?: string; sats: number; tips: number }) : undefined;
                if (!found || dialog !== popover) continue;
                if (tipped === undefined) tipped = found.tips;
                if (found.tips <= tipped) continue;
                show('<p>Thanks! Your tip arrived.</p>');
                const perBitcoin = await currentRate;
                if (perBitcoin) showTotal(handle, post.id, formatFiat(found.sats * perBitcoin / 1e8, currency));
                return;
              }
            })();
          });
          row.append(choice);
        });
      });
    }
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
      const active = generation;
      send({ type: 'tipTargets', handles: unknown })
        .then((reply) => {
          if (active !== generation) return;
          const found = reply?.ok ? (reply.value as Record<string, TipTarget | null>) : {};
          for (const handle of unknown) {
            if (Object.hasOwn(found, handle) && found[handle]) targets.set(handle, found[handle]);
            else retryAt.set(handle, Date.now() + 60000);
          }
        })
        .catch(() => {})
        .finally(() => {
          for (const handle of unknown) asking.delete(handle);
          if (active === generation) scan(own);
        });
    }
    for (const article of articles) {
      const handle = author(article);
      if (!handle || !targets.get(handle) || article.querySelector(`[${MARK}]`)) continue;
      const bar = Array.from(article.querySelectorAll('[role="group"]')).filter((g) => g.closest('article') === article).at(-1);
      bar?.append(button(handle, postInfo(article), handle === own, 'post'));
    }
    // On the name row, after the name and badges, rather than on a line of its own.
    if (name && profile && targets.get(profile) && !name.querySelector(`[${MARK}]`)) {
      const row = name.firstElementChild ?? name;
      row.append(button(profile, undefined, profile === own, 'profile'));
      if (profile !== own) row.append(nostrButton(profile));
    }
  }
  function reset() {
    close();
    targets.clear();
    retryAt.clear();
    for (const node of doc.querySelectorAll('[' + MARK + ']')) node.remove();
    generation++;
  }
  return { scan, reset };
}
