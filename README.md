# Social Backup

Save your own posts from X, Facebook, Instagram and Nostr in a local archive. Export posts and media as a ZIP or share confirmed public posts through Nostr.

[Download and installation instructions](https://socialbackup.org/) · [Privacy policy](website/public/privacy.html) · [MIT license](LICENSE)

## First backup

1. Open the extension. Sign up to create a Nostr profile and publish your chosen display name, or sign in with an existing key. A public key (`npub`) opens a read-only archive.
2. In **Sources**, save the usernames you want to back up. With a signing key and backup enabled, visit those profiles and scroll. The extension checks the public originals, signs confirmed public posts, and can send them and their media to your configured relays and Blossom servers. Private and unconfirmed captures stay local.
3. In **Backup**, choose your relays and sync your Nostr events. Use **Media → Back up media** to save attachments. **Download ZIP** exports signed events in `events.jsonl`, local captures, media metadata and Hashtree blocks.

The extension stores an unlocked signing key unencrypted in the browser profile. Back it up before locking, logging out or uninstalling. The archive ZIP excludes the signing key and can contain private posts. Deleting a local archive cannot recall published copies.

## Optional X links and tips

Under **Sources → X → On Nostr**, post a verification to link your accounts, find people you follow, or enable Lightning tips. Tip buttons match X handles locally. Opening **Tip** verifies the X proof and looks up the Lightning address by Nostr public key. Your wallet approves payment.

To switch keys, post and back up a newer X proof for the new key. Delete the old proof on X to stop new invoices using it. If you still control the old key, **Unlink X account** also withdraws its Nostr claim.

## Development

Use Node 22.12 or newer and pnpm 10.28.2.

```sh
pnpm install --frozen-lockfile
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
