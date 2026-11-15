import type {
  Archive,
  Message,
  Sign,
  Status,
  Result,
  Action,
  RelayProgress,
  RelayPoll,
  RelayStatus,
  LastRun,
  SocialCapture,
  Capture,
  Settings,
  TipTarget,
  XLink,
} from './types.ts';
import type { EventTemplate, Event as NostrEvent } from 'nostr-tools/pure';
import { normalizeURL } from 'nostr-tools/utils';
import type { Sender } from './platform.d.ts';
import type { ImportOptions, ImportResult } from './relays.ts';
import { errorMessage, type NewProfile } from './types.ts';
import { imageDataURL, resolveImage } from './helper-images.ts';
import { readCooldown, readPointer, readRoot } from './archive.ts';
import { noteEncode, nsecEncode } from 'nostr-tools/nip19';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { ArchiveEventBus, archiveRouter, localArchive } from './archive-event-bus.ts';
import { SimplePool } from 'nostr-tools/pool';
import { checkXProof, contactsTemplate, xClaims, XRateLimited, identityTemplate, IDENTITY_KIND, isProofPost } from './x-identity.ts';
import { directoryAuthors, directoryClaims, saveDirectory, verifiedTarget } from './x-directory.ts';
import { compareEvents } from './reconcile.ts';
import { lightningAddress, matchingNote, payInfo, tipInvoice, zapTotal } from './x-tips.ts';
import { paymentConsent } from './tip-consent.ts';
import { coinbaseRate, FRESH_SECONDS, snortRate, SNORT_RATES, TIP_CURRENCIES } from './rates.ts';
import { openArchive, queueBroadcast, stagePosts, saveSocialCaptures, savedPosts } from './archive.ts';
import { deliverPending } from './broadcast.ts';
import { relaySource, RelayRateLimitError, retryRelayOutbox } from 'nostr-pubsub';
import { createUploadAuth } from 'nostr-tools/nipb7';
import { DEFAULT_BLOSSOM_SERVER, blossomOrigin, mediaServers, publicMediaURL } from './media-refs.ts';
import { DEFAULT_MEDIA_MIB, accountFetch, backupMedia } from './media-files.ts';
import { captureNetwork, captureSites, socialProfile, socialSettings, socialTemplate, canDeliverCapture, validateSocialPost } from './social.ts';
import { siteBadge, siteState, type PageReport, type TabReport } from './site-status.ts';
import { instagramPermalink } from './instagram.ts';
import { applyQuotes, quoteTargets, resolveQuotes, targetKey } from './quotes.ts';
import { readQuoteOriginal, verifySocialCapture } from './quote-originals.ts';
import { readPublicXOriginal, readPublicXProfile } from './x-audience.ts';
import { shareableMediaHashes } from './legacy-x.ts';
import { identity, hex, unhex, handlePattern, isOwnEvent, parseRelayKinds, relayKindScope, relayList, xTemplate } from './model.ts';
import { deliverBlossom, queueBlossom } from './blossom-sync.ts';
import { xImageURLs, readyXEntry, cacheXImage } from './x-media.ts';
import { findCrossposts } from './x-matches.ts';
import { followingHandle, profileHandle, xPermalink } from './x.ts';
import { readProfile } from './profile.ts';
import { knownFollowers } from './graph-followers.ts';
import { importWithNegentropy, pool, publish, syncHistory } from './relays.ts';
import {
  defaults,
  settings,
  login,
  profileContent,
  accountSettings,
  saveSettings,
  eraseAccount,
} from './accounts.ts';
import { withCopiedImages, expiringImage } from './profile-images.ts';
import { instagramViewer, xProfileLink } from './signed-in.ts';
import { queueIndexPointer, deliverIndexPointer } from './index-pointer.ts';
import { accountRecord, writeAccountRecords } from './account-storage.ts';
import { revokeSession, revokeWebsite, handleSignerRequest, approval } from './signer.ts';

import { savedKey as sessionKey, saveKey, permissions } from './signer-storage.ts';

const api = globalThis.browser ?? chrome;
let changing = false,
  preparing: Promise<void> | undefined,
  indexController: AbortController | undefined,
  recovery: Promise<void> | undefined;
function recover() {
  return (recovery ??= accountRecord('deletingAccount')
    .then(async (deletingAccount) => {
      if (deletingAccount) {
        await revokeSession();
        await saveKey();
        await eraseAccount(deletingAccount);
      } else {
        const { signingKey } = await api.storage.session.get('signingKey');
        if (signingKey && getPublicKey(unhex(signingKey)) === (await settings()).pubkey)
          await saveKey(signingKey);
      }
      await api.storage.session.remove('signingKey');
    })
    .catch((error) => {
      recovery = undefined;
      throw error;
    }));
}
// Tree writes, draft drains and changes to identity configuration use one queue.
// Network waits never hold this queue.
let writer = Promise.resolve(),
  running: Promise<void> | undefined,
  rerun = false,
  syncRequested = false;
let relayOwner = '';
const relayProgress = new Map<string, RelayProgress>();
const idleRelay = (): RelayProgress => ({
  phase: 'idle',
  imported: 0,
  sent: 0,
  present: 0,
  failed: 0,
});
function write<T>(fn: () => T | Promise<T>): Promise<T> {
  if (changing) return Promise.reject(Error('The active profile is changing. Try again.'));
  const result = writer.then(fn);
  writer = result.then(
    () => {},
    () => {},
  );
  return result;
}
async function signDrafts(db: Archive) {
  const conf = await settings(),
    key = await sessionKey();
  if (!key || getPublicKey(unhex(key)) !== conf.pubkey) return;
  const archive = new ArchiveEventBus(db, conf.pubkey, conf.relays);
  const secret = unhex(key);
  let pending = (await db.getAll('drafts')).filter((post) => {
    const account = 'source' in post ? conf.social?.[post.source] : conf;
    return post.visibility === 'public' && account?.capture && account.handle === post.author;
  });
  // Commit each ready layer before resolving quotes in the next. Unrelated
  // drafts can finish even if a quoted original needs media or a later retry.
  while (pending.length && !changing) {
    const waiting: typeof pending = [];
    let committed = 0;
    for (let i = 0; i < pending.length; i += 50) {
      const batch = pending.slice(i, i + 50);
      const plainX = batch.filter(
        (post) => !('source' in post) && !quoteTargets(post, conf).length,
      );
      const matches =
        conf.skipCrossposts === false || !plainX.length
          ? new Map<string, string>()
          : await findCrossposts(db, conf.pubkey, plainX);
      const entries = [];
      for (const post of batch) {
        const references = quoteTargets(post, conf);
        const links = await resolveQuotes(db, references, conf);
        if (!links) {
          waiting.push(post);
          continue;
        }
        if ('source' in post) {
          entries.push({
            event: finalizeEvent(applyQuotes(socialTemplate(post), links, conf.pubkey), secret),
            source: post.source + ':' + post.id,
            posters: post.posters,
          });
        } else {
          const match = matches.get(post.id);
          if (match) {
            const tx = db.transaction(['sources', 'drafts', 'xMatches'], 'readwrite'),
              source = 'x:' + post.id;
            tx.objectStore('sources').put(match, source);
            tx.objectStore('xMatches').put(post, source);
            tx.objectStore('drafts').delete(source);
            await tx.done;
            committed++;
            continue;
          }
          const entry = await readyXEntry(db, post, mediaServers(conf), secret, links, conf.pubkey);
          if (entry) entries.push(entry);
        }
      }
      if (entries.length) {
        await archive.publishBatch(entries);
        committed += entries.length;
      }
    }
    if (!committed) break;
    pending = waiting;
  }
}

let quoteJob: Promise<void> | undefined,
  quoteController: AbortController | undefined,
  quotesAgain = false;
