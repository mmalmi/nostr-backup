# Social Backup: working principles

For people and agents changing this extension. The [privacy policy](website/public/privacy.html) must keep describing
what the code does; update it with any change to what is read, stored or sent.

## Privacy

- **Browsing stays private.** Never let relays or other services learn what you look at on X, Facebook or Instagram.
  Just looking stays local: scrolling, tip buttons appearing, the popup's profile card and the Nostr link work from
  data refreshed independently of browsing. A live check of an X proof goes to X's public page without cookies.
- **A click about someone may ask the network.** Requests about a specific person or post happen only after a click
  meant for them, when fresh data matters: opening a tip (their current Lightning address and identity list, so you
  never pay a stale or changed address), following (your latest follow list), finding the people you follow, and
  setup.
- **Read only what the user configured.** Capture reads the user's own profiles. Account suggestions in setup and Sources read only the
  signed-in account on tabs that are already open.
- **Nothing becomes public by accident.** Publishing posts, profiles, follow lists and X links follows an explicit
  choice. Private and unverified posts stay on the device. Secret keys never end up in public fields.
- **Trust checks, not pages.** Anything that links identities or moves money is confirmed independently: X proofs on
  X's public page, Nostr links against the current identity list, zap receipts against the provider's key.

## Reliability

- **Never wait on relays or the network in the interface.** Save locally and deliver in the background. When
  several sources can answer, ask them at once and use the first good answer.
- **Survive page changes.** X, Facebook and Instagram change their pages without notice. Prefer stable signals
  (links, URL patterns, embedded data) over styling and layout, keep a second way to find things where one exists,
  and always leave a manual path, such as typing a username or pasting a link. When something can't be found,
  fail quietly to that path instead of breaking the page or the flow.

## Delivery

- Run `pnpm typecheck` and `pnpm test` before committing. Visible changes get a visual check.
- Releases are reproducible: `pnpm install --frozen-lockfile`, then two `pnpm build:site` runs must give identical ZIPs.
