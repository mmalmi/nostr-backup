# Social Backup review instructions

Open the extension’s toolbar button. For a read-only check, choose Sign in and enter a public Nostr user ID (npub) you control. No password or payment is required. For a disposable writable account, choose Sign up and enter a test display name. The extension generates the key locally and publishes the display name and public key to its configured relays. When payment data is permitted, signup also publishes the corresponding npub.cash receiving address. Account can add or remove this address.

1. Open Backup. Check the relay list, sync and download a ZIP. Inspect events.jsonl and manifest.json. An empty test account has little content until a relay supplies events or a profile is backed up.
2. To test profile capture, save a test X username under Sources with backup enabled, visit that profile and scroll to a public post. Backup shows captures and signed posts. Confirmed public posts may be republished. Use only test material intended for publication. The local fixture tests below cover this flow without real accounts.
3. Under Sources → X → On Nostr, enable Show tip buttons on X. On Firefox, decline the optional payment-data prompt first; the feature stays off. Enable it again and accept. Buttons appear only for directory matches after a refresh. Opening a button checks the proof and address. Review can stop before requesting an invoice or paying. Open Cashu wallet in Sources to inspect its independent enable switch, mint selection, backup and incoming-payment settings. A mint and real funds are unnecessary to review these controls. Disable the wallet and tip buttons separately. Directory coverage varies. The automated fixtures exercise proof deletion, key changes, changed payment addresses and relay requests during scrolling. In Wallet settings you can enable one-click post tips by saving an amount. Holding the flower or clicking Tip on a profile opens the regular menu, which also accepts a custom amount in sats.
4. Account shows signing permissions and offers Lock account, Log out and Delete local archive. A linked account can withdraw its X claim in Sources. Deleting its proof post on X stops new invoices using that proof.

## Rebuild the attached source

The candidate was built on macOS arm64 with Node 26.12.1 and pnpm 10.28.2. Use the same versions. Unzip the source into a new directory. With Node installed, run:

```sh
npm install --global pnpm@10.28.2
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

The two store archives are dist/social-backup-chrome.zip and dist/social-backup-firefox.zip. The source contains the lockfile, TypeScript and Svelte sources, packaging scripts, icons, HTML and test fixtures. The build uses esbuild and the Svelte compiler. The install step fetches pinned packages from npm and versioned project releases through pnpm. Building requires no credentials, signing service or production relay. The fixture suite generates disposable identities and uses local relay and website responses.