function kickQuotes() {
  if (changing) return;
  if (quoteJob) {
    quotesAgain = true;
    return;
  }
  quoteController = new AbortController();
  quoteJob = fetchMissingOriginals(quoteController.signal)
    .catch((error) => console.error('Quote lookup:', errorMessage(error)))
    .finally(() => {
      quoteJob = undefined;
      quoteController = undefined;
      if (quotesAgain) {
        quotesAgain = false;
        kickQuotes();
      }
    });
}
async function fetchMissingOriginals(signal: AbortSignal) {
  const conf = await settings();
  if (!conf.pubkey || !(await sessionKey())) return;
  const db = await openArchive(conf.archiveName);
  try {
    const targets = new Map<string, ReturnType<typeof quoteTargets>[number]>();
    for (const draft of await db.getAll('drafts')) {
      const account = 'source' in draft ? conf.social?.[draft.source] : conf;
      if (draft.visibility !== 'public' || !account?.capture || account.handle !== draft.author)
        continue;
      for (const q of quoteTargets(draft, conf)) targets.set(targetKey(q), q);
    }
    for (const [key, q] of targets) {
      if (signal.aborted) return;
      const enabled = q.network === 'x' ? conf : conf.social?.[q.network];
      if (!enabled?.capture || changing) continue;
      if (await db.getKey('drafts', key)) continue;
      const existing = await db.get('sources', key);
      if (existing && !(await db.getKey('heldEvents', existing))) continue;
      if (!q.attributed && (await db.get('meta', ['quoteUnowned', q.handle, key]))) continue;
      const retryKey = ['quoteRetry', q.handle, key];
      const retry = (await db.get('meta', retryKey)) as number | undefined;
      if (retry && retry > Date.now()) continue;
      await db.put('meta', Date.now() + 300000, retryKey);
      let original: Awaited<ReturnType<typeof readQuoteOriginal>>;
      try {
        original = await readQuoteOriginal(
          q,
          AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        );
      } catch {
        continue;
      }
      if (signal.aborted) return;
      if (!original) continue;
      const post = original;
      if (changing) return;
      await write(async () => {
        const current = await settings(),
          account = q.network === 'x' ? current : current.social?.[q.network];
        if (
          current.pubkey !== conf.pubkey ||
          account?.handle !== q.handle ||
          !account.capture ||
          !(await sessionKey())
        )
          return;
        if (post === 'other-author') {
          if (q.attributed) return;
          await db.put('meta', 1, ['quoteUnowned', q.handle, key]);
        } else {
          if (post.author !== q.handle || post.id !== q.id || post.visibility !== 'public') return;
          if (q.network !== 'x') {
            const social = post as SocialCapture;
            validateSocialPost(social, q.network, q.handle);
            await saveSocialCaptures(db, [social]);
          } else {
            xTemplate(post, q.handle);
            await stagePosts(db, [post]);
          }
        }
        await signDrafts(db);
        void kick();
      });
    }
  } finally {
    db.close();
  }
}

// Network I/O for images never holds the local writer or a relay pass.
let mediaJob: Promise<void> | undefined,
  mediaController: AbortController | undefined,
  mediaAgain = false;
function kickMedia() {
  if (changing) return;
  if (mediaJob) {
    mediaAgain = true;
    return;
  }
  const controller = new AbortController();
  mediaController = controller;
  mediaJob = processImages(controller.signal)
    .catch((error) => {
      if (!controller.signal.aborted) console.error('X image backup:', errorMessage(error));
    })
    .finally(() => {
      mediaJob = undefined;
      mediaController = undefined;
      if (mediaAgain) {
        mediaAgain = false;
        kickMedia();
      }
    });
}
async function processImages(signal: AbortSignal) {
  const conf = await settings();
  if (!conf.pubkey || !(await sessionKey())) return;
  const servers = mediaServers(conf);
  const db = await openArchive(conf.archiveName);
  try {
    if (conf.social?.instagram?.capture || conf.social?.facebook?.capture) {
      await navigator.locks.request('nostr-backup-media', { ifAvailable: true }, async lock => {
        if (!lock) return;
        await backupMedia(db, {
          signal, fetcher: accountFetch(signal), maxMiB: conf.mediaMiB,
          include: ref => ref.status === 'pending' &&
            ((!!conf.social?.instagram?.capture && ref.eventId.startsWith('instagram:')) ||
             (!!conf.social?.facebook?.capture && ref.eventId.startsWith('facebook:'))),
        });
      });
    }
    const drafts = conf.capture ? (await db.getAll('drafts')).filter(post =>
      !('source' in post) && post.visibility === 'public' && post.author === conf.handle) : [];
    const sources = new Set(drafts.flatMap(post => xImageURLs(post.text)));
    const queuedImages = new Set<string>();
    for (const source of sources) {
      signal.throwIfAborted();
      const hash = await cacheXImage(db, source, servers[0], conf.mediaMiB ?? DEFAULT_MEDIA_MIB, signal);
      if (hash) queuedImages.add(hash);
    }
    await queueBlossom(db, queuedImages, servers, false);
    await deliverBlossom(db, servers, {
      captureHandle: conf.capture ? conf.handle : undefined,
      signal, fetcher: accountFetch(signal),
      async authorize(hash, server) {
        const current = await settings(), key = await sessionKey();
        if (changing || current.pubkey !== conf.pubkey || !mediaServers(current).includes(server) ||
            !key || getPublicKey(unhex(key)) !== conf.pubkey) throw Error('Media settings changed.');
        signal.throwIfAborted();
        return createUploadAuth(async event => finalizeEvent(event, unhex(key)), hash, {
          servers: server, expiration: Math.floor(Date.now()/1000) + 300,
        });
      },
      async onCopy(hash, server, url) {
        if (!queuedImages.has(hash) || !publicMediaURL(server) || !publicMediaURL(url)) return;
        signal.throwIfAborted();
        await write(() => signDrafts(db));
        void kick();
      },
    });
  } finally {
    db.close();
  }
}
// The newest own event of a kind, from the archive or the selected relays.
async function latestOwn(db: Archive, conf: Settings, kind: number) {
  const local = await archiveRouter(db, conf.pubkey).query([{ authors: [conf.pubkey], kinds: [kind], limit: 1 }]);
  const relays = new SimplePool();
  try {
    const remote = conf.relays.length
      ? await relays.querySync(conf.relays, { authors: [conf.pubkey], kinds: [kind] }, { maxWait: 5000 })
      : [];
    return [...local.events.map((row) => row.event), ...remote]
      .filter((event) => event.kind === kind && isOwnEvent(event, conf.pubkey))
      .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
  } finally {
    relays.destroy();
  }
}
// Signs an own non-post event, such as a follow list, archives it and queues it for the relays.
async function publishOwn(db: Archive, conf: Settings, template: EventTemplate) {
  const key = await sessionKey();
  if (!key || getPublicKey(unhex(key)) !== conf.pubkey) throw Error('Unlock your account first.');
  const event = finalizeEvent(template, unhex(key));
  await write(() => new ArchiveEventBus(db, conf.pubkey, conf.relays).publishBatch([{ event, announce: true }]));
  void kick();
}

// Serialize intentional unlink and proof recapture. A withdrawn or older proof stays withdrawn.
let linkWriter: Promise<void> = Promise.resolve();
function updateXLink(db: Archive, conf: Settings, next?: XLink) {
  const change = linkWriter.then(async () => {
    const handle = next?.handle ?? conf.handle;
    const floorKey = ['xProofThrough', handle];
    const prior = await db.get('meta', 'xLink') as XLink | undefined;
    const floor = (await db.get('meta', floorKey) as string[] | undefined)?.[0] ?? '0';
    if (next && (BigInt(next.proof) <= BigInt(floor) || (prior?.handle === handle && BigInt(next.proof) <= BigInt(prior.proof)))) return;
    const previous = await latestOwn(db, conf, IDENTITY_KIND);
    const previousProofs = previous ? xClaims(previous).filter(c => c.handle === handle).map(c => c.proof) : [];
    if (next && previousProofs.some(proof => BigInt(proof) > BigInt(next.proof))) return;
    const template = identityTemplate(previous, next?.handle, next?.proof);
    const current = await settings();
    if (current.pubkey !== conf.pubkey || current.handle !== handle) throw Error('Account settings changed.');
    const key = await sessionKey();
    if (!key || getPublicKey(unhex(key)) !== conf.pubkey) throw Error('Unlock your account first.');
    const event = finalizeEvent(template, unhex(key));
    await write(async () => {
      await new ArchiveEventBus(db, conf.pubkey, conf.relays).publishBatch([{ event, announce: true }]);
      await saveDirectory(db, [event]);
      const tx = db.transaction('meta', 'readwrite');
      if (next) await tx.store.put(next, 'xLink');
      else await tx.store.delete('xLink');
      const latestProof = [floor, next?.proof, prior?.handle === handle ? prior.proof : undefined,
        ...previousProofs]
        .filter((v): v is string => !!v).reduce((a, b) => BigInt(a) > BigInt(b) ? a : b);
      await tx.store.put([latestProof], floorKey);
      await tx.done;
    });
    void kick();
  });
  linkWriter = change.catch(() => {});
  return change;
}

