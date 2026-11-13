import type { Capture, CaptureConfig, SocialCapture } from './types.ts';
import { capturePosts, profileHandle } from './x.ts';

import { captureNetwork, socialProfile } from './social.ts';
import { captureInstagramPosts, createInstagramCollector, instagramPermalink } from './instagram.ts';
import { createFacebookCollector } from './facebook.ts';

function startCapture() {
  const network = captureNetwork(location.href);
  if (!network) return;
  let collector: { collect(doc: Document, url: string, handle: string): void; stop(): void } | undefined;
  const onProfile = (handle: string) => network === 'x' ? profileHandle(location.href) === handle :
    socialProfile(network, location.href) === handle || (network === 'instagram' && !!instagramPermalink(location.href, handle));
  const api = globalThis.browser ?? chrome;
  let config: CaptureConfig | undefined;
  let configuring = false,
    sending = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let frame: number | undefined;
  const pending = new Map<string, Capture>();
  const seen = new Map<string, { snapshot: string; public: boolean }>();

  function enqueue(posts: Capture[]) {
    if (!config?.capture || !onProfile(config.handle)) return;
    for (const post of posts) {
      if (post.author !== config.handle) continue;
      const saved = seen.get(post.id);
      if (post.visibility === 'unknown' &&
          (saved?.public || pending.get(post.id)?.visibility === 'public')) continue;
      const key = JSON.stringify(post);
      if (saved?.snapshot !== key) pending.set(post.id, post);
    }
    if (!sending && !retry && pending.size) void flush();
  }
  function collect() {
    if (!config?.capture || !onProfile(config.handle)) {
      pending.clear();
      return;
    }
    // Snapshot mounted rows while a previous batch may still be saving.
    if (network === 'x') {
      enqueue(capturePosts(document, location.href, config.handle));
    } else {
      if (network === 'instagram') enqueue(captureInstagramPosts(document, location.href, config.handle));
      collector?.collect(document, location.href, config.handle);
    }
  }

  function retryLater() {
    if (retry || !api.runtime?.id) return;
    retry = setTimeout(() => {
      retry = undefined;
      void configure();
    }, 1500);
  }

  async function flush() {
    sending = true;
    const session = config;
    try {
      while (
        pending.size &&
        session?.capture &&
        session === config &&
        onProfile(session.handle)
      ) {
        const posts = Array.from(pending.values()).slice(0, 50);
        const reply = await api.runtime.sendMessage({
          type: 'capture',
          account: session.pubkey,
          posts,
        });
        if (!reply?.ok) {
          retryLater();
          break;
        }
        if (session !== config) break;
        for (const post of posts) {
          const snapshot = JSON.stringify(post);
          if (JSON.stringify(pending.get(post.id)) === snapshot) pending.delete(post.id);
          seen.set(post.id, { snapshot, public: post.visibility === 'public' });
        }
        while (seen.size > 2000) seen.delete(seen.keys().next().value!);
      }
    } catch {
      retryLater();
    } finally {
      sending = false;
      if (session !== config) schedule();
    }
  }

  function schedule() {
    if (frame !== undefined || !config?.capture) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      collect();
    });
  }

  let refreshAgain = false;
  async function configure() {
    if (configuring) {
      refreshAgain = true;
      return;
    }
    configuring = true;
    try {
      const reply = await api.runtime.sendMessage({ type: 'captureConfig' });
      if (!reply?.ok) {
        retryLater();
        return;
      }
      const next = reply.value;
      if (
        !config ||
        config.capture !== next.capture ||
        config.pubkey !== next.pubkey ||
        config.handle !== next.handle
      ) {
        pending.clear();
        seen.clear();
        collector?.stop();
        collector = undefined;
        config = next;
        if (next.capture && network !== 'x') {
          const accept = (posts: SocialCapture[]) => { if (config === next) enqueue(posts); };
          collector = network === 'instagram' ? createInstagramCollector(accept) : createFacebookCollector(accept);
        }
      }
      collect();
    } catch {
      retryLater();
    } finally {
      configuring = false;
      if (refreshAgain) {
        refreshAgain = false;
        void configure();
      }
    }
  }

  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settingsChanged) void configure();
  });
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['href', 'datetime', 'data-testid', 'src', 'poster', 'aria-label', 'title', 'srcset'],
  });
  addEventListener('scroll', schedule, { capture: true, passive: true });
  addEventListener('popstate', () => void configure());
  addEventListener('pageshow', () => void configure());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void configure();
  });
  // Also handles SPA navigation between two timelines which leave the article tree mounted.
  addEventListener('focus', () => void configure());
  void configure();
}

if (!globalThis.nostrBackupCapture) {
  globalThis.nostrBackupCapture = true;
  startCapture();
}
