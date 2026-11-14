<script lang="ts">
  import { notice, send } from '../ui.ts';

  // The last sign-up step for a new account: keep a copy of the secret key. Skippable.
  let { pubkey, ondone }: { pubkey: string; ondone: () => void } = $props();
  let saved = $state(false);
  const canShare = typeof navigator.share === 'function';
  const secret = () => send('exportPrivateKey', { account: pubkey });

  const run = (action: () => Promise<unknown>) => () =>
    action().then(
      () => (saved = true),
      (e) => {
        // Closing the share sheet is not an error.
        if ((e as Error).name !== 'AbortError') notice((e as Error).message);
      },
    );
  const saveFile = run(async () => {
    const text = 'Nostr secret key\n\n' + (await secret()) +
      '\n\nAnyone with this key can post as you and read your Nostr private messages. Keep it private.\n';
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'nostr-secret-key.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const share = run(async () => navigator.share({ title: 'Nostr secret key', text: await secret() }));
  const copy = run(async () => {
    await navigator.clipboard.writeText(await secret());
    notice('Secret key copied.');
  });
</script>

<h2 id="setupTitle">Save your secret key</h2>
<p class="hint">
  It's the only way to sign in to your Nostr profile on another device or app. Anyone who has it can post as you and read
  your Nostr private messages, so keep it somewhere safe, like a password manager.
</p>
<div class="keyActions">
  <button class="secondary" id="saveKeyFile" onclick={saveFile}>Save as file</button>
  {#if canShare}<button class="secondary" id="shareKey" onclick={share}>Share</button>{/if}
  <button class="secondary" id="copyKey" onclick={copy}>Copy</button>
</div>
<button id="keyDone" class={saved ? 'setupNext' : 'setupNext quiet'} onclick={ondone}>{saved ? 'Go to your backup' : 'Skip for now'}</button>