// Process one graph-derived batch per alarm. Page visits never schedule or shape these reads.
async function refreshDirectory(db: Archive, conf: Settings) {
  if (!conf.relays.length) return;
  const stateKey = ['xDirectorySchedule', ...conf.relays];
  const [offset = '0', due = '0'] = (await db.get('meta', stateKey) as string[] | undefined) ?? [];
  if (Date.now() < Number(due)) return;
  const graphKey = ['xDirectoryAuthors', ...conf.relays];
  let authors = Number(offset) ? await db.get('meta', graphKey) as string[] | undefined : undefined;
  if (!authors?.length) {
    authors = directoryAuthors(conf.pubkey, await latestOwn(db, conf, 3));
    await db.put('meta', authors, graphKey);
  }
  const start = Number(offset) < authors.length ? Number(offset) : 0;
  const batch = authors.slice(start, start + 128);
  const rows = (await Promise.all(batch.flatMap(key => [0, IDENTITY_KIND].map(kind =>
    db.get('xDirectory', [key, kind]))))).filter(row => row !== undefined);
  const until = Math.floor(Date.now() / 1000);
  const filter = { kinds: [0, IDENTITY_KIND], authors: batch, since: 0, until };
  await Promise.all(conf.relays.map(async url => {
    if ((await readCooldown(db, url) ?? 0) > Date.now()) return;
    const relays = new SimplePool();
    try {
      let ids: string[] | undefined;
      if (rows.length) {
        try { ids = [...(await compareEvents(url, filter, rows, true)).need]; }
        catch (error) {
          if (error instanceof RelayRateLimitError) return;
          // Relays without NIP-77 can serve the same bounded batch directly.
        }
      }
      // A new key may sit outside the graph. Sample recent public links once per pass,
      // independently of which X accounts have been seen.
      if (start === 0) {
        const recent = await relays.querySync([url], { kinds: [IDENTITY_KIND], limit: 128, until }, { maxWait: 4000 });
        await saveDirectory(db, recent);
      }
      if (ids && !ids.length) return;
      const events = await relays.querySync([url], { ...filter, ...(ids && { ids: ids.slice(0, 256) }), limit: 256 }, { maxWait: 4000 });
      await saveDirectory(db, events.filter(e => batch.includes(e.pubkey)));
    } finally { relays.destroy(); }
  }));
  const next = start + batch.length;
  await db.put('meta', next >= authors.length ? ['0', String(Date.now() + 86400000)] : [String(next), '0'], stateKey);
}
function validTipCurrency(value: unknown) {
  if (value === '') return undefined;
  if (typeof value !== 'string' || !TIP_CURRENCIES.includes(value)) throw Error('Choose a currency for tips.');
  return value;
}

// A whole directory pass in the background, rather than one batch per alarm, once you look for
// the people you follow. Each batch uses the current settings and stops if the account changes.
let warming: Promise<void> | undefined;
function warmDirectory() {
  warming ??= (async () => {
    const owner = (await settings()).pubkey;
    if (changing || !owner) return;
    const db = await openArchive((await settings()).archiveName);
    try {
      for (let batch = 0; batch < 32; batch++) {
        const conf = await settings();
        if (changing || conf.pubkey !== owner || !conf.relays.length) break;
        const [, due = '0'] = ((await db.get('meta', ['xDirectorySchedule', ...conf.relays])) as string[] | undefined) ?? [];
        if (Date.now() < Number(due)) break;
        await updateDirectory(db, conf);
      }
    } finally {
      db.close();
    }
  })().catch(() => {}).finally(() => (warming = undefined));
  return warming;
}
const directoryJobs = new Map<string, Promise<void>>();
function updateDirectory(db: Archive, conf: Settings) {
  const current = directoryJobs.get(db.name);
  if (current) return current;
  const job = refreshDirectory(db, conf).finally(() => directoryJobs.delete(db.name));
  directoryJobs.set(db.name, job);
  return job;
}

const newestProfile = <T extends { kind: number; id: string; pubkey: string; created_at: number }>(events: T[], pubkey: string) =>
  events.filter(e => e.kind === 0 && e.pubkey === pubkey).sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0] as T | undefined;

async function tipTargets(db: Archive, handles: string[]) {
  const result: Record<string, TipTarget | null> = Object.create(null);
  for (const handle of handles) {
    const claim = (await directoryClaims(db, handle))[0];
    result[handle] = claim ? { pubkey: claim.pubkey, proof: claim.proof } : null;
  }
  return result;
}

// The verified Nostr key for an X handle, checked against its current identity list:
// an empty or changed list revokes the link.
async function currentLink(db: Archive, conf: Settings, handle: string) {
  const target = await verifiedTarget(db, handle);
  if (!target) throw Error('This X account has no current verified Nostr link.');
  const pool = new SimplePool();
  try {
    const events = await pool.querySync(conf.relays, { kinds: [0, IDENTITY_KIND], authors: [target.pubkey] }, { maxWait: 4000 });
    await saveDirectory(db, events);
    const claims = await directoryClaims(db, handle);
    if (!claims.some(c => c.pubkey === target.pubkey && c.proof === target.proof))
      throw Error('The Nostr link changed. Try again.');
    return { target, events };
  } finally { pool.destroy(); }
}

async function paymentProfile(db: Archive, conf: Settings, handle: string) {
  const { target, events } = await currentLink(db, conf, handle);
  const profile = newestProfile(events, target.pubkey);
  if (!profile || profile.id !== (await db.get('xDirectory', [target.pubkey, 0]))?.id || !lightningAddress(profile))
    throw Error('No current Lightning address is available for this profile.');
  return profile;
}
// Loaded once per worker, on the first card that needs it.
let followerTable: Promise<Uint8Array> | undefined;
function graphFollowers() {
  followerTable ??= fetch(api.runtime.getURL('graph-followers.bin'))
    .then((response) => response.arrayBuffer())
    .then((data) => new Uint8Array(data))
    .catch((error) => { followerTable = undefined; throw error; });
  return followerTable;
}

const tipAddresses = new Map<string, string>();
const tipNotes = new Map<string, string>();

