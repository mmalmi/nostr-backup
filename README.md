# Social Backup

Save your own posts from X, Facebook, Instagram and Nostr in a local archive. Export posts and media as a ZIP or share confirmed public posts through Nostr.

[Download and installation instructions](https://socialbackup.org/) · [Privacy policy](website/public/privacy.html) · [Terms of use](website/public/terms.html) · [MIT license](LICENSE)

The X, Facebook and Instagram logos in sign-up are their owners' trademarks, used unmodified under their brand guidelines and not covered by the MIT license.

## First backup

1. Open the extension and choose **Sign up**, or **Sign in** if you are already on Nostr.
   - **Sign up** asks which accounts to back up, filled in from the X and Instagram accounts signed in on tabs you already have open. It then previews the Nostr profile it will publish, prefilled from your X or Instagram profile, and ends by offering to save your secret key.
   - **Sign in** takes your secret key and keeps your Nostr profile as it is. A user ID (`npub`) only opens a read-only copy of what that profile has published.
2. Visit your own profiles and scroll. The extension checks the public originals, signs confirmed public posts, and can send them and their media to your relays and media backup servers. Private and unconfirmed captures stay local. Change usernames and switches later in **Sources**. Posts that are in your backup get a flower with a check on X, Facebook and Instagram; the check compares post IDs on this device, and **Sources** has a switch to hide it. Click the mark to see the post's public copy on Iris.
3. In **Backup**, choose your relays and sync your Nostr events. Use **Media → Back up media** to save attachments. **Download ZIP** exports signed events in `events.jsonl`, local captures, media metadata and Hashtree blocks.

The extension stores an unlocked signing key unencrypted in the browser profile. Save a copy at sign-up or with **Account → Copy secret key** before locking, logging out or uninstalling. The archive ZIP excludes the signing key and can contain private posts. Deleting a local archive cannot recall published copies.

## Optional X links and tips

- **Link X and find who you follow.** In sign-up's "Find each other on Nostr" step, or later under **Sources → X → On Nostr**, post the verification that links your X account. It links as soon as the post shows on X, or when you paste its link. Scroll your X following list, then find those people's verified Nostr profiles and follow them.
- **See people on Nostr.** On an X profile with a verified link, the toolbar popup shows that Nostr profile, its known followers and a Follow button, and the profile header gets a **Nostr** link. Both work from local data, so relays don't learn what you browse.
- **Tips.** Turn on tip buttons and choose a currency under **Sources → Tips**. Tip buttons match X handles locally. Opening one checks the X proof and the current Lightning address. Your wallet approves payment.

To switch keys, post and back up a newer X proof for the new key. Delete the old proof on X to stop new invoices using it. If you still control the old key, **Unlink X account** also withdraws its Nostr claim.

## Signing in to Nostr websites

The extension provides `window.nostr` to websites. Each request opens an approval window. You can remember allowing or declining a kind of request per site, except for changes that replace or delete data, such as your profile or follow list, which always ask. Review and revoke site permissions in **Account**.

## Development

Read [AGENTS.md](AGENTS.md) first: it records the privacy and reliability principles every change follows.

Use Node 22.12 or newer and pnpm 10.28.2.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Load `dist/chrome` as an unpacked extension in Chrome. In Firefox 140+, load `dist/firefox/manifest.json` through `about:debugging` for a temporary install. Normal Firefox distribution requires Mozilla signing. The Safari build is experimental.

## Package for the stores

From the Git checkout, with Python 3 and pnpm available, run:

```sh
pnpm package:stores
```

The command builds from the exact source ZIP supplied to Firefox reviewers. It writes both browser ZIPs, the Firefox source ZIP, listing images and text, privacy policy, reviewer instructions and SHA-256 checksums to **`build/store-<version>/`**. Track new build inputs in Git before packaging. Upload the matching browser ZIP to each store and attach the source ZIP separately on Firefox.

[Store listing and disclosures](store/listing.md) · [Reviewer instructions](store/reviewer.md)

## Other commands

- `pnpm test:browser chrome` or `pnpm test:browser firefox` exercises an installed extension with disposable accounts and a local relay. Start the matching WebDriver on port 4444 first.
- `node --experimental-strip-types scripts/extract-media.ts archive.zip restored-media` extracts and verifies saved media offline.
- `pnpm build:site` assembles the download website and browser packages in `website/dist`.
- `node scripts/graph-followers.ts <nostr-social-graph module> <socialGraph.bin>` regenerates `ui/graph-followers.bin`, the known-follower counts, from the pinned social graph snapshot.
