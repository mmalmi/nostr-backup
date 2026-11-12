# Nostr Backup

A Chrome and Firefox extension that archives your own posts as you scroll your X profile. It signs X copies as Nostr kind 1 notes, imports your signed posts from the relays you choose, and keeps both in a local, exportable hashtree.

## Install

Browser packages and installation instructions are on [nostrbackup.iris.to](https://nostrbackup.iris.to/). The source is on [git.iris.to](https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/nostr-backup) and [GitHub](https://github.com/mmalmi/nostr-backup).

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
xcrun safari-web-extension-packager dist/safari --app-name "Nostr Backup" --macos-only
```

The build also writes a ZIP for each browser, with fixed entry timestamps so repeated builds from the same inputs produce identical packages. Unzip the Chrome package before loading it. Firefox release distribution requires a Mozilla-signed package. Export your archive before removing or replacing a temporary installation.

## First backup

1. Click the Nostr Backup toolbar icon. Enter your name and choose **Go** to start a new Nostr profile. If you already have a profile, choose **Sign in** and use a private key to sign or a public key to continue read-only. Both accept Nostr-encoded keys (nsec or npub respectively) and 64-character hex keys. Add your relay URLs in **Settings**, one per line.
2. Enable **Import my Nostr posts** to back up notes with just the public key. The importer requests kinds 0, 1, 6, 16, 20, 21, 22, 1063, 1111, and 30023 and verifies the author, event ID and signature.
3. To mirror X, enter your handle and enable capture. Choose **Save settings**. If you opened the archive with a public key, log in with its private key to sign captures.
4. Visit your own signed-in X profile and scroll. The extension requires agreement between the profile route, the signed-in navigation link, and the post author's timestamp permalink. It handles Posts, Replies and Media profile tabs. A locked signer queues captures on disk.
5. **Download ZIP** exports a snapshot. The Backup tab shows local signed posts, captures awaiting signature, pending deliveries, and the most recent result for each relay.
6. **Broadcast to saved relays** sends the signed posts currently in your archive, including imported Nostr posts and signed X copies. With import enabled, the button reads **Broadcast and import** and also checks each saved relay for posts missing from your archive. This works with a locked signer and can restore an empty archive.

**Publishing is public on public relays.** Enabling X capture also enables publishing, even for a protected X profile. The extension starts with capture off and an empty relay list. A relay import by itself never republishes the imported events.

## Profile and local storage

After you enter your name, the extension generates your private key. Save the recovery key and choose **Continue**. The extension stores the signed kind 0 profile in your local archive. Choose **Backup → Broadcast to saved relays** when you want to publish it.

Each public key has its own local archive and settings. **Lock signer** clears the session key and keeps the archive open for capture and relay import. **Log out** pauses backup for that public key and revokes tab signing permissions. Log back in or open the same public key read-only to return to its archive. If you used an earlier version, opening the same profile reopens your original archive.

**Settings → Delete local archive** asks for confirmation and removes the local events, drafts, media, settings and delivery records for the active public key. Copies already sent to relays or Blossom and ZIPs downloaded to disk can still be read.

Open **Storage** for event versions, index blocks and bytes, media counts and sizes, and queued work. Expand a kind to see individual indexed event IDs, timestamps and exact encoded payload sizes. The current index selects the latest replaceable profile, while the archive retains the signed versions it has seen. Block totals include index structure and retained blocks. Choose **Refresh statistics** for an updated count.

## Public event index

**Backup → Public event index** displays your copyable `htree://<npub>/my-events` address. To publish it, save a Blossom server and at least one relay, sign in with the archive key, then choose **Publish index**. The extension uploads the blocks reachable from the current event index, then signs a public Hashtree kind 30064 pointer named `my-events`. The extension uses `HashTree.push`, `BlossomStore` and `createNostrRefResolver().publish` from the TypeScript Hashtree packages. The pointer includes the root hash, its read key and a Blossom server hint. Anyone who resolves it can read the signed events and their attachment URLs. Use **Media → Upload saved files** to publish the media bytes themselves.

The Archive page shows the block server, pending relays, acknowledgements and whether the local index has advanced. Choose **Publish index** again to update the same address. Readers need access to a relay that accepted the pointer and a Blossom server holding the blocks. New indexes use 33-byte, suite-prefixed CHK keys. A reader limited to the older 32-byte key format needs an upgrade.

## What gets preserved

Each X copy keeps the original publication second in `created_at`, a canonical `https://x.com/<handle>/status/<id>` in its `r` and `i` tags, and a `k` tag of `web`. When source precision is available it adds a custom `["ms", "<Unix milliseconds>"]` tag. It uses explicit subsecond DOM time or decodes a Snowflake ID using integer arithmetic and checks the result against the DOM second. Older IDs with second-only source data retain second precision. Native Nostr events retain their original signatures and tags.

Capture covers rendered text, emoji, visible links, photos, direct X video MP4 URLs when exposed by the player, video posters, and identifiable quote permalinks. The first complete capture of each X status ID is retained. Collapsed long posts are skipped while **Show more** is present. Expand them on a supported profile route to capture their text. Scrolling determines which posts load. Polls and edit history are outside this version.

## Media backup

Open **Media → Back up media** and keep the archive page open. The extension scans attachment references from existing signed posts as well as new imports. These include X images and posters, direct media links, Nostr `imeta` tags, kind 1063 file metadata, and `blossom:` URIs with server hints. After upgrading, **Rescan relay history** can find older video and file metadata events from the newly supported kinds, as well as earlier kind 0 profiles.

Each completed download is saved in `@hashtree/dexie`, Hashtree’s IndexedDB block store. The archive records the original URL, post ID, plaintext SHA-256, and file CID. Known URLs and hashes reuse the local copy. Other downloads consult the browser HTTP cache. Hash-addressed downloads prefer a cached response and verify its digest. Ordinary URLs follow HTTP freshness rules. A browser may partition its cache by site, so a file viewed on X can require a new download. The extension verifies an advertised hash before saving the file. For a missing or mismatched source it tries attachment fallbacks, Blossom hints, the configured server, and the archive author’s signed kind 10063 server list on the saved relays. [NIP-92](https://github.com/nostr-protocol/nips/blob/master/92.md) · [Blossom media](https://github.com/nostr-protocol/nips/blob/master/B7.md)

The Media page distinguishes saved files, poster-only captures, and unavailable sources. **Back up media** retries unfinished attachments, including after closing the page. **Settings** controls the per-file download limit (64 MiB by default). Downloads use HTTPS and omit credentials. If a host blocks browser access, the Media page can request permission for that host.

**Download file** reads a saved file locally. **Backup → Download ZIP** includes the media index and all referenced blocks. To extract ordinary media files from a ZIP offline, run the command below in this project with dependencies installed. It checks each restored file’s length and SHA-256 and names the output by its hash.

```sh
node --experimental-strip-types scripts/extract-media.ts nostr-backup-2026-11-11.zip restored-media
```

For a remote copy, save a Blossom server in **Settings**, unlock the signer, and choose **Media → Upload saved files**. This uploads the original file bytes to that server with a short-lived authorization scoped to the server and hash. Anyone with the hash may be able to fetch the file. Completed uploads are recorded per server so an interrupted upload can resume on the next click.

## Relay and index behavior

The extension uses `nostr-pubsub` for history cursors and acknowledged publishing, `nostr-tools` for signing, verification and WebSocket connections, and `@hashtree/nostr` for the event index. A concrete per-relay subscription distinguishes wire EOSE from connection loss. Progress is checkpointed after each complete page. Partial pages preserve verified events for the next attempt, and tied timestamps grow the page size up to a 1,600-event boundary.

Remote relays require `wss://`. Local relays can use `ws://` on `localhost`, `127.0.0.1`, or `[::1]`. The Firefox package explicitly preserves those loopback connections instead of upgrading them to TLS; its connection policy permits HTTPS, WSS and loopback WS only.

The five-minute alarm resumes unfinished work. Scheduled imports request missing events and overlap the previous day. **Rescan relay history** checks all available history, including older, late-arriving events. The paged importer reads up to eight pages per relay per pass. History coverage depends on what each configured relay serves. Read and write operations currently cover relays that accept the connection without NIP-42 authentication.

X deliveries use a persistent outbox and a separate receipt per destination. A rejected or interrupted delivery retries with the same signed event. Removing a destination pauses its queued deliveries. Immutable tree blocks, the new root, event records, the source mapping and new outbox entries commit together in IndexedDB. Hashtree lookups select the latest replaceable event where applicable. The ZIP retains every signed event version seen by this archive.

A manual broadcast uses the same outbox. With import enabled, one comparison per relay covers the full history through the start of the sync. The extension uploads queued events missing on that relay and requests relay-only events in batches of up to 100 IDs. It verifies the downloaded posts before saving them. An incomplete download keeps the history checkpoint open for retry. If comparison is unavailable, the extension uses paged history reads and direct publishing. [NIP-77 Negentropy](https://github.com/nostr-protocol/nips/blob/master/77.md)

When a relay replies with `rate-limited:` during publication, history reads or Negentropy, the extension pauses that destination and keeps its deliveries queued. The pinned TypeScript build of `nostr-pubsub` exposes the relay's millisecond retry parameter or an explicit delay such as `retry in 4s` in the reason. The extension stores the retry deadline in IndexedDB and uses one minute when the relay gives no usable delay. The deadline survives a browser restart and appears in the archive's relay report. Other relays continue independently. [NIP-01 relay responses](https://github.com/nostr-protocol/nips/blob/master/01.md) · [Upstream change](https://github.com/mmalmi/nostr-pubsub/pull/1)

| ZIP entry | Contents |
| --- | --- |
| `events.jsonl` | One signed Nostr event per line, deduplicated by event ID |
| `manifest.json` | Format version, public key, post and media counts, export time and root CID in hex |
| `blocks/<hash>` | Raw hashtree blocks, including retained prior blocks. Decode the root hash and key as bytes and supply a block store to `NostrEventStore` to query the tree offline. |
| `media.json` | Attachment references and status, unique files, SHA-256, byte length, MIME type, Hashtree file CIDs, block hashes and Blossom copy destinations |
| `x-sources.json` | X status IDs mapped to signed event IDs |
| `unsigned-x-posts.json` | Captures awaiting signature |
| `pending-deliveries.json` | Signed event IDs and relay destinations awaiting acknowledgement |

The ZIP contains readable post data and hashtree content keys. It excludes the Nostr secret key. Export currently assembles the ZIP in browser memory.

## NIP-07

On an HTTPS site, open the toolbar popup and choose **Enable NIP-07 for this tab**. The page can call `window.nostr.getPublicKey()` and `window.nostr.signEvent(template)`. Each signature requires an extension-owned approval window showing the requesting origin and full event. Enable it again after a reload. Existing providers are preserved. Signing approval expires after one minute.

## Development

The download site lives in `website/public`. Run `pnpm build:site` to rebuild the extension and assemble the page and browser ZIPs in `website/dist`. With the Wrangler 4 CLI installed and authenticated for `iris.to`, run `pnpm deploy:site` to publish the site.

The extension, scripts, and tests use strict TypeScript. `pnpm build` runs the type checker before esbuild bundles the extension for each browser.

```sh
pnpm typecheck
pnpm test
pnpm build
```

The automated suite tests profile creation, archive isolation by public key, logout and local deletion, per-kind event sizes, publishing and resolving the public index from remote blocks, offline media reconstruction, hash verification, Blossom fallback and upload, tab navigation, signed-in ownership, nested quotes, media links, exact timestamps, signature rejection, locked capture, index recovery, ZIP readback, timestamp collisions during paging, signing approvals and relay retries. A bundled background entry point runs against an in-memory relay speaking Nostr wire messages. The suite uses disposable keys.

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
