type Loader = (url: string) => Promise<string | undefined>;
const customImage = /^(?:blossom:|htree:\/\/)/i;
const httpDigest = /\/[a-f0-9]{64}(?:\.[a-z0-9]+)?$/i;

export function installBrowserHelper(doc: Document, load: Loader) {
  const pending = new Map<HTMLImageElement, string>();
  const running = new Map<HTMLImageElement, string>();
  const shared = new Map<string, Promise<string | undefined>>();
  let active = 0;

  async function render(img: HTMLImageElement, src: string) {
    let result = shared.get(src);
    if (!result) {
      result = load(src).catch(() => undefined);
      shared.set(src, result);
    }
    try {
      const data = await result;
      if (data && img.isConnected && img.getAttribute('src') === src) img.src = data;
    } finally {
      if (shared.get(src) === result) shared.delete(src);
    }
  }
  function pump() {
    while (active < 3 && pending.size) {
      const [img, src] = pending.entries().next().value!;
      pending.delete(img);
      if (!img.isConnected || img.getAttribute('src') !== src || running.get(img) === src) continue;
      running.set(img, src);
      active++;
      void render(img, src).finally(() => {
        if (running.get(img) === src) running.delete(img);
        active--;
        pump();
      });
    }
  }
  function inspect(img: HTMLImageElement, failed = false) {
    const src = img.getAttribute('src');
    if (!src || src.length > 4096) return;
    if (!customImage.test(src)) {
      // Let ordinary Blossom HTTPS URLs load normally. Rescue a failed src only.
      if (!(failed || (img.complete && !img.naturalWidth)) || !/^https:\/\//i.test(src)) return;
      try {
        const url = new URL(src);
        if ((img.currentSrc && img.currentSrc !== url.href) || !httpDigest.test(url.pathname)) return;
      } catch { return; }
    }
    if (running.get(img) !== src) { pending.set(img, src); pump(); }
  }
  function scan(el: Element) {
    if (el.localName === 'img') inspect(el as HTMLImageElement);
    for (const img of el.querySelectorAll<HTMLImageElement>('img[src]')) inspect(img);
  }

  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') {
        const el = record.target as Element;
        if (el.localName === 'img') inspect(el as HTMLImageElement);
      } else for (const node of record.addedNodes) if (node.nodeType === 1) scan(node as Element);
    }
  });
  observer.observe(doc, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  doc.addEventListener('error', event => {
    const target = event.target as Element | null;
    if (target?.localName === 'img') inspect(target as HTMLImageElement, true);
  }, true);
  if (doc.documentElement) scan(doc.documentElement);
}

if (typeof chrome !== 'undefined' || globalThis.browser) {
  const api = globalThis.browser ?? chrome;
  installBrowserHelper(document, async url => {
    const reply = await api.runtime.sendMessage({ type: 'resolveImage', url });
    return reply.ok ? reply.value : undefined;
  });
}
