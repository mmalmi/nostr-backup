import type { Capture, CaptureConfig, SocialCapture } from './types.ts';
import type { PageReport } from './site-status.ts';
import { captureFollows, capturePosts, followingHandle, followingTotal, profileHandle, proofPostIds } from './x.ts';
import { isProofPost } from './x-identity.ts';

import { captureNetwork, socialProfile } from './social.ts';
import { captureInstagramPosts, createInstagramCollector, instagramPermalink } from './instagram.ts';
import { createFacebookCollector } from './facebook.ts';
import { createTipButtons } from './x-tip-buttons.ts';
import { createSavedMarks } from './saved-marks.ts';

function startCapture() {
  const network = captureNetwork(location.href);
  if (!network) return;
  let collector: { collect(doc: Document, url: string, handle: string): void; stop(): void; busy(): boolean } | undefined;
  const onProfile = (handle: string) => network === 'x' ? profileHandle(location.href) === handle :
    socialProfile(network, location.href) === handle || (network === 'instagram' && !!instagramPermalink(location.href, handle));
  const api = globalThis.browser ?? chrome;
  const tips = network === 'x' ? createTipButtons((message) => api.runtime.sendMessage(message)) : undefined;
  let config: CaptureConfig | undefined;
  // Looks up the page's own posts in the backup on this device, to mark the saved ones. A click on a mark has the
  // extension open the post's public copy.
  const marks = createSavedMarks(
    network,
    (ids) => api.runtime.sendMessage({ type: 'savedPosts', account: config?.pubkey, ids }),
    (id) => void api.runtime.sendMessage({ type: 'openSaved', account: config?.pubkey, id }).catch(() => undefined),
  );
  let configuring = false,
    sending = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let frame: number | undefined;
  const pending = new Map<string, Capture>();
  const seen = new Map<string, { snapshot: string; public: boolean }>();

  // How the backup of the user's own posts on their profile is going, for the dot on the toolbar icon. It is a
  // problem when saving keeps failing, or when nothing is left to do and the backup still lacks posts on the page.
  const GRACE = 15000;
  let failingSince: number | undefined, quietSince: number | undefined;
  let failureReason: string | undefined;
  let lookedAt = 0;
  let report: PageReport = {};
  let healthTimer: ReturnType<typeof setTimeout> | undefined;
  function health() {
    clearTimeout(healthTimer);
    healthTimer = undefined;
    if (!api.runtime?.id) return;
    const now = Date.now();
    // Missing posts stay reported until they are saved. A failure is judged again each time.
    let next: PageReport = report.unsaved ? report : {}, again: number | undefined;
    if (!config?.capture || !onProfile(config.handle)) {
      failingSince = quietSince = undefined;
      next = {};
    } else {
      quietSince = sending || pending.size || collector?.busy() ? undefined : quietSince ?? now;
      const missing = marks.unsaved();
      if (failingSince !== undefined) {
        if (now - failingSince >= GRACE) next = { failed: true, reason: failureReason };
        else again = failingSince + GRACE - now;
      } else if (!missing.length) next = {};
      else if (quietSince !== undefined) {
        const since = quietSince + GRACE;
        if (now < since) again = since - now;
        else if (missing.every((post) => (post.checked ?? 0) >= since)) next = { unsaved: missing.length };
        else {
          // Nothing is left to do: look at the backup once more, and wait for its answer.
          if (lookedAt < since || now - lookedAt > 60000) {
            lookedAt = now;
            marks.refresh(missing.map((post) => post.id));
            schedule();
          }
          again = 1000;
        }
      }
    }
    if (again !== undefined) healthTimer = setTimeout(health, again + 50);
    if (JSON.stringify(next) === JSON.stringify(report)) return;
    report = next;
    api.runtime.sendMessage({ type: 'pageStatus', account: config?.pubkey, ...next }).catch(() => undefined);
  }

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
  // Handles from the user's own X following list, sent once each, to find them on Nostr later.
  const sentFollows = new Set<string>();
  let sentFollowingTotal: number | undefined;
  function sendFollows() {
    const session = config;
    const handles = captureFollows(document, location.href, config?.handle).filter((h) => !sentFollows.has(h)).slice(0, 200);
    const total = followingTotal(document, location.href, config?.handle);
    if (!handles.length && (total === undefined || total === sentFollowingTotal)) return;
    for (const handle of handles) sentFollows.add(handle);
    if (total !== undefined) sentFollowingTotal = total;
    const retry = () => {
      if (config !== session) return;
      for (const handle of handles) sentFollows.delete(handle);
      if (sentFollowingTotal === total) sentFollowingTotal = undefined;
    };
    api.runtime.sendMessage({ type: 'xFollows', account: config?.pubkey, handles, total })
      .then((reply: { ok?: boolean } | undefined) => { if (!reply?.ok) retry(); }, retry);
  }
  // Your X verification post links as soon as it shows on any X page, such as the timeline right after
  // posting. Each post is checked again on X's public page, and retried while X is still publishing it.
  const proofRetry = new Map<string, number>();
  function sendProofs() {
    if (network !== 'x' || !config?.handle || !config.pubkey || config.xLinked) return;
    const pubkey = config.pubkey, session = config;
    for (const id of proofPostIds(document, config.handle, (text) => isProofPost(text, pubkey))) {
      if ((proofRetry.get(id) ?? 0) > Date.now()) continue;
      proofRetry.set(id, Date.now() + 30000);
      api.runtime.sendMessage({ type: 'xProof', id }).then((reply: { ok?: boolean } | undefined) => {
        if (reply?.ok && config === session) session.xLinked = true;
      }, () => {});
    }
  }
  function collect() {
    sendProofs();
    if (network === 'x' && config?.handle) {
      sendFollows();
      if (followingHandle(location.href) === config.handle) return;
    }
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
          failureReason = reply?.error;
          failingSince ??= Date.now();
          retryLater();
          break;
        }
        failingSince = undefined;
        if (session !== config) break;
        for (const post of posts) {
          const snapshot = JSON.stringify(post);
          if (JSON.stringify(pending.get(post.id)) === snapshot) pending.delete(post.id);
          seen.set(post.id, { snapshot, public: post.visibility === 'public' });
        }
        marks.refresh(posts.map((post) => post.id));
        schedule();
        while (seen.size > 2000) seen.delete(seen.keys().next().value!);
      }
    } catch {
      failureReason = 'Reload this page to reconnect to Social Backup.';
      failingSince ??= Date.now();
      retryLater();
    } finally {
      sending = false;
      if (session !== config) schedule();
      health();
    }
  }
  // Posts are looked up to mark them, and on the user's profile also to see that they get saved.
  function look() {
    if (!config) return;
    if (config.marks || (config.capture && onProfile(config.handle))) marks.scan(config.handle, !!config.marks);
    health();
  }

  function schedule() {
    if (frame !== undefined || (!config?.handle && !config?.tips)) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      collect();
      if (config) tips?.scan(config.handle, config.tips);
      look();
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
      const reply = await api.runtime.sendMessage({ type: 'captureConfig', ...report });
      if (!reply?.ok) {
        retryLater();
        return;
      }
      const next = reply.value;
      const quickTip = next.tips && next.quickTip?.account === next.pubkey ? next.quickTip : undefined;
      if (
        !config ||
        config.capture !== next.capture ||
        config.tips !== next.tips ||
        config.marks !== next.marks ||
        config.tipCurrency !== next.tipCurrency ||
        config.pubkey !== next.pubkey ||
        config.handle !== next.handle
      ) {
        tips?.reset(quickTip);
        tips?.useCurrency(next.tipCurrency);
        marks.reset();
        pending.clear();
        seen.clear();
        sentFollows.clear();
        sentFollowingTotal = undefined;
        collector?.stop();
        collector = undefined;
        failingSince = failureReason = undefined;
        config = next;
        if (next.capture && network !== 'x') {
          const accept = (posts: SocialCapture[]) => { if (config === next) enqueue(posts); };
          collector = network === 'instagram' ? createInstagramCollector(accept) : createFacebookCollector(accept);
        }
      } else tips?.useQuickTip(quickTip);
      collect();
      if (config) tips?.scan(config.handle, config.tips);
      look();
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

// An already-open tab can still have the previous capture script attached.
if (!globalThis.socialBackupCapture && !globalThis.nostrBackupCapture) {
  globalThis.socialBackupCapture = true;
  startCapture();
}
