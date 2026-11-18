# Social Backup

Save your own posts from X, Facebook, Instagram and Nostr in a local archive. Export posts and media as a ZIP or share confirmed public posts through Nostr.

[Download and installation instructions](https://socialbackup.org/) · [Privacy policy](website/public/privacy.html) · [Terms of use](website/public/terms.html) · [MIT license](LICENSE)

The X, Facebook and Instagram logos in sign-up are their owners' trademarks, used unmodified under their brand guidelines and not covered by the MIT license.

## First backup

1. Open the extension and choose **Create profile**, or **Sign in** if you are already on Nostr.
   - **Create profile** asks which accounts to back up, filled in from the X, Facebook and Instagram accounts signed in on tabs you already have open. It then previews the Nostr profile it will publish, prefilled from your X or Instagram profile, and ends by offering to save your secret key.
   - **Sign in** takes your secret key and keeps your Nostr profile as it is. A user ID (`npub`) only opens a read-only copy of what that profile has published.
2. Visit your own profiles and scroll. The extension checks the public originals, signs confirmed public posts, and can send them and their media to your relays and media backup servers. Confirmed X replies are published as Nostr comments on the parent post’s X URL. Private and unconfirmed captures stay local. In **Sources**, you can type a username or select a signed-in account from an open tab, then choose **Save**. Posts that are in your backup get a flower with a check on X, Facebook and Instagram; the check compares post IDs on this device, and **Sources** has a switch to hide it. Click the mark to see the post's public copy on Iris. On these sites the toolbar icon shows a green dot while the backup is on, and a yellow or red mark when it needs you or posts are not saved; the popup says why.
3. In **Backup**, choose your relays and sync your Nostr events. Use **Media → Back up media** to save attachments. **Download ZIP** exports signed events in `events.jsonl`, local captures, media metadata and Hashtree blocks.

The extension stores an unlocked signing key unencrypted in the browser profile. Save a copy during setup or with **Keys & access → Copy secret key** before locking, logging out or uninstalling. The archive ZIP excludes the signing key and can contain private posts. Deleting a local archive cannot recall published copies.

## Optional X links and tips

- **Link X and find who you follow.** In the "Find each other on Nostr" setup step, or later under **Sources → X → Link your X account to Nostr**, post the verification that links your X account. It links as soon as the post shows on X, or when you paste its link. Under **Find your X follows on Nostr**, open your X following list and scroll, then find those people's verified Nostr profiles and follow them.
- **See people on Nostr.** On an X profile with a verified link, the toolbar popup shows that Nostr profile, its known followers and a Follow button. Following-list rows get a flower when the local directory knows a Nostr link, even with tips off. Clicking a flower rechecks the public X proof and current Nostr identity list before opening the profile. Scrolling only uses local data, so relays don't learn what you browse.
- **Tips.** Turn on tip buttons and choose a currency under **Sources → Bitcoin tips on X**. Tip buttons match X handles locally. Opening one checks the X proof and the current Lightning address. Scan the QR code, open the Lightning link or copy the invoice to pay from an external wallet. To pay from this device, open **Cashu wallet** to enable a local balance. Choose a mint you trust, fund the wallet and review the recipient, amount and fee before paying. Click the balance in the toolbar popup or tip menu to open the wallet. **Wallet settings → Turn off wallet** keeps your funds on this device. Choose a preset or enter a custom amount in sats. To tip posts in one click, check **Set as default for one-click post tips** in the tip menu before choosing an amount, then confirm it in Cashu. You can change or disable the default in **Wallet settings**. A short click sends that amount, and holding the flower opens the usual menu. Profile tips always open the menu. A check on the flower marks your settled tips. Opening its menu shows your total and verified public receipts for that post or profile.

New profiles publish their public-key address at npub.cash when payment data is permitted. **Account** lets you add it to a profile without an existing Lightning address, or remove it. In the Cashu wallet, you can check incoming npub.cash payments manually or enable a check every 15 minutes while unlocked. The wallet can claim unlocked payments from its selected mint. Make an encrypted wallet backup before clearing browser storage or uninstalling.

To switch keys, post and back up a newer X proof for the new key. Delete the old proof on X to stop new invoices using it. If you still control the old key, **Unlink X account** also withdraws its Nostr claim.

## Signing in to Nostr websites

The extension provides `window.nostr` to websites. When a site asks for a signature, you can allow or decline once, remember your choice for that event kind (such as reactions), or apply it to all signing requests from that site, including profile changes and deletions. Login has its own permission. Review and revoke a site's choices in **Account → Website permissions**.

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

### Required release tests

`pnpm test` explicitly reports the wallet integration as skipped unless a test mint is configured. Every release must run `pnpm test:release`, which requires a reachable local fake mint, runs type checking and the complete test suite, and cannot skip wallet integration. `pnpm deploy:site` and `pnpm package:stores` run this gate automatically. Wallet tests cover funding, payment and deposit response loss, reopening and concurrent retries, duplicate prevention, fees, account isolation, and encrypted backup restoration against current mint proofs. All funds are simulated.

Use [CDK mintd 0.18.3](https://github.com/cashubtc/cdk/releases/tag/v0.18.3) with [the checked-in fakewallet configuration](test/fake-mint.toml). The official `cdk-mintd-0.18.3-aarch64-apple-darwin` binary used for release testing has SHA-256 `5ad74388ba0825a18e26f6bcd69a66ed5fed4d95c7b69cfb1802886263f5d2b9`; verify it before execution.

```sh
mint_test_dir=$(mktemp -d)
cp test/fake-mint.toml "$mint_test_dir/config.toml"
export CDK_MINTD_MNEMONIC='abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
cdk-mintd -w "$mint_test_dir" config init --new-mint --file "$mint_test_dir/config.toml"
cdk-mintd -w "$mint_test_dir"
```

In another terminal, run `SOCIAL_BACKUP_FAKE_MINT=http://127.0.0.1:48163 pnpm test:release`. Keep this disposable fixture running for deployment or packaging. Browser smoke tests and visible UI checks remain required for affected flows. For a release, install with `pnpm install --frozen-lockfile` and verify that two `pnpm build:site` runs produce identical ZIPs.

Legacy discovery uses only public handle, public-key and proof-post references from nostr.directory's August 10, 2024 snapshot. They are hints, never proof by themselves: X is checked live, and a signed kind 10011 identity list supersedes them, including an empty list. `scripts/legacy-x-proofs.ts` verifies the snapshot checksum and regenerates the compact index. Current claims refresh from selected Nostr relays; **Refresh Nostr matches** also rechecks the candidates' identity lists and X proofs. Identity verification currently supports X; Facebook and Instagram backup does not imply identity verification there.

## Package for the stores

From the Git checkout, with Python 3 and pnpm available, run:

```sh
pnpm package:stores
```

The command builds from the exact source ZIP supplied to Firefox reviewers. It writes both browser ZIPs, the Firefox source ZIP, listing images and text, privacy policy, reviewer instructions and SHA-256 checksums to **`build/store-<version>/`**. Track new build inputs in Git before packaging. Upload the matching browser ZIP to each store and attach the source ZIP separately on Firefox.

[Store listing and disclosures](store/listing.md) · [Reviewer instructions](store/reviewer.md)

## Other commands

- `pnpm test:browser chrome` or `pnpm test:browser firefox` exercises an installed extension with disposable accounts and a local relay. The script uses OpenSSL for a temporary local HTTPS fixture. Start the matching WebDriver on port 4444 first. With Firefox 153 or newer, start geckodriver with `--allow-system-access` so the test can open its own extension page.
- `node --experimental-strip-types scripts/extract-media.ts archive.zip restored-media` extracts and verifies saved media offline.
- `pnpm build:site` assembles the download website and browser packages in `website/dist`.
- `node scripts/graph-followers.ts <nostr-social-graph module> <socialGraph.bin>` regenerates `ui/graph-followers.bin`, the known-follower counts, from the pinned social graph snapshot.
