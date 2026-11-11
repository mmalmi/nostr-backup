# Nostr Backup

A Chrome and Firefox extension that archives your own posts as you scroll your X profile. It signs X copies as Nostr kind 1 notes, imports your signed posts from the relays you choose, and keeps both in a local, exportable hashtree.

## Install

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

The build also writes a ZIP for each browser. Unzip the Chrome package before loading it. Firefox release distribution requires a Mozilla-signed package. Export your archive before removing or replacing a temporary installation.

## First backup

1. Open **Nostr Backup → Open archive**. Enter your npub or hex public key and one WebSocket relay URL per line. The archive is bound to that identity.
2. Enable **Import my Nostr posts** to back up notes with just the public key. The importer requests kinds 1, 6, 16, 20, 1111, and 30023 and verifies the author, event ID and signature.
3. To mirror X, enter your handle and enable capture. **Save settings**, then unlock using the matching nsec in the extension page. It stays in browser session storage and is cleared by **Lock signer** or browser restart.
4. Visit your own signed-in X profile and scroll. The extension requires agreement between the profile route, the signed-in navigation link, and the post author's timestamp permalink. It handles Posts, Replies and Media profile tabs. A locked signer queues captures on disk.
5. **Download ZIP** exports a snapshot. The archive screen shows local signed posts, captures awaiting signature, pending deliveries, and the most recent result for each relay.

**Publishing is public on public relays.** Enabling X capture also enables publishing, even for a protected X profile. The extension starts with capture off and an empty relay list. A relay import by itself never republishes the imported events.

## What gets preserved

Each X copy keeps the original publication second in `created_at`, a canonical `https://x.com/<handle>/status/<id>` in its `r` and `i` tags, and a `k` tag of `web`. When source precision is available it adds a custom `["ms", "<Unix milliseconds>"]` tag. It uses explicit subsecond DOM time or decodes a Snowflake ID using integer arithmetic and checks the result against the DOM second. Older IDs with second-only source data retain second precision. Native Nostr events retain their original signatures and tags.

Capture covers rendered text, emoji, visible links, available photo or video-poster URLs and identifiable quote permalinks. Binary media, polls and edit history are outside this version. The first complete capture of each X status ID is retained. Collapsed long posts are skipped while **Show more** is present. Expand them on a supported profile route to capture their text. Scrolling determines which posts load.

## Relay and index behavior

The extension uses `nostr-pubsub` for history cursors and acknowledged publishing, `nostr-tools` for signing, verification and WebSocket connections, and `@hashtree/nostr` for the event index. A concrete per-relay subscription distinguishes wire EOSE from connection loss. Progress is checkpointed after each complete page. Partial pages preserve verified events for the next attempt, and tied timestamps grow the page size up to a 1,600-event boundary.

The five-minute alarm resumes unfinished work. Each pass reads up to eight pages per relay. Incremental scans overlap the previous day. **Rescan relay history** restarts the cursors to find older, late-arriving events. History coverage depends on what each configured relay serves. Read and write operations currently cover relays that accept the connection without NIP-42 authentication.

X deliveries use a persistent outbox and a separate receipt per destination. A rejected or interrupted delivery retries with the same signed event. Removing a destination pauses its queued deliveries. Immutable tree blocks, the new root, event records, the source mapping and new outbox entries commit together in IndexedDB. Hashtree lookups select the latest replaceable event where applicable. The ZIP retains every signed event version seen by this archive.

| ZIP entry | Contents |
| --- | --- |
| `events.jsonl` | One signed Nostr event per line, deduplicated by event ID |
| `manifest.json` | Format version, public key, count, export time and root CID in hex |
| `blocks/<hash>` | Raw hashtree blocks, including retained prior blocks. Decode the root hash and key as bytes and supply a block store to `NostrEventStore` to query the tree offline. |
| `x-sources.json` | X status IDs mapped to signed event IDs |
| `unsigned-x-posts.json` | Captures awaiting signature |
| `pending-deliveries.json` | Signed event IDs and relay destinations awaiting acknowledgement |

The ZIP contains readable post data and hashtree content keys. It excludes the Nostr secret key. Export currently assembles the ZIP in browser memory.

## NIP-07

On an HTTPS site, open the toolbar popup and choose **Enable NIP-07 for this tab**. The page can call `window.nostr.getPublicKey()` and `window.nostr.signEvent(template)`. Each signature requires an extension-owned approval window showing the requesting origin and full event. Enable it again after a reload. Existing providers are preserved. Signing approval expires after one minute.

## Tests

```sh
pnpm test
pnpm build
```

The automated suite tests signed-in ownership, nested quotes, media links, exact timestamps, signature rejection, locked capture, index recovery, ZIP readback, timestamp collisions during paging, signing approvals and relay retries. A bundled background entry point runs against an in-memory relay speaking Nostr wire messages. The suite uses disposable keys.

`test/live-profile.html` preserves the relevant ancestry of a signed-in X profile inspected in Chrome on 2026-11-11. Account, status ID, body, URLs and timestamp have been replaced. Other fixtures deliberately exercise edge cases. The live check found one rendered own post whose Snowflake timestamp agreed with the DOM to the second and supplied the missing milliseconds.

For an installed-extension smoke test, start a current ChromeDriver or geckodriver on port 4444, then run one command per matching driver. Chrome for Testing supports unpacked extension automation. Set `BROWSER_BINARY` for a non-default installation or `DRIVER_URL` for another local driver endpoint.

```sh
pnpm test:browser chrome
pnpm test:browser firefox
```

The driver creates a disposable profile, temporarily installs the built extension, serves an intercepted X fixture, and runs a loopback WebSocket relay. It checks the options page, capture, signing, publication receipt, relay import and archive counts. For a browser-engine check without installing the extension, run `pnpm test:page` and open `build/browser-check.html` locally. It exercises DOM extraction, native IndexedDB, signing and ZIP readback using disposable data.

## Protocol references

[NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) · [NIP-07](https://github.com/nostr-protocol/nips/blob/master/07.md) · [NIP-73](https://github.com/nostr-protocol/nips/blob/master/73.md) · [nos2x](https://github.com/fiatjaf/nos2x) · [nostr-pubsub](https://github.com/mmalmi/nostr-pubsub) · [hashtree](https://github.com/mmalmi/hashtree) · [Safari packaging](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari)