async function run() {
  const importNow = syncRequested;
  syncRequested = false;
  await recover();
  const conf = await settings();
  if (!conf.pubkey || changing) return;
  relayOwner = conf.pubkey;
  relayProgress.clear();
  const db = await openArchive(conf.archiveName);
  try {
    await write(() => signDrafts(db));
    kickQuotes();
    kickMedia();
    const archive = new ArchiveEventBus(db, conf.pubkey);
    const reports: Record<string, string> = {};
    const pending = (await db.getAll('outbox')).filter((row) => canDeliverCapture(row, conf));
    const pointer = await readPointer(db);
    const imports = new Set<string>();
    const now = Date.now();
    const day = 86400000;
    const scope = relayKindScope(conf.relayKinds);
    const schedulePoll = (url: string, at: number) => db.put('meta', { scope, at }, ['nextPoll', url]);
    for (const url of conf.relays) {
      const cursor = await db.get('cursors', [conf.pubkey, url]);
      const poll = await db.get('meta', ['nextPoll', url]) as RelayPoll | number | undefined;
      let due = 0;
      if (typeof poll === 'object' && poll.scope === scope) due = poll.at;
      else if (cursor?.scope === scope && cursor.through) due = cursor.through * 1000 + day;
      if (importNow || (conf.relaySync && now >= due)) imports.add(url);
    }
    const destinations = conf.relays.filter(
      (url) =>
        imports.has(url) ||
        pending.some((row) => row.relay === url) ||
        pointer?.pending.includes(url),
    );
    if (!destinations.length) return;
    for (const url of destinations) relayProgress.set(url, { ...idleRelay(), phase: 'queued' });
    await retryRelayOutbox(
      destinations,
      {
        deadline: (url) => readCooldown(db, url),
        async defer(url, until) {
          if (imports.has(url)) await schedulePoll(url, until);
          await db.put('meta', until, ['retryAfter', url]);
          await api.alarms.create('relay-retry:' + url, { when: until });
        },
      },
      (url) => runRelay(url).finally(() => pool.close([url])),
      (url, until) => {
        const progress = relayProgress.get(url)!;
        progress.phase = 'retry';
        progress.detail = reports[url] =
          'Rate limited · Retry after ' + new Date(until).toLocaleString();
      },
      (url, error) => {
        const progress = relayProgress.get(url)!;
        progress.phase = 'error';
        progress.detail = reports[url] = errorMessage(error);
      },
    );
    async function runRelay(url: string) {
      const progress = relayProgress.get(url)!;
      const messages = [];
      const importOptions: ImportOptions = {
        db,
        url,
        pubkey: conf.pubkey,
        relayKinds: conf.relayKinds,
        save: async (entries) => {
          const count = await write(async () => {
            if (!(await importOptions.enabled())) return 0;
            return archive.publishBatch(entries, relaySource(url));
          });
          progress.imported += count;
          return count;
        },
        enabled: async () => {
          const current = await settings();
          return (
            !changing &&
            current.pubkey === conf.pubkey &&
            relayKindScope(current.relayKinds) === scope &&
            (current.relaySync || importNow) &&
            current.relays.includes(url)
          );
        },
      };
      const rows = pending.filter((row) => row.relay === url);
      // New captures go out first. Only copies of imported history need the import's inventory.
      const fresh = rows.filter((row) => !row.broadcast),
        copies = rows.filter((row) => row.broadcast);
      const importing = imports.has(url) && (await importOptions.enabled());
      if (importing) await schedulePoll(url, Date.now() + day);
      const publishingIndex = pointer?.pending.includes(url);
      if (importing || rows.length || publishingIndex) {
        progress.phase = 'connecting';
        await pool.ensureRelay(url, { connectionTimeout: 7000 });
      }
      let delivered = { sent: 0, present: 0, failed: 0 };
      const track = (state: { sent: number; present: number; failed: number; error?: string }) => {
        progress.sent = delivered.sent + state.sent;
        progress.present = delivered.present + state.present;
        progress.failed = delivered.failed + state.failed;
        if (state.error) progress.detail = state.error;
      };
      if (fresh.length) {
        progress.phase = 'broadcasting';
        const report = await deliverPending(db, url, fresh, settings, conf.pubkey, undefined, track);
        if (report) messages.push(report);
        delivered = { sent: progress.sent, present: progress.present, failed: progress.failed };
      }
      let imported: ImportResult | undefined;
      if (importing) {
        progress.phase = 'importing';
        try {
          imported = await importWithNegentropy(importOptions);
          if (!imported.report && (await importOptions.enabled())) {
            imported.report = await syncHistory(importOptions);
          }
        } catch (error) {
          if (error instanceof RelayRateLimitError) throw error;
          imported = { report: 'Import: ' + errorMessage(error) };
          progress.failed++;
          progress.detail = errorMessage(error);
        }
      }
      if (
        imported?.report === 'More history queued' ||
        imported?.report?.includes('Incomplete relay response')
      )
        await schedulePoll(url, Date.now() + 300000);
      if (imported?.report) messages.push(imported.report);
      if (copies.length) {
        progress.phase = 'broadcasting';
        delivered = { sent: progress.sent, present: progress.present, failed: progress.failed };
        const report = await deliverPending(db, url, copies, settings, conf.pubkey, imported, track);
        if (report) messages.push(report);
      }
      if (!changing && (await settings()).relays.includes(url)) {
        if (publishingIndex) progress.phase = 'index';
        const receipt = await deliverIndexPointer(db, url, publish);
        if (receipt) messages.push(receipt);
      }
      progress.phase = progress.failed
        ? 'retry'
        : /incomplete|paused|more history/i.test(imported?.report ?? '')
          ? 'partial'
          : importing || rows.length || publishingIndex
            ? 'finished'
            : 'idle';
      reports[url] = messages.join(' · ') || 'Nothing to send.';
      progress.detail ??= reports[url];
    }
    if (!changing) {
      const lastRun = await accountRecord('lastRun');
      const previous = lastRun?.pubkey === conf.pubkey ? lastRun : undefined;
      await writeAccountRecords({
        lastRun: {
          at: Date.now(),
          pubkey: conf.pubkey,
          reports: { ...previous?.reports, ...reports },
          relays: { ...previous?.relays, ...Object.fromEntries(relayProgress) },
        },
      });
    }
  } finally {
    db.close();
  }
}
function kick(importNow = false): Promise<void> | undefined {
  if (changing) return;
  syncRequested ||= importNow;
  if (running) {
    rerun = true;
    return running;
  }
  running = run()
    .catch(async (e) => {
      for (const progress of relayProgress.values()) {
        if (
          ['queued', 'connecting', 'importing', 'broadcasting', 'index'].includes(progress.phase)
        ) {
          progress.phase = 'error';
          progress.detail = errorMessage(e);
        }
      }
      await writeAccountRecords({
        lastRun: { at: Date.now(), reports: { Archive: e.message } },
      });
    })
    .finally(() => {
      pool.destroy();
      running = undefined;
      if (rerun) {
        rerun = false;
        void kick();
      }
    });
  return running;
}
async function configure(msg: Message<'settings'>) {
  const pubkey = identity(msg.pubkey);
  const prev = await accountSettings(pubkey);
  const handle = msg.handle.trim().replace(/^@/, '').toLowerCase();
  if (handle && !handlePattern.test(handle))
    throw Error('Enter your X handle.');
  const relays = relayList(msg.relays);
  const relayKinds = msg.relayKinds === undefined ? prev.relayKinds
    : parseRelayKinds(msg.relayKinds.mode, msg.relayKinds.list);
  const social = socialSettings(msg.social, prev.social);
  // Backup is on by default, but a platform only captures once it has a username.
  const active = (site?: { handle: string; capture: boolean }) => !!site?.capture && !!site.handle;
  const capturing = active({ handle, capture: !!msg.capture });
  const activeSocial = Object.values(social).some(active);
  if (Object.entries(social).some(([site, value]) =>
    active(value) && !active(prev.social?.[site as keyof typeof social])) && !(await sessionKey()))
    throw Error('Unlock your account to enable profile backup.');
  if (capturing && !active(prev) && !(await sessionKey()))
    throw Error('Sign in with your secret key to enable X capture.');
  if ((capturing || activeSocial || msg.relaySync) && !relays.length) throw Error('Choose a relay first.');
  const input = msg.blossomServers ?? (msg.blossomServer === undefined ? mediaServers(prev) : msg.blossomServer.trim().split(/\s+/).filter(Boolean));
  const blossomServers = [...new Set((input.length ? input : [DEFAULT_BLOSSOM_SERVER]).map(blossomOrigin))];
  const blossomServer = blossomServers.find(publicMediaURL) ?? blossomServers[0];
  const mediaMiB = Number(msg.mediaMiB ?? prev.mediaMiB ?? DEFAULT_MEDIA_MIB);
  if (!Number.isSafeInteger(mediaMiB) || mediaMiB < 1 || mediaMiB > 1024)
    throw Error('Choose a media file limit between 1 and 1024 MiB.');
  if (JSON.stringify(mediaServers(prev)) !== JSON.stringify(blossomServers) || prev.handle !== handle || !msg.capture || prev.mediaMiB !== mediaMiB)
    mediaController?.abort();
  await saveSettings({
    ...prev,
    pubkey,
    handle,
    relays,
    relaysConfigured: true,
    capture: !!msg.capture,
    social,
    skipCrossposts: msg.skipCrossposts ?? prev.skipCrossposts ?? true,
    tipButtons: msg.tipButtons ?? prev.tipButtons ?? false,
    markSaved: msg.markSaved ?? prev.markSaved ?? true,
    tipCurrency: msg.tipCurrency === undefined ? prev.tipCurrency : validTipCurrency(msg.tipCurrency),
    relaySync: !!msg.relaySync,
    relayKinds,
    blossomServer,
    blossomServers,
    mediaMiB,
  });
}

async function leave(msg: Message<'logout' | 'deleteAccount'>) {
  if (changing) throw Error('The active profile is changing. Try again.');
  changing = true;
  try {
    await writer;
    const conf = await settings();
    if (!conf.pubkey || msg.pubkey !== conf.pubkey)
      throw Error('The active profile changed. Reopen Account.');
    const deleting = msg.type === 'deleteAccount';
    if (deleting && msg.confirmed !== true) throw Error('Confirm deletion in Settings.');
    quoteController?.abort();
    mediaController?.abort();
    indexController?.abort();
    await revokeSession();
    await saveKey();
    await writeAccountRecords({
      settings: null,
      lastRun: null,
      ['account:' + conf.pubkey]: conf,
      ...(deleting ? { deletingAccount: conf } : {}),
    });
    rerun = false;
    syncRequested = false;
    relayOwner = '';
    relayProgress.clear();
    pool.destroy();
    await Promise.allSettled([running, preparing, mediaJob, quoteJob, linkWriter, ...directoryJobs.values()]);

    if (deleting) {
      recovery = undefined;
      await recover();
    }
  } finally {
    changing = false;
  }
}

