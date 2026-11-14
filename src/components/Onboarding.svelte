<script lang="ts">
  import { tick } from 'svelte';
  import { loginKey } from '../model.ts';
  import { notice, send } from '../ui.ts';
  import { app, page } from './page.svelte.ts';

  let signingIn = false;
  let showLogin = $state(false);
  let nameField: HTMLInputElement;
  let keyField: HTMLInputElement;
  let keyDisabled = $state(false);

  // Fields are read and cleared directly so a pasted key leaves the page at once.
  export function reset() {
    nameField.value = '';
    keyField.value = '';
    showLogin = false;
  }
  export function focus() {
    (showLogin ? keyField : nameField).focus();
  }
  // A different profile, or none, always starts from a clean form.
  let owner = '';
  $effect(() => {
    const pubkey = page.status?.conf.pubkey ?? '';
    if (pubkey !== owner) {
      owner = pubkey;
      reset();
    }
  });
  $effect(() => {
    addEventListener('pagehide', reset);
    return () => removeEventListener('pagehide', reset);
  });

  async function openLogin() {
    showLogin = true;
    notice('');
    await tick();
    keyField.focus();
  }
  async function back() {
    keyField.value = '';
    showLogin = false;
    notice('');
    await tick();
    nameField.focus();
  }

  async function signIn(submitted = false) {
    if (signingIn) return;
    const value = keyField.value.trim();
    let parsed: ReturnType<typeof loginKey>;
    try {
      parsed = loginKey(value);
    } catch {
      notice(submitted || value.length >= 63 ? 'Check your secret key or user ID and try again.' : '');
      return;
    }
    signingIn = true;
    keyDisabled = true;
    keyField.value = '';
    notice('Signing in…');
    try {
      if (parsed.type === 'watch') await send('watch', { pubkey: parsed.key, account: '' });
      else {
        await send('login', { key: parsed.key, account: '' });
        page.setup = true;
      }
      await app.refresh(true);
      notice('');
    } finally {
      signingIn = false;
      keyDisabled = false;
    }
  }
  // Keys pasted into the name field must never become public profile metadata.
  async function usePastedKey() {
    const value = nameField.value.trim();
    if (!/^(nsec1|npub1)/i.test(value) && !/^[a-f0-9]{64}$/i.test(value)) return false;
    nameField.value = '';
    await openLogin();
    keyField.value = value;
    await signIn();
    return true;
  }
  async function createProfile() {
    const name = nameField.value.trim();
    if (!name) {
      nameField.focus();
      throw Error('Enter your name.');
    }
    if (await usePastedKey()) return;
    notice('');
    if (signingIn) return;
    signingIn = true;
    try {
      await send('createProfile', { name, account: '' });
      page.setup = true;
      await app.refresh(true);
    } finally {
      signingIn = false;
    }
  }
  const run = (action: () => Promise<unknown>) => (event?: Event) => {
    event?.preventDefault();
    action().catch((e) => notice((e as Error).message));
  };
</script>

<form id="nameForm" hidden={showLogin} onsubmit={run(createProfile)}>
  <h2>Sign up</h2>
  <input
    id="profileName"
    bind:this={nameField}
    oninput={run(usePastedKey)}
    aria-label="Your name"
    placeholder="What's your name?"
    autocomplete="off"
    maxlength="100"
    required
  />
  <p class="hint">Creating a profile publishes your name and public key to Nostr relays. Your secret key is stored on this device.</p>
  <button type="submit">Go</button>
  <div class="existingProfile">
    <a href="#signin" id="existingProfileLink" onclick={run(openLogin)}>Already have an account?</a>
    <button type="button" class="secondary" id="existingProfile" onclick={run(openLogin)}>Sign in</button>
  </div>
</form>
<div id="existingLogin" hidden={!showLogin}>
  <h2>Sign in</h2>
  <p id="loginHelp" class="hint">
    Use your secret key to sign in. To view a backup without making changes, use your user ID instead. Your relays receive the public key to find your posts.
  </p>
  <form id="loginForm" onsubmit={run(() => signIn(true))}>
    <input
      id="loginKey"
      bind:this={keyField}
      disabled={keyDisabled}
      oninput={run(() => signIn())}
      onchange={run(() => signIn(true))}
      type="password"
      aria-label="Secret key or user ID"
      aria-describedby="loginHelp"
      required
      placeholder="Paste your secret key or user ID"
      autocomplete="off"
      spellcheck="false"
    />
  </form>
  <div class="existingProfile">
    <a href="#signup" id="signupLink" onclick={run(back)}>Don't have an account?</a>
    <button type="button" class="secondary" id="cancelLogin" onclick={run(back)}>Sign up</button>
  </div>
</div>
