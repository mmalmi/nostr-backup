<script lang="ts">
  import { paymentConsent } from '../tip-consent.ts';
  import { localCurrency, TIP_CURRENCIES } from '../rates.ts';
  import { notice } from '../ui.ts';

  // Tip settings save as they change, with the other Sources settings.
  let {
    enabled = $bindable(false),
    currency = $bindable(''),
    lightning,
    onchange,
  }: { enabled?: boolean; currency?: string; lightning?: string; onchange: () => void } = $props();

  const automatic = localCurrency(navigator.languages ?? []);
  const names = new Intl.DisplayNames(undefined, { type: 'currency' });
  const name = (code: string) => {
    try {
      return names.of(code) ?? code;
    } catch {
      return code;
    }
  };

  // Firefox asks for permission to handle payment data before tips turn on.
  async function toggle(event: Event) {
    const field = event.currentTarget as HTMLInputElement;
    try {
      enabled = field.checked && (await paymentConsent(true));
      onchange();
    } catch (e) {
      enabled = false;
      notice((e as Error).message);
    }
    field.checked = enabled;
  }
  function choose(event: Event) {
    currency = (event.currentTarget as HTMLSelectElement).value;
    onchange();
  }
</script>

<section class="source" aria-labelledby="tipsTitle">
  <h3 id="tipsTitle">Tips</h3>
  <p class="hint">
    Tip people in Bitcoin when their X account has a verified Nostr link, straight to their own wallet. Works even if X
    doesn't pay them.
  </p>
  <label class="check"><input type="checkbox" id="tipButtons" checked={enabled} onchange={toggle} /> Show tip buttons on X</label>
  <label for="tipCurrency">Show amounts in</label>
  <select id="tipCurrency" value={currency} onchange={choose}>
    <option value="">Automatic · {automatic}</option>
    {#each TIP_CURRENCIES as code (code)}
      <option value={code}>{code} · {name(code)}</option>
    {/each}
  </select>
  <p class="hint">
    {#if lightning}Tips to you go to <strong>{lightning}</strong>, the Lightning address in your Nostr profile.
    {:else}To receive tips, add a Lightning address to your Nostr profile.{/if}
  </p>
  <p class="hint">
    X accounts are matched on this device. Opening a tip checks the X proof and the current Lightning address, and
    choosing an amount sends the recipient and amount to their payment provider.
  </p>
  <a class="button secondary" href="wallet.html" target="_blank" rel="noopener">Open Cashu wallet</a>
</section>
