import type { CaptureConfig } from './types.ts';
import { capturePosts } from './x.ts';

const api = globalThis.browser ?? chrome;
let config: CaptureConfig | undefined,
  timer: ReturnType<typeof setTimeout> | undefined,
  busy = false,
  again = false;
const seen = new Map();
async function scan() {
  if (busy) {
    again = true;
    return;
  }
  if (!config?.capture) return;
  busy = true;
  try {
    const posts = capturePosts(document, location.href, config.handle)
      .filter((p) => seen.get(p.id) !== p.text)
      .slice(0, 50);
    if (posts.length) {
      const reply = await api.runtime.sendMessage({
        type: 'capture',
        posts,
        account: config.pubkey,
      });
      if (reply?.ok) for (const p of posts) seen.set(p.id, p.text);
      if (seen.size > 2000) seen.delete(seen.keys().next().value!);
      if (posts.length === 50) again = true;
    }
  } catch {
    /* A suspended/reloaded extension can retry the visible articles. */
  } finally {
    busy = false;
    if (again) {
      again = false;
      schedule();
    }
  }
}
function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = undefined;
    void scan();
  }, 250);
}
async function configure() {
  const reply = await api.runtime.sendMessage({ type: 'captureConfig' });
  config = reply?.ok ? reply.value : undefined;
  seen.clear();
  schedule();
}
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) void configure();
});
new MutationObserver(schedule).observe(document.documentElement, {
  childList: true,
  subtree: true,
  characterData: true,
  attributes: true,
  attributeFilter: ['href', 'datetime', 'data-testid', 'src', 'poster'],
});
addEventListener('popstate', schedule);
void configure();