let activeImageReads = 0;
async function route(msg: Message, sender: Sender): Promise<Result<Action>> {
  if (sender.id !== api.runtime.id || ((sender.frameId ?? 0) > 0 && msg.type !== 'resolveImage'))
    throw Error('Untrusted sender.');
  if (sender.origin !== undefined) {
    const url = sender.url && new URL(sender.url);
    if (!url || sender.origin !== url.protocol + '//' + url.host)
      throw Error('Untrusted document origin.');
  }
  // A media upload can hold the deletion lock while requesting its signature.
  if (
    msg.type === 'authorizeMediaUpload' &&
    (changing || await accountRecord('deletingAccount'))
  )
    throw Error('The active profile is changing. Try again.');
  await recover();
  const conf = await settings();
  const page = sender.url?.split('#')[0];
  const accountPage = page === api.runtime.getURL('archive.html');
  const trustedPage = accountPage || (page === api.runtime.getURL('popup.html') && msg.type === 'status');
  if (changing && msg.type !== 'status' && msg.type !== 'captureConfig')
    throw Error('The active profile is changing. Try again.');
  if (msg.account !== undefined && msg.account !== conf.pubkey)
    throw Error('The active profile changed.');
  if (msg.type === 'resolveImage') {
    if (sender.tab?.id === undefined || !sender.url?.startsWith('https://'))
      throw Error('Expected a web page.');
    if (activeImageReads >= 12) throw Error('Image reader busy.');
    activeImageReads++;
    try {
      const bytes = await resolveImage(msg.url, conf);
      if (changing || (await settings()).pubkey !== conf.pubkey) throw Error('The active profile changed.');
      return imageDataURL(bytes);
    } finally { activeImageReads--; }
  }
  if (trustedPage && (msg.type === 'logout' || msg.type === 'deleteAccount'))
    return leave(msg);
  if (
    trustedPage &&
    (msg.type === 'login' || msg.type === 'unlock' || msg.type === 'createProfile')
  ) {
    let copying: { key: Uint8Array; profile: NewProfile; published: NostrEvent } | undefined;
    await write(async () => {
      if (msg.type === 'createProfile' && (await settings()).pubkey)
        throw Error('Log out before creating a profile.');
      if (msg.type === 'createProfile' && typeof msg.name !== 'string')
        throw Error('Enter a profile name.');
      if (msg.type === 'createProfile') {
        const { name, about, picture, banner, website } = msg;
        const profile = { name, about, picture, banner, website }, key = generateSecretKey();
        profileContent(profile);
        // Sign-up never waits on the network. Expiring pictures join the profile once copied.
        const lasting = (value?: string) => (value && !expiringImage(value) ? value : undefined);
        const published = await login(hex(key), { ...profile, picture: lasting(picture), banner: lasting(banner) });
        if (published && (picture || banner)) copying = { key, profile, published };
      } else await login(msg.key);
    });
    if (copying) void copyProfileImages(copying.key, copying.profile, copying.published).catch(() => {});
    if (msg.type === 'login') void keepPublishedXLink().catch(() => {});
    void kick();
    return;
  }
  // Sign-up details: the X account signed in on an open X tab, and its public profile.
  if (trustedPage && msg.type === 'detectAccounts') {
    const [x, instagram] = await Promise.all([signedInXHandle(), signedInInstagram()]);
    return { x, ...instagram };
  }
  if (trustedPage && msg.type === 'xProfile') {
    const handle = typeof msg.handle === 'string' ? msg.handle.trim().replace(/^@/, '').toLowerCase() : '';
    if (!handlePattern.test(handle)) throw Error('Enter your X username.');
    return (await readPublicXProfile(handle).catch(() => undefined)) ?? null;
  }
  if (trustedPage && msg.type === 'watch') {
    mediaController?.abort();
    await write(async () => {
      const next = await accountSettings(identity(msg.pubkey));
      await saveKey();
      await revokeSession();
      await saveSettings(next);
    });
    void kick();
    return;
  }
  if (trustedPage && msg.type === 'settings') {
    await write(() => configure(msg));
    void kick();
    return;
  }
  if (msg.type === 'registerBridge') {
    if (sender.frameId !== 0 || sender.tab?.id === undefined || !sender.url ||
        new URL(sender.url).protocol !== 'https:' || typeof msg.token !== 'string' || msg.token.length !== 36)
      throw Error('Open the website again and retry.');
    const key = `grant-${sender.tab.id}` as const;
    const existing = (await api.storage.session.get(key))[key];
    const origin = new URL(sender.url).origin;
    if (existing?.token !== msg.token || existing.origin !== origin)
      await api.storage.session.set({ [key]: { token: msg.token, origin } });
    return;
  }
  if (!conf.pubkey || changing) {
    if (trustedPage && msg.type === 'status')
      return {
        conf: defaults,
        unlocked: false,
        events: 0,
        drafts: 0,
        pending: 0,
        running: false,
        relays: [],
        x: { captured: 0, signed: 0, matched: 0, drafts: 0 },
        xFollows: 0,
      } satisfies Status;
    if (msg.type === 'captureConfig') {
      const site = captureNetwork(sender.url);
      if (site && sender.tab && !conf.pubkey) showSiteState(sender.tab, { site });
      return { capture: false, handle: '' };
    }
    throw Error('Choose a Nostr profile to start your backup.');
  }
  if (msg.type === 'nip07')
    return handleSignerRequest(msg, sender, conf.pubkey, sessionKey);
  if (msg.type === 'approval') {
    if (sender.url !== api.runtime.getURL('approve.html') + '#' + msg.id)
      throw Error('Untrusted approval.');
    return msg.decision === true ? write(() => approval(msg, sessionKey)) : approval(msg, sessionKey);
  }
  if (!trustedPage && !['captureConfig', 'pageStatus', 'capture', 'savedPosts', 'openSaved', 'xFollows', 'xProof', 'tipProfile', 'tipTargets', 'tipInvoice', 'tipRate', 'tipPost', 'nostrLink'].includes(msg.type))
    throw Error('Extension page required.');
  const db = await openArchive(conf.archiveName);
  try {
    if (msg.type === 'captureConfig' || msg.type === 'pageStatus' || msg.type === 'capture' || msg.type === 'savedPosts' || msg.type === 'openSaved') {
      const network = captureNetwork(sender.url);
      if (!network || !sender.tab || !sender.url) throw Error('Invalid capture source.');
      const selected = network === 'x' ? conf : conf.social?.[network];
      // Marks on the user's own posts, and the check that those posts get saved, compare post IDs with the backup
      // on this device. Nothing is sent anywhere.
      if (msg.type === 'savedPosts' || msg.type === 'openSaved') {
        const ids = msg.type === 'openSaved' ? [msg.id] : msg.ids;
        if (!Array.isArray(ids) || ids.length > 50 || !ids.every((id) => typeof id === 'string' && /^[\w-]{1,120}$/.test(id)))
          throw Error('Invalid posts.');
        const found = !selected?.handle ? [] : await savedPosts(db, network, ids);
        if (msg.type === 'savedPosts') return found.map(({ id, event }) => ({ id, onNostr: !!event }));
        // A click on a mark opens the post's public copy on Iris. The page it came from never sees which note that is.
        const event = found[0]?.event;
        if (event) await api.tabs.create({
          url: 'https://iris.to/' + noteEncode(event),
          ...(typeof sender.tab.index === 'number' ? { index: sender.tab.index + 1 } : {}),
        });
        return !!event;
      }
      if (msg.type === 'captureConfig' || msg.type === 'pageStatus') {
        const unlocked = !!(await sessionKey());
        showSiteState(sender.tab, { site: network, ...pageReport(msg), ...(await relaysDown(db, conf) ? { relaysDown: true } : {}) }, conf, unlocked);
        if (msg.type === 'pageStatus') return;
        return {
          handle: selected?.handle ?? '',
          capture: !!selected?.capture && unlocked,
          pubkey: conf.pubkey,
          tips: network === 'x' && conf.tipButtons === true && await paymentConsent(),
          marks: conf.markSaved !== false && !!selected?.handle,
          ...(conf.tipCurrency ? { tipCurrency: conf.tipCurrency } : {}),
          ...(network === 'x' ? { xLinked: ((await db.get('meta', 'xLink')) as XLink | undefined)?.handle === conf.handle } : {}),
        };
      }
      const handle = selected?.handle;
      const matchesPage = (url?: string) => !!url && !!handle && captureNetwork(url) === network &&
        (network === 'x' ? profileHandle(url) === handle : socialProfile(network, url) === handle ||
          (network === 'instagram' && !!instagramPermalink(url, handle)));
      if (!selected?.capture || !handle || !matchesPage(sender.url) || !matchesPage(sender.tab.url ?? sender.url))
        throw Error('Outside the selected profile.');
      if (!(await sessionKey())) throw Error('Capture is paused in read-only mode.');
      if (!Array.isArray(msg.posts) || msg.posts.length > 50) throw Error('Invalid capture batch.');
      const verified: Capture[] = [];
      if (network === 'x') {
        for (const post of msg.posts) {
          if ('source' in post) throw Error('Invalid capture source.');
          xTemplate(post, handle);
        }
        // Confirm audience outside the writer so a slow site cannot block settings or relay imports.
        for (let start = 0; start < msg.posts.length; start += 4) {
          const group = await Promise.all(msg.posts.slice(start, start + 4).map(async post => {
            if (post.visibility === 'private') return post.truncated ? undefined : post;
            const original = await readPublicXOriginal(handle, post.id).catch(() => undefined);
            if (original) return original;
            return post.truncated ? undefined : { ...post, visibility: 'unknown' as const };
          }));
          for (const post of group) if (post) verified.push(post);
        }
      } else {
        const posts = msg.posts as SocialCapture[];
        for (const post of posts) validateSocialPost(post, network, handle);
        for (let start = 0; start < posts.length; start += 4) {
          const group = await Promise.all(posts.slice(start, start + 4).map(verifySocialCapture));
          for (const post of group) validateSocialPost(post, network, handle);
          verified.push(...group);
        }
      }
      // Only a verification post the user chose to publish links the X account (a NIP-39 claim).
      const proof = network === 'x' ? verified.filter(post => post.visibility === 'public' && isProofPost(post.text, conf.pubkey))
        .sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1)[0] : undefined;
      await write(async () => {
        const current = await settings();
        const active = network === 'x' ? current : current.social?.[network];
        if (current.pubkey !== conf.pubkey || !active?.capture || active.handle !== handle || !(await sessionKey()))
          throw Error('Capture settings changed.');
        if (network === 'x') await stagePosts(db, verified);
        else await saveSocialCaptures(db, verified as SocialCapture[]);
        await signDrafts(db);
      });
      if (proof) await updateXLink(db, conf, { handle, proof: proof.id });
      kickQuotes();
      kickMedia();
      void kick();
      return;
    }
    if (msg.type === 'tipProfile' || msg.type === 'tipTargets' || msg.type === 'tipInvoice' || msg.type === 'tipRate' || msg.type === 'tipPost' || msg.type === 'nostrLink') {
      if (captureNetwork(sender.url) !== 'x' || !sender.tab || (conf.tipButtons !== true || !await paymentConsent())) throw Error('Tips are off.');
      if (msg.type === 'tipRate') {
        // A fiat estimate: saved for 15 minutes, from Snort's signed rate events or Coinbase.
        if (typeof msg.currency !== 'string' || !/^[A-Z]{3}$/.test(msg.currency)) throw Error('Invalid currency.');
        const key = ['rate', msg.currency], now = Date.now() / 1000;
        const saved = (await db.get('meta', key)) as { value: number; at: number } | undefined;
        if (saved && now - saved.at < FRESH_SECONDS) return saved.value;
        // Both sources at once; the first usable rate wins, so no relay is waited on.
        const relays = new SimplePool();
        const fromSnort = (async () => {
          if (!conf.relays.length) throw Error('No relays.');
          const events = await relays.querySync(conf.relays, { kinds: [SNORT_RATES.kind], authors: [SNORT_RATES.pubkey], '#d': ['BTC' + msg.currency] }, { maxWait: 2500 });
          const found = events.sort((a, b) => b.created_at - a.created_at).map((e) => snortRate(e, msg.currency)).find(Boolean);
          if (!found) throw Error('No signed rate.');
          return found;
        })();
        const fromCoinbase = coinbaseRate(msg.currency).then((found) => found ?? Promise.reject(Error('No rate.')));
        const value = await Promise.any([fromSnort, fromCoinbase]).catch(() => undefined);
        void fromSnort.catch(() => {}).finally(() => relays.destroy());
        if (value) await db.put('meta', { value, at: now }, key);
        return value ?? (saved && now - saved.at < 4 * 3600 ? saved.value : null);
      }
      if (msg.type === 'tipTargets') {
        if (!Array.isArray(msg.handles) || msg.handles.length > 50 || !msg.handles.every((h) => typeof h === 'string' && handlePattern.test(h)))
          throw Error('Invalid handles.');
        // Await before the archive closes when this handler returns.
        return await tipTargets(db, [...new Set(msg.handles.map((h) => h.toLowerCase()))]);
      }
      const handle = typeof msg.handle === 'string' ? msg.handle.toLowerCase() : '';
      if (!handlePattern.test(handle)) throw Error('Invalid handle.');
      // A link to the verified Nostr profile, from the X profile header.
      // Opening a profile link only checks the proof on X; relays never learn which X profile you are on.
      if (msg.type === 'nostrLink') {
        const target = await verifiedTarget(db, handle);
        if (!target) throw Error('This X account has no current verified Nostr link.');
        return { pubkey: target.pubkey };
      }
      if (msg.type === 'tipProfile') {
        const profile = await paymentProfile(db, conf, handle);
        const lightning = lightningAddress(profile)!;
        tipAddresses.set(profile.pubkey, lightning);
        if (tipAddresses.size > 200) tipAddresses.delete(tipAddresses.keys().next().value!);
        return { pubkey: profile.pubkey, lightning };
      }
      if (msg.type === 'tipPost') {
        // Only when the user opens a tip popover: find this post's Nostr copy and its tips.
        if (!/^\d{1,20}$/.test(msg.post)) throw Error('Invalid post.');
        const known = (await db.get('meta', ['xVerifiedProof', handle])) as string[] | undefined;
        if (!known || !conf.relays.length) return { sats: 0, tips: 0 };
        const pubkey = known[1];
        const url = 'https://x.com/' + handle + '/status/' + msg.post;
        const time = Number.isSafeInteger(msg.time) ? msg.time : undefined;
        const text = typeof msg.text === 'string' ? msg.text.slice(0, 500) : undefined;
        const relays = new SimplePool();
        try {
          const notes = await relays.querySync(conf.relays, {
            kinds: [1], authors: [pubkey], ...(time !== undefined && { since: time - 60, until: time + 60 }), limit: 100,
          }, { maxWait: 4000 });
          const note = matchingNote(notes, url, time, text);
          if (!note) return { sats: 0, tips: 0 };
          tipNotes.set(pubkey + ':' + msg.post, note.id);
          if (tipNotes.size > 200) tipNotes.delete(tipNotes.keys().next().value!);
          const receipts = await relays.querySync(conf.relays, { kinds: [9735], '#e': [note.id] }, { maxWait: 4000 });
          const address = tipAddresses.get(pubkey);
          const pay = address && (await payInfo(address).catch(() => undefined))?.nostrPubkey;
          return { note: note.id, ...(typeof pay === 'string' ? zapTotal(receipts, pay) : { sats: 0, tips: 0 }) };
        } finally {
          relays.destroy();
        }
      }
      const key = await sessionKey();
      if (!key || getPublicKey(unhex(key)) !== conf.pubkey) throw Error('Unlock Social Backup to tip.');
      if (msg.post !== undefined && !/^\d{1,20}$/.test(msg.post)) throw Error('Invalid post.');
      const profile = await paymentProfile(db, conf, handle);
      if (profile.pubkey !== msg.pubkey || lightningAddress(profile) !== msg.lightning)
        throw Error('The recipient changed. Reopen Tip to review the new address.');
      return await tipInvoice({
        profile, sats: msg.sats, relays: conf.relays,
        sign: template => finalizeEvent(template, unhex(key)),
        note: msg.post ? tipNotes.get(profile.pubkey + ':' + msg.post) : undefined,
      });
    }
    if (msg.type === 'xProof') {
      // Your verification post, seen on any X page. X's public page must confirm it before it links.
      // The setup page can also take a pasted link to the post, which works whatever X's pages look like.
      const handle = conf.handle;
      if (!handle || (!trustedPage && (captureNetwork(sender.url) !== 'x' || !sender.tab))) throw Error('Save your X username first.');
      const pasted = trustedPage && typeof msg.url === 'string' ? xPermalink(msg.url.trim()) : undefined;
      if (pasted && pasted.author !== handle) throw Error('That post is from @' + pasted.author + ', not @' + handle + '.');
      const id = pasted?.id ?? msg.id;
      if (typeof id !== 'string' || !/^\d{1,20}$/.test(id)) throw Error('Paste the link to your verification post.');
      if (!(await sessionKey())) throw Error('Unlock your account first.');
      const post = await readPublicXOriginal(handle, id).catch(() => undefined);
      if (post?.visibility !== 'public' || !isProofPost(post.text, conf.pubkey)) throw Error('X doesn’t show that as a public verification post yet.');
      await updateXLink(db, conf, { handle, proof: id });
      return;
    }
    if (msg.type === 'xFollows') {
      // Handles read from the user's own X following list, to find them on Nostr later.
      const own = (url?: string) => captureNetwork(url) === 'x' && !!conf.handle && followingHandle(url) === conf.handle;
      if (!sender.tab || !own(sender.url) || !own(sender.tab.url ?? sender.url)) throw Error('Outside your X following list.');
      if (!Array.isArray(msg.handles) || msg.handles.length > 200 || !msg.handles.every((h) => typeof h === 'string' && handlePattern.test(h)))
        throw Error('Invalid following list.');
      const known = ((await db.get('meta', 'xFollows')) as string[] | undefined) ?? [];
      await db.put('meta', [...new Set([...known, ...msg.handles.map((h) => h.toLowerCase())])].slice(0, 10000), 'xFollows');
      // You are about to look for them on Nostr, so the directory of X links fills meanwhile.
      void warmDirectory();
      return;
    }
    switch (msg.type) {
      case 'status': {
        const currentXLink = async () => {
          const link = (await db.get('meta', 'xLink')) as XLink | undefined;
          return link?.handle === conf.handle ? link : undefined;
        };
        const root = await readRoot(db);
        const storedRun = await accountRecord('lastRun');
        const lastRun: LastRun | null | undefined =
          storedRun?.pubkey && storedRun.pubkey !== conf.pubkey ? undefined : storedRun;
        // Rows for removed relays, paused capture or local-only events are kept but will not send now.
        const heldIds = new Set(await db.getAllKeys('heldEvents'));
        const pending = (await db.getAll('outbox')).filter(
          (row) => conf.relays.includes(row.relay) && canDeliverCapture(row, conf) && !heldIds.has(row.id),
        );
        const stats = db.transaction(['sources', 'drafts', 'xMatches', 'xMedia', 'localCaptures', 'heldEvents']);
        const local = stats.objectStore('localCaptures');
        const prefix = (name: string) => IDBKeyRange.bound(name + ':', name + ';', false, true);
        const [instagram, facebook, localX, held] = await Promise.all([
          Promise.all([local.count(prefix('instagram')), stats.objectStore('sources').count(prefix('instagram'))]),
          Promise.all([local.count(prefix('facebook')), stats.objectStore('sources').count(prefix('facebook'))]),
          local.count(prefix('x')), stats.objectStore('heldEvents').getAll(),
        ]);
        const [draftPosts, mapped, matched] = await Promise.all([
          stats.objectStore('drafts').getAll(),
          stats.objectStore('sources').count(IDBKeyRange.bound('x:', 'x;', false, true)),
          stats.objectStore('xMatches').count(),
        ]);
        const drafts = draftPosts.length;
        const xDrafts = draftPosts.filter(post => !('source' in post));
        const imagePosts = xDrafts
          .map((post) => xImageURLs(post.text))
          .filter((urls) => urls.length);
        const imageUrls = [...new Set(imagePosts.flat())];
        const receipts = await Promise.all(
          imageUrls.map((url) => stats.objectStore('xMedia').get(url)),
        );
        const pendingImages = new Set(receipts.map(row => row?.hash).filter(Boolean));
        const uploads = pendingImages.size ? await db.getAll('blossomOutbox') : [];
        const mediaError = receipts.find(row => row?.error)?.error ??
          uploads.find(row => pendingImages.has(row.hash) && mediaServers(conf).includes(row.server) && row.error)?.error ??
          (imagePosts.length && !mediaServers(conf).some(publicMediaURL) ? 'Set a public media backup server for shareable image links.' : undefined);
        const queued = new Map<string, number>();
        for (const row of pending) queued.set(row.relay, (queued.get(row.relay) ?? 0) + 1);
        const connections = pool.listConnectionStatus();
        const relays: RelayStatus[] = await Promise.all(
          conf.relays.map(async (url) => {
            const progress = (relayOwner === conf.pubkey
              ? relayProgress.get(url)
              : undefined) ??
              lastRun?.relays?.[url] ?? { ...idleRelay(), detail: lastRun?.reports[url] };
            const retryAt = await readCooldown(db, url);
            const cursor = await db.get('cursors', [conf.pubkey, url]);
            const lastSyncedAt = (await db.get('meta', ['lastSyncedAt', url]) as number | undefined)
              ?? (cursor?.through && cursor.through * 1000);
            return {
              ...progress,
              lastSyncedAt,
              url,
              connection: connections.get(normalizeURL(url))
                ? 'connected'
                : progress.phase === 'connecting'
                  ? 'connecting'
                  : 'disconnected',
              pending: queued.get(url) ?? 0,
              ...(retryAt && retryAt > Date.now()
                ? { phase: 'retry' as const, retryAt }
                : {}),
            };
          }),
        );
        return {
          conf,
          profile: await readProfile(db, conf.pubkey),
          unlocked: !!(await sessionKey()),
          events: await db.count('events'),
          drafts,
          social: { instagram: { saved: instagram[0], signed: instagram[1] }, facebook: { saved: facebook[0], signed: facebook[1] } },
          localX: localX + held.filter(source => source.startsWith('x:')).length,
          x: { captured: mapped + xDrafts.length + localX, signed: mapped - matched, matched, drafts: xDrafts.length - imagePosts.length,
            ...(imagePosts.length ? {media: imagePosts.length, mediaError} : {}) },
          pending: new Set(pending.map((row) => row.id)).size,
          relays,
          running: !!running,
          preparingIndex: !!preparing,
          indexHash: root ? hex(root.hash) : undefined,
          pointer: await readPointer(db),
          lastRun,
          xLink: await currentXLink(),
          xFollows: (((await db.get('meta', 'xFollows')) as string[] | undefined) ?? []).length,
        } satisfies Status;
      }
      case 'publishIndex': {
        if (preparing) throw Error('Index upload already in progress.');
        const controller = new AbortController();
        const checkActive = async () => {
          controller.signal.throwIfAborted();
          const current = await settings();
          if (
            changing ||
            current.pubkey !== conf.pubkey ||
            current.blossomServer !== conf.blossomServer ||
            JSON.stringify(current.relays) !== JSON.stringify(conf.relays)
          )
            throw Error('The active profile or backup destinations changed.');
          const key = await sessionKey();
          if (!key || getPublicKey(unhex(key)) !== conf.pubkey)
            throw Error('Sign in with the archive secret key first.');
          return unhex(key);
        };
        const sign: Sign = async (event) => finalizeEvent(event, await checkActive());
        indexController = controller;
        preparing = (async () => {
          await checkActive();
          await queueIndexPointer(db, conf, sign, checkActive, controller.signal);
        })();
        try {
          await preparing;
        } finally {
          preparing = undefined;
          indexController = undefined;
        }
        void kick();
        return;
      }
      case 'listPermissions':
      case 'forgetPermissions':
        if (page !== api.runtime.getURL('archive.html') || msg.account !== conf.pubkey)
          throw Error('Open Account to manage website permissions.');
        if (msg.type === 'listPermissions') return permissions(conf.pubkey);
        return write(() => revokeWebsite(conf.pubkey, msg.origin));
      case 'exportPrivateKey': {
        if (page !== api.runtime.getURL('archive.html') || msg.account !== conf.pubkey)
          throw Error('Open Account to copy your secret key.');
        const key = await sessionKey();
        if (!key || getPublicKey(unhex(key)) !== conf.pubkey) throw Error('Unlock your account first.');
        return nsecEncode(unhex(key));
      }
      case 'lock':
        mediaController?.abort();
        indexController?.abort();
        await write(async () => { await saveKey(); await revokeSession(); });
        return;
      case 'sync':
        if (!conf.relays.length) throw Error('Select a relay first.');
        void kick(true);
        return;
      case 'unlinkX':
        await updateXLink(db, conf);
        return;
      case 'findXFollows': {
        // Matches come from the local directory at once; its refresh from relays runs in the background.
        const handles = ((await db.get('meta', 'xFollows')) as string[] | undefined) ?? [];
        const [, due = '0'] = ((await db.get('meta', ['xDirectorySchedule', ...conf.relays])) as string[] | undefined) ?? [];
        const loading = conf.relays.length > 0 && Date.now() >= Number(due);
        if (loading) void warmDirectory();
        const matches = [];
        let unchecked = 0;
        for (const handle of handles) {
          try {
            const target = await verifiedTarget(db, handle);
            if (target) matches.push({ handle, pubkey: target.pubkey });
          } catch (error) {
            if (!(error instanceof XRateLimited)) throw error;
            unchecked = handles.length - handles.indexOf(handle);
            break;
          }
        }
        const contacts = (await archiveRouter(db, conf.pubkey).query([{ authors: [conf.pubkey], kinds: [3], limit: 1 }])).events[0]?.event;
        const following = new Set(contacts?.tags.filter(([name]) => name === 'p').map(([, key]) => key));
        return { matches, unchecked, loading, following: matches.map(m => m.pubkey).filter(key => following.has(key)) };
      }
      case 'nostrCard': {
        // Only X accounts already in the local directory are checked, and only on X.
        const handle = typeof msg.handle === 'string' ? msg.handle.toLowerCase() : '';
        if (!handlePattern.test(handle) || !(await directoryClaims(db, handle)).length) return null;
        // Everything else is local, so relays never learn which X profile you are looking at.
        const [target, contacts, table] = await Promise.all([
          verifiedTarget(db, handle).catch(() => undefined),
          archiveRouter(db, conf.pubkey).query([{ authors: [conf.pubkey], kinds: [3], limit: 1 }]).then((r) => r.events[0]?.event),
          graphFollowers().catch(() => new Uint8Array()),
        ]);
        if (!target) return null;
        const { pubkey } = target;
        return {
          handle,
          pubkey,
          profile: (await db.get('xDirectory', [pubkey, 0]))?.profile,
          followers: knownFollowers(table, pubkey),
          following: !!contacts?.tags.some(([name, key]) => name === 'p' && key === pubkey),
        };
      }
      case 'followOnNostr': {
        if (!Array.isArray(msg.pubkeys) || !msg.pubkeys.length || !msg.pubkeys.every((key) => /^[0-9a-f]{64}$/.test(key)))
          throw Error('Choose people to follow.');
        // Start from the newest follow list so existing follows are kept.
        await publishOwn(db, conf, contactsTemplate(await latestOwn(db, conf, 3), msg.pubkeys));
        return msg.pubkeys.length;
      }
      case 'syncBlossom': {
        if (!(await sessionKey())) throw Error('Sign in with your secret key to sync media.');
        const count = await queueBlossom(db, await shareableMediaHashes(db), mediaServers(conf), true);
        kickMedia();
        return count;
      }
      case 'authorizeMediaUpload': {
        if (
          !conf.blossomServer ||
          !(await shareableMediaHashes(db)).has(msg.hash) ||
          !mediaServers(conf).includes(msg.server) ||
          !(await db.getKey('mediaFiles', msg.hash))
        )
          throw Error('Choose a saved file and the configured media backup server.');
        const key = await sessionKey();
        if (!key || getPublicKey(unhex(key)) !== conf.pubkey)
          throw Error('Unlock your account first.');
        return createUploadAuth(async (event) => finalizeEvent(event, unhex(key)), msg.hash, {
          servers: msg.server,
          expiration: Math.floor(Date.now() / 1000) + 300,
        });
      }
      case 'broadcast': {
        if (running) throw Error('Wait for the current sync to finish.');
        const count = await write(async () => queueBroadcast(db, await settings()));
        void kick(conf.relaySync);
        return count;
      }
      case 'rescan':
        if (running) throw Error('Wait for the current sync to finish.');
        if (!conf.relays.length) throw Error('Select a relay first.');
        await db.clear('cursors');
        void kick(true);
        return;
      default:
        throw Error('Unknown action.');
    }
  } finally {
    db.close();
  }
}
api.runtime.onMessage.addListener((msg, sender, respond) => {
  route(msg, sender).then(
    (value) => respond({ ok: true, value }),
    (err) => respond({ ok: false, error: err.message }),
  );
  return true;
});
// The dot on the toolbar icon of a tab on X, Facebook or Instagram, and the same state for the popup.
function showSiteState(tab: { id?: number }, report: TabReport, conf?: Settings, unlocked = false) {
  if (tab.id === undefined) return;
  const tabId = tab.id, key = `site-${tabId}` as const;
  const state = siteState(report.site, conf, unlocked, report), badge = siteBadge(state.level);
  // The dot is a hint. Nothing waits for it, and a closed tab or a browser without badges changes nothing else.
  void (async () => {
    await api.storage.session.set({ [key]: report });
    await api.action.setBadgeText({ tabId, text: badge.text });
    if (badge.color) await api.action.setBadgeBackgroundColor({ tabId, color: badge.color });
    if (badge.textColor) await api.action.setBadgeTextColor?.({ tabId, color: badge.textColor });
    await api.action.setTitle({ tabId, title: 'Social Backup: ' + state.text });
  })().catch(() => {});
}
function pageReport(msg: PageReport): PageReport {
  return {
    ...(msg.failed === true ? { failed: true } : {}),
    ...(typeof msg.unsaved === 'number' && Number.isSafeInteger(msg.unsaved) && msg.unsaved > 0 ? { unsaved: Math.min(msg.unsaved, 999) } : {}),
  };
}
/** Every relay failed in the last run while posts still wait to be sent. */
async function relaysDown(db: Archive, conf: Settings) {
  if (!conf.relays.length) return false;
  const last = await accountRecord('lastRun');
  return last?.pubkey === conf.pubkey &&
    conf.relays.every((url) => ['retry', 'error'].includes(last.relays?.[url]?.phase ?? '')) &&
    (await db.count('outbox')) > 0;
}
api.tabs.onRemoved.addListener((id) => void api.storage.session.remove(`site-${id}`).catch(() => {}));
// A toolbar click opens the full-page welcome screen until a profile is active.
api.action.onClicked.addListener(() => api.runtime.openOptionsPage());
function setToolbarPopup(pubkey?: string) {
  return api.action.setPopup({ popup: pubkey ? 'popup.html' : '' });
}
let toolbarSettingsChanged = false;
api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settingsChanged) return;
  toolbarSettingsChanged = true;
  void settings().then(conf => setToolbarPopup(conf.pubkey));
});
void settings().then((conf) => {
  if (!toolbarSettingsChanged) return setToolbarPopup(conf.pubkey);
});
async function arm() {
  if (!(await api.alarms.get('x-directory')))
    await api.alarms.create('x-directory', { delayInMinutes: 1, periodInMinutes: 5 });
  if (!(await api.alarms.get('backup')))
    await api.alarms.create('backup', { periodInMinutes: 5 });
}
// Signing in with an existing key keeps the X link it already published, once X still shows the
// proof. Nothing is republished; the link shows when the X username in Sources matches it.
async function keepPublishedXLink() {
  const conf = await settings();
  if (changing || !conf.pubkey) return;
  const db = await openArchive(conf.archiveName);
  try {
    const list = await latestOwn(db, conf, IDENTITY_KIND);
    if (!list) return;
    await saveDirectory(db, [list]);
    const [claim] = xClaims(list).sort((a, b) => (BigInt(b.proof) > BigInt(a.proof) ? 1 : -1));
    if (!claim || (await db.get('meta', 'xLink')) || !(await checkXProof(claim))) return;
    if (changing || (await settings()).pubkey !== conf.pubkey) return;
    const floorKey = ['xProofThrough', claim.handle];
    const tx = db.transaction('meta', 'readwrite');
    const floor = ((await tx.store.get(floorKey)) as string[] | undefined)?.[0] ?? '0';
    if (BigInt(claim.proof) >= BigInt(floor)) {
      await tx.store.put({ handle: claim.handle, proof: claim.proof }, 'xLink');
      await tx.store.put([claim.proof], floorKey);
    }
    await tx.done;
  } finally {
    db.close();
  }
}

