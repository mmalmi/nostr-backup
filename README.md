# Social Backup

A Chrome and Firefox extension that archives your own posts as you browse your X, Instagram, or Facebook profile. It signs confirmed public posts as Nostr kind 1 notes, imports your signed Nostr events from the relays you choose, and keeps both in a local, exportable hashtree.

## Install

Browser packages and installation instructions are on [backup.iris.to](https://backup.iris.to/). The source is on [git.iris.to](https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/nostr-backup) and [GitHub](https://github.com/mmalmi/nostr-backup).

Use Node 22.12 or newer and pnpm 10.28.2.

```sh
pnpm install --frozen-lockfile
pnpm build
```

| Browser | Load the development build |
| --- | --- |
| Chrome | Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `dist/chrome`. |
| Firefox 140+ | Open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `dist/firefox/manifest.json`. Temporary installs last until Firefox restarts. |
| Safari | On a Mac with Xcode, run the command below on `dist/safari`, open the generated Xcode project, and build the containing app. The Safari build is experimental. |

```sh
xcrun safari-web-extension-packager dist/safari --app-name "Social Backup" --macos-only
```

The build also writes a ZIP for each browser, with fixed entry timestamps so repeated builds from the same inputs produce identical packages. Unzip the Chrome package before loading it. Firefox release distribution requires a Mozilla-signed package. Export your archive before removing or replacing a temporary installation.

## First backup

1. Click the Social Backup toolbar icon. Choose **Sign up**, enter your name and choose **Go** to start a new Nostr profile. If you already have a profile, choose **Sign in** and paste your secret key (nsec) or user ID (npub). The archive opens automatically; npub stays read-only. As in Iris, a 64-character hex key is treated as a private key. The default relays match Iris. Open **Backup → Relays** to change the selection or add your own.
2. **Sync daily** backs up every event kind your relays serve for your public key. To filter downloads, open **Backup → Download all event kinds**, choose **Only these kinds** or **All except these kinds**, and enter kind numbers (for example, `1, 7`). The filter saves when you finish typing. The next sync checks older history after an upgrade or filter change. Previously saved events stay in your ZIP. The importer verifies each event’s author, ID and signature.
3. To mirror X, open **Sources**, enter your X username and choose **Save** (or press Enter). Backup is on by default; other settings save as you change them. If you opened the archive with a public key, log in with its private key to sign captures.
4. Visit the configured X profile and scroll. You can view it from another X account. The profile URL and the post author’s timestamp permalink must both match the configured handle. It handles Posts, Replies and Media profile tabs. Read-only mode pauses capture; existing unsigned captures remain on disk.
5. **Download ZIP** exports a snapshot. The Backup tab shows local signed posts, captures awaiting signature, pending deliveries, and the most recent result for each relay.
6. **Share backed-up posts** sends the signed posts currently in your archive, including imported Nostr posts and signed X copies. With import enabled, the button reads **Share and check for posts** and also checks each saved relay for posts missing from your archive. This works with a locked signer and can restore an empty archive.

**Sync now** imports from your saved relays even when automatic import is off, and retries queued deliveries. Each relay has a live connection indicator, activity, imported and acknowledged-send counts, queue size and broadcast progress. Errors and retry times stay with the affected relay. Each connection closes when its work finishes. Backup shows the last completed history sync for each relay. Your latest archived Nostr profile supplies the avatar and name shown in the header and toolbar popup; the public key stays in **Account**.

**Sources** has one card per platform. The X card shows captured, signed, already-on-Nostr and awaiting-signature totals. By default, capture compares your X post with your own locally archived Nostr notes from the same UTC date. An exact match or a close match to a full note or substantial paragraph links the original X capture to the signed note. Turn off **Skip posts already on Nostr** to sign future captures separately. For new X posts, Backup copies images to the Blossom server selected in **Media** (default `https://blossom.band`) and signs the post with the returned image URLs and the `Social Backup` client tag. The original image bytes are also saved locally. If an upload fails, the capture stays queued and text-only posts continue signing. The toolbar popup shows capture and upload status on x.com. Public-key login and a locked signer show **Read-only** beside the profile. Capture pauses in this mode; imports, ZIP downloads and broadcasting already-signed events remain available.

On the same page, the Instagram and Facebook cards let you enable either profile separately. Enter your Instagram username or Facebook username/numeric profile ID, choose **Save**, then visit your profile and scroll. Opening an Instagram post also works. The extension records your own posts it can identify, including the original link, caption, available media, and date. Instagram grid dates can have day-only precision. Before signing, the extension fetches the public original from Facebook or Instagram without cookies and uses its byline, caption, time and attachments. Login walls and unsupported layouts can limit capture. Media downloads obey your per-file limit and the source site's access rules.

**Sources → X → On Nostr** has three optional features, each separate:

- **Link your X account.** Choose **Post verification on X** and post the prepared text. When Backup saves that post from your profile, it publishes a [NIP-39](https://github.com/nostr-protocol/nips/blob/master/39.md) claim (kind 10011) linking your X handle to your Nostr key. nostr.directory lists such claims as verified.
- **Follow people you follow on X.** Scroll `x.com/<you>/following` to collect the accounts you follow, then choose **Find them on Nostr**. Backup reads NIP-39 claims for those handles from your relays and checks each proof post against X's signed-out public page, accepting nostr.directory's older hex-key proofs. Copied proofs fail. Checks run one per second, are remembered, and pause if X limits them. **Follow** adds the chosen people to your newest Nostr follow list and keeps existing follows.
- **Tips on X.** A ⚡ button appears on posts and profiles of X accounts with a verified Nostr profile that has a lightning address. Choosing an amount signs a NIP-57 zap request, gets an invoice from the recipient's lightning provider, refuses invoices for any other amount, and opens your wallet with a `lightning:` link. Amounts are shown in your currency, with sats in small print, using Snort's signed rate events or Coinbase, saved for 15 minutes. The popover shows a QR code for phone wallets. When it opens, it looks for the post's Nostr copy so the tip zaps that post and shows tips it already received. To find tip buttons, the X accounts you see are looked up on your relays. Turn off **Show tip buttons on X** to stop this.

When a captured post quotes a public post from one of your configured profiles, Backup reuses the existing signed original or retrieves and archives it first. The new note includes a clickable `nostr:nevent` link and a NIP-18 `q` tag. If an own original is unavailable or restricted, the quote stays in local drafts. A confirmed link to another author keeps its original URL.

**Publishing is public on public relays.** Only captures confirmed public are signed for sharing. X copies use the author, timestamp, text and media from the signed-out public permalink. Previously queued drafts from older versions stay local until recaptured. Private and unconfirmed captures stay local and are included in the ZIP. Bulk broadcasts, public indexes and media uploads exclude local-only captures. Existing signed X copies from older versions stay local until verified by recapture. Public copies already delivered cannot be recalled by this change.

## Profile and local storage

After you enter your name, the extension generates your private key. Signup opens the archive directly. While the signer is unlocked, **Account → Copy secret key** copies the key without displaying it. The signer stays available across browser restarts. The private key is stored unencrypted in the extension’s own IndexedDB. Websites cannot open that database. Anyone able to read the browser profile on disk or run code inside the privileged extension can recover the key. Keep a backup before locking, logging out, or uninstalling. Signup saves your signed kind 0 profile and queues its name for publication to your relays. The archive opens immediately, and pending deliveries retry in the background.

Each public key has its own local archive and settings. **Lock account** removes the saved private key, pauses X capture and keeps relay import available. Existing unsigned captures stay saved until you unlock. **Log out** pauses backup for that public key and revokes tab signing permissions. Log back in or open the same public key read-only to return to its archive. If you used an earlier version, opening the same profile reopens your original archive.

**Account → Delete local archive** asks for confirmation and removes the local events, drafts, media, settings and delivery records for the active public key. Copies already sent to relays or Blossom and ZIPs downloaded to disk can still be read.

Open **Storage** for event versions, index blocks and bytes, media counts and sizes, and queued work. Expand a kind to see individual indexed event IDs, timestamps and exact encoded payload sizes. The current index selects the latest replaceable profile, while the archive retains the signed versions it has seen. Block totals include index structure and retained blocks. Choose **Refresh statistics** for an updated count.

## Public event index

**Backup → Share a link to your public backup** displays your copyable `htree://<npub>/my-events` address. To publish it, choose a Blossom server in **Media** and at least one relay in **Backup**, sign in with the archive key, then choose **Publish link**. The extension uploads the blocks reachable from the current event index, then signs a public Hashtree kind 30064 pointer named `my-events`. The extension uses `HashTree.push`, `BlossomStore` and `createNostrRefResolver().publish` from the TypeScript Hashtree packages. The pointer includes the root hash, its read key and a Blossom server hint. Anyone who resolves it can read the signed events and their attachment URLs. Use **Media → Upload saved files** to publish the media bytes themselves.

The Archive page shows the block server, pending relays, acknowledgements and whether the local index has advanced. Choose **Publish link** again to update the same address. Readers need access to a relay that accepted the pointer and a Blossom server holding the blocks. New indexes use 33-byte, suite-prefixed CHK keys. A reader limited to the older 32-byte key format needs an upgrade.

## What gets preserved

Each X copy keeps the original publication second in `created_at`, a canonical `https://x.com/<handle>/status/<id>` in its `r` and `i` tags, and a `k` tag of `web`. When source precision is available it adds a custom `["ms", "<Unix milliseconds>"]` tag. It uses explicit subsecond DOM time or decodes a Snowflake ID using integer arithmetic and checks the result against the DOM second. Older IDs with second-only source data retain second precision. Native Nostr events retain their original signatures and tags.

Capture covers rendered text, emoji, visible links, photos, direct X video MP4 URLs when exposed by the player, video posters, and identifiable quote permalinks. The first complete capture of each X status ID is retained. Long posts collapsed behind **Show more** are saved with their full text from the signed-out public post, or skipped if that cannot be read, so a partial text is never signed. Scrolling determines which posts load. Polls and edit history are outside this version.

## Media backup

Open **Media → Back up media** and keep the archive page open. The extension scans attachment references from existing signed posts as well as new imports. These include X images and posters, direct media links, Nostr `imeta` tags, kind 1063 file metadata, and `blossom:` URIs with server hints. The next sync after upgrading also checks older relay history for events matching your download settings.

Each completed download is saved in `@hashtree/dexie`, Hashtree’s IndexedDB block store. The archive records the original URL, post ID, plaintext SHA-256, and file CID. Known URLs and hashes reuse the local copy. Other downloads consult the browser HTTP cache. Hash-addressed downloads prefer a cached response and verify its digest. Ordinary URLs follow HTTP freshness rules. A browser may partition its cache by site, so a file viewed on X can require a new download. The extension verifies an advertised hash before saving the file. For a missing or mismatched source it tries attachment fallbacks, Blossom hints, the configured server, and the archive author’s signed kind 10063 server list on the saved relays. [NIP-92](https://github.com/nostr-protocol/nips/blob/master/92.md) · [Blossom media](https://github.com/nostr-protocol/nips/blob/master/B7.md)

The Media page distinguishes saved files, poster-only captures, and unavailable sources. **Back up media** retries unfinished attachments, including after closing the page. **Media** controls the per-file download limit (64 MiB by default). Downloads use HTTPS and omit credentials. If a host blocks browser access, the Media page can request permission for that host.

**Download file** reads a saved file locally. **Backup → Download ZIP** includes the media index and all referenced blocks. To extract ordinary media files from a ZIP offline, run the command below in this project with dependencies installed. It checks each restored file’s length and SHA-256 and names the output by its hash.

```sh
node --experimental-strip-types scripts/extract-media.ts social-backup-2026-11-11.zip restored-media
```

**Media → Sync media** checks locally saved public files against every configured Blossom server and restores missing copies from local Hashtree storage. Enter one server origin per line. HTTPS servers and HTTP loopback servers are supported. X photo posts can use the first confirmed public copy while the other servers finish independently. Localhost addresses are excluded from published image links. Each file and server has a persistent delivery record. Failed attempts back off from five minutes to six hours and resume after a restart. The Media page shows each server’s saved and queued counts, errors and next retry. Sync again to check for copies a server has lost. Restricted captures stay local.

## Browsing Blossom and Hashtree images

On HTTPS pages where the extension has site access, an image can use `blossom:<sha256>.png`, `htree://<nhash>/photo.png`, or `htree://<npub>/<tree>/photo.png` as its `src`. Images added after page load work too. If an ordinary HTTPS image ending in a Blossom hash fails to load, the helper tries to recover it.

The helper reads public media from the active archive and keeps a separate 64 MiB browsing cache. On a miss it requests the hash from the servers listed under **Media → Blossom servers**, in order, and checks the SHA-256 before using the bytes. A local Hashtree daemon in that list can retrieve missing blocks from its peers. Use the daemon's HTTP address (commonly `http://127.0.0.1:8080` for standalone Hashtree). This is the same server list used for media backups. Page-provided server hints cannot select additional destinations. The image limit is 8 MiB, or the Media download limit if lower. The page's image policy must allow data URLs.

Named images use signed public tree pointers from the configured relays. An immutable image link carries its root and can be read offline once its blocks are cached.

## Relay and index behavior

The local archive is a per-account `nostr-pubsub` event bus. Its reader queries the current Hashtree root through `@hashtree/nostr-pubsub`. Its publisher commits signed events, the new root, X source mappings and queued relay deliveries in one local transaction. Batched imports use the same backend and retain the original signed versions for export. A publish completes when that transaction commits, even offline. The shared `nostr-pubsub` outbox fans out to the selected relays in the background. Each relay’s delivery stays queued until that relay acknowledges the event or reconciliation finds it already has a copy.

The extension uses `nostr-pubsub` for history cursors and acknowledged publishing, `nostr-tools` for signing, verification and WebSocket connections, and `@hashtree/nostr` for the event index. A concrete per-relay subscription distinguishes wire EOSE from connection loss. Progress is checkpointed after each complete page. Partial pages preserve verified events for the next attempt, and tied timestamps grow the page size up to a 1,600-event boundary.

Remote relays require `wss://`. Local relays can use `ws://` on `localhost`, `127.0.0.1`, or `[::1]`. The Firefox package explicitly preserves those loopback connections instead of upgrading them to TLS; its connection policy permits HTTPS, WSS and loopback WS only.

The five-minute alarm checks local deadlines and resumes unfinished work. A relay with no pending work stays disconnected between daily polls. Scheduled imports request missing events and overlap the previous day. **Check for older posts** checks all available history matching the download filter, including older, late-arriving events. The paged importer reads up to eight pages per relay per pass. History coverage depends on what each configured relay serves. Read and write operations currently cover relays that accept the connection without NIP-42 authentication.

X deliveries use a persistent outbox and a separate receipt per destination. A rejected or interrupted delivery retries with the same signed event. Removing a destination pauses its queued deliveries. Immutable tree blocks, the new root, event records, the source mapping and new outbox entries commit together in IndexedDB. Hashtree lookups select the latest replaceable event where applicable. The ZIP retains every signed event version seen by this archive.

A manual broadcast uses the same outbox. Public sharing, including the public index and media uploads, remains limited to eligible posts and profiles (kinds 0, 1, 6, 16, 20, 21, 22, 1063, 1111 and 30023). Other kinds, including encrypted messages, stay in the local backup and ZIP. With import enabled, the relay comparison covers the selected history through the start of the sync. The extension uploads queued events missing on that relay and requests relay-only events in batches of up to 100 IDs. It verifies the downloaded events before saving them. An incomplete download keeps the history checkpoint open for retry. If comparison is unavailable, the extension uses paged history reads and direct publishing. [NIP-77 Negentropy](https://github.com/nostr-protocol/nips/blob/master/77.md)

When a relay replies with `rate-limited:` during publication, history reads or Negentropy, the extension pauses that destination and keeps its deliveries queued. `nostr-pubsub` takes the delay from the relay’s response and defaults to one minute when the relay gives no usable delay. The extension stores that deadline in IndexedDB and schedules the next attempt. The deadline survives a browser restart and appears in the archive's relay report. Other relays continue independently. [NIP-01 relay responses](https://github.com/nostr-protocol/nips/blob/master/01.md)

| ZIP entry | Contents |
| --- | --- |
| `events.jsonl` | One signed Nostr event per line, deduplicated by event ID |
| `manifest.json` | Format version, public key, post and media counts, export time and root CID in hex |
| `blocks/<hash>` | Raw hashtree blocks, including retained prior blocks. Decode the root hash and key as bytes and supply a block store to `NostrEventStore` to query the tree offline. |
| `media.json` | Attachment references and status, unique files, SHA-256, byte length, MIME type, Hashtree file CIDs, block hashes and Blossom copy destinations |
| `profile-captures.json` | Instagram and Facebook snapshots and local-only unsigned X captures |
| `social-sources.json` | Instagram and Facebook post IDs mapped to signed event IDs |
| `x-sources.json` | X status IDs mapped to signed event IDs |
| `matched-x-posts.json` | Original X captures linked to existing Nostr notes |
| `unsigned-x-posts.json` | Captures awaiting signature |
| `pending-deliveries.json` | Signed event IDs and relay destinations awaiting acknowledgement |

The ZIP contains readable post data and hashtree content keys. It excludes the Nostr secret key. Export currently assembles the ZIP in browser memory.

## NIP-07

The extension exposes NIP-07 automatically on HTTPS pages allowed by the browser’s extension site-access setting. A website must request approval to read your public key for login. Signing is a separate permission. You can remember login, posts, or reactions independently for each website and account. Other signatures require individual approval. Revoke remembered decisions in **Account → Website permissions**.

## Development

The download site lives in `website/public`. Run `pnpm build:site` to rebuild the extension and assemble the page and browser ZIPs in `website/dist`. With the Wrangler 4 CLI installed and authenticated for `iris.to`, run `pnpm deploy:site` to publish the site.

The extension, scripts, and tests use strict TypeScript. `pnpm build` runs the type checker before esbuild bundles the extension for each browser.

After building, `node --experimental-strip-types scripts/ui-preview.ts` opens a local test server at `http://127.0.0.1:49188/fixtures`. It runs the built UI and background with a disposable account, simulated X captures, and local relays with different acknowledgement delays. The popup preview shares the same account. All Nostr traffic stays on the local fixture server.

```sh
pnpm typecheck
pnpm test
pnpm build
```

The automated suite tests profile creation, archive isolation by public key, logout and local deletion, per-kind event sizes, publishing and resolving the public index from remote blocks, offline media reconstruction, hash verification, Blossom fallback and upload, tab navigation, configured X author checks, nested quotes, media links, exact timestamps, signature rejection, read-only capture restrictions, index recovery, ZIP readback, timestamp collisions during paging, signing approvals and relay retries. A bundled background entry point runs against an in-memory relay speaking Nostr wire messages. The suite uses disposable keys.

`test/live-profile.html` preserves the relevant ancestry of a signed-in X profile inspected in Chrome on 2026-11-11. Account, status ID, body, URLs and timestamp have been replaced. Other fixtures deliberately exercise edge cases. The live check found one rendered own post whose Snowflake timestamp agreed with the DOM to the second and supplied the missing milliseconds.

For an installed-extension smoke test, start a current ChromeDriver or geckodriver on port 4444, then run one command per matching driver. Chrome for Testing supports unpacked extension automation. Set `BROWSER_BINARY` for a non-default installation or `DRIVER_URL` for another local driver endpoint.

For Firefox, start `geckodriver --host 127.0.0.1 --port 4444 --allow-system-access`. Current Firefox requires this driver flag to let the test open the extension's own pages. Use it only with the disposable test profile.

```sh
pnpm test:browser chrome
pnpm test:browser firefox
```

The driver creates a disposable profile, temporarily installs the built extension, serves an intercepted X fixture, and runs a loopback WebSocket relay. It checks the options page, capture, signing, publication receipt, relay import and archive counts. For a browser-engine check without installing the extension, run `pnpm test:page` and open `build/browser-check.html` locally. It exercises DOM extraction, native IndexedDB, signing and ZIP readback using disposable data.

## Protocol references

[NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) · [NIP-07](https://github.com/nostr-protocol/nips/blob/master/07.md) · [NIP-73](https://github.com/nostr-protocol/nips/blob/master/73.md) · [nos2x](https://github.com/fiatjaf/nos2x) · [nostr-pubsub](https://github.com/mmalmi/nostr-pubsub) · [hashtree](https://github.com/mmalmi/hashtree) · [Safari packaging](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari)