// After sign-up, the profile's own copies of its pictures replace the original links, unless the
// profile changed meanwhile. A copy that fails keeps a lasting link and leaves out an expiring one.
async function copyProfileImages(key: Uint8Array, profile: NewProfile, published: NostrEvent) {
  const copied = await withCopiedImages(profile, key, defaults.blossomServer!);
  const content = profileContent(copied);
  if (content.picture === JSON.parse(published.content).picture && content.banner === JSON.parse(published.content).banner) return;
  const conf = await settings();
  if (changing || conf.pubkey !== published.pubkey) return;
  const db = await openArchive(conf.archiveName);
  try {
    await write(async () => {
      const latest = (await archiveRouter(db, conf.pubkey).query([{ authors: [conf.pubkey], kinds: [0], limit: 1 }])).events[0]?.event;
      if (latest?.id !== published.id) return;
      const event = finalizeEvent({
        kind: 0, tags: [], content: JSON.stringify(content),
        created_at: Math.max(Math.floor(Date.now() / 1000), published.created_at + 1),
      }, key);
      await archiveRouter(db, conf.pubkey, conf.relays).publish(event, localArchive);
    });
  } finally {
    db.close();
  }
  void kick();
}

// Sign-up reads the signed-in account from tabs that are already open, never opening any.
async function readOpenTabs<T>(urls: string[], func: () => unknown, accept: (value: unknown) => T | undefined) {
  const tabs = (await api.tabs.query({ url: urls })).filter(tab => tab.id !== undefined);
  for (const tab of tabs.slice(0, 5)) {
    try {
      const [result] = await api.scripting.executeScript({ target: { tabId: tab.id! }, func });
      const value = accept(result?.result);
      if (value) return value;
    } catch { /* A tab that is loading or closing has nothing to read. */ }
  }
}
// X's sidebar links to the signed-in account's profile.
function signedInXHandle() {
  return readOpenTabs(['https://x.com/*'], xProfileLink, (href) =>
    profileHandle(typeof href === 'string' ? 'https://x.com' + href : undefined));
}
// Instagram's page data names the signed-in account and its public profile.
function signedInInstagram() {
  return readOpenTabs(['https://www.instagram.com/*', 'https://instagram.com/*'], instagramViewer, (value) => {
    const viewer = value as Record<string, unknown> | null;
    const username = typeof viewer?.username === 'string' ? viewer.username.toLowerCase() : '';
    if (!username || socialProfile('instagram', 'https://www.instagram.com/' + username + '/') !== username) return;
    const text = (field: unknown, max: number) => (typeof field === 'string' ? field.trim().slice(0, max) : '');
    const name = text(viewer!.name, 100) || username, about = text(viewer!.about, 1000);
    const picture = typeof viewer!.picture === 'string' && expiringImage(viewer!.picture) &&
      viewer!.picture.startsWith('https://') ? viewer!.picture : '';
    let website = '';
    try {
      const url = new URL(String(viewer!.website));
      if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) website = url.href;
    } catch { /* No link. */ }
    return {
      instagram: username,
      instagramProfile: { name, ...(about ? { about } : {}), ...(picture ? { picture } : {}), ...(website ? { website } : {}) },
    };
  });
}
async function attachOpenProfileTabs() {
  const tabs = (await api.tabs.query({ url: [...captureSites] })).filter(tab => tab.id !== undefined);
  if (!tabs.length) return;
  await Promise.allSettled(tabs.map(tab =>
    api.scripting.executeScript({target: {tabId: tab.id!}, files: ['content.js']})
  ));
  // A page that stays silent still runs the code from before the update. Its backup starts after a reload.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const conf = await settings();
  for (const tab of tabs) {
    const site = captureNetwork(tab.url), key = `site-${tab.id!}` as const;
    if (!site || (await api.storage.session.get(key))[key]) continue;
    if (conf.pubkey && siteState(site, conf, true).level) showSiteState(tab, { site, stale: true }, conf, true);
  }
}
api.runtime.onInstalled.addListener(() => {
  void attachOpenProfileTabs();
  void arm();
  void kick();
});
api.runtime.onStartup.addListener(() => {
  void arm();
  void kick();
});
api.alarms.onAlarm.addListener((a) => {
  if (a.name === 'x-directory') void scheduledDirectory().catch(() => {});
  if (a.name === 'backup' || a.name.startsWith('relay-retry:')) void kick();
});
void arm();

async function scheduledDirectory() {
  await recover();
  const conf = await settings();
  // Public identity lists for tips, the popup's Nostr card and finding X follows.
  if (changing || !conf.pubkey) return;
  const db = await openArchive(conf.archiveName);
  try { await updateDirectory(db, conf); } finally { db.close(); }
}
