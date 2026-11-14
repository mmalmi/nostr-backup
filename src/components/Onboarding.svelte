<script lang="ts">
  import { tick } from 'svelte';
  import { handlePattern, loginKey } from '../model.ts';
  import { socialSettings } from '../social.ts';
  import type { NewProfile } from '../types.ts';
  import { notice, send } from '../ui.ts';
  import AccountFields, { type Usernames } from './AccountFields.svelte';
  import { app, page } from './page.svelte.ts';

  // Sign-up asks which accounts to back up, then shows the profile it will publish,
  // prefilled from the X account when there is one.
  let step = $state<'accounts' | 'profile' | 'signin'>('accounts');
  let previous: 'accounts' | 'profile' = 'accounts';
  let usernames = $state<Usernames>({ x: '', facebook: '', instagram: '' });
  let detected = $state('');
  let edited = false;
  let profile = $state<NewProfile>({ name: '' });
  let filledFrom = '';
  let loading = $state(false);
  let signingIn = false;
  let keyDisabled = $state(false);
  let xField: HTMLElement;
  let nameField: HTMLInputElement;
  let keyField: HTMLInputElement;

  const clean = (value: string) => value.trim().replace(/^@/, '').toLowerCase();

  // Fields are read and cleared directly so a pasted key leaves the page at once.
  export function reset() {
    if (keyField) keyField.value = '';
    step = 'accounts';
    usernames = { x: '', facebook: '', instagram: '' };
    profile = { name: '' };
    detected = filledFrom = '';
    edited = false;
  }
  export function focus() {
    (step === 'signin' ? keyField : step === 'profile' ? nameField : xField?.querySelector('input'))?.focus();
  }
  // A different profile, or none, always starts from a clean form.
  let owner: string | undefined;
  $effect(() => {
    if (!page.status) return;
    const pubkey = page.status.conf.pubkey;
    if (pubkey !== owner) {
      owner = pubkey;
      reset();
      if (!pubkey) void detect();
    }
  });
  $effect(() => {
    const again = () => {
      if (step === 'accounts' && !page.status?.conf.pubkey) void detect();
    };
    addEventListener('pagehide', reset);
    // Coming back from a newly opened X tab picks up its account.
    addEventListener('focus', again);
    return () => {
      removeEventListener('pagehide', reset);
      removeEventListener('focus', again);
    };
  });

  // The X account signed in on an open X tab fills the X field until you type in it.
  async function detect() {
    const found = (await send('detectAccounts').catch(() => undefined))?.x;
    if (!found || edited || step !== 'accounts') return;
    detected = found;
    usernames.x = found;
  }

  async function show(next: typeof step) {
    if (step !== 'signin') previous = step;
    step = next;
    notice('');
    await tick();
    focus();
  }

  async function next() {
    const handle = clean(usernames.x);
    if (handle && !handlePattern.test(handle)) throw Error('Enter your X username.');
    socialSettings({
      instagram: { handle: usernames.instagram, capture: true },
      facebook: { handle: usernames.facebook, capture: true },
    });
    page.accounts = { ...usernames };
    // The X profile's public name, picture, banner, description and website, once per username.
    if (handle && handle !== filledFrom) {
      loading = true;
      try {
        const found = await send('xProfile', { handle }).catch(() => null);
        if (found) {
          profile = { ...found };
          filledFrom = handle;
        }
      } finally {
        loading = false;
      }
    }
    await show('profile');
  }
  async function skip() {
    page.accounts = { x: '', facebook: '', instagram: '' };
    await show('profile');
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
    nameField.value = profile.name = '';
    await show('signin');
    keyField.value = value;
    await signIn();
    return true;
  }
  async function createProfile() {
    if (!profile.name.trim()) {
      nameField.focus();
      throw Error('Enter your name.');
    }
    if (await usePastedKey()) return;
    notice('');
    if (signingIn) return;
    signingIn = true;
    try {
      await send('createProfile', { ...$state.snapshot(profile), account: '' });
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

{#snippet signInLink()}
  <div class="existingProfile">
    <a href="#signin" id="existingProfileLink" onclick={run(() => show('signin'))}>Already have an account?</a>
    <button type="button" class="secondary" id="existingProfile" onclick={run(() => show('signin'))}>Sign in</button>
  </div>
{/snippet}

<form id="accountsForm" class="onboardingStep" hidden={step !== 'accounts'} onsubmit={run(next)}>
  <h2>Which accounts should we back up?</h2>
  <p class="hint">Posts are saved as you scroll your own profile.</p>
  <div bind:this={xField}>
    <AccountFields bind:usernames {detected} onedit={(id) => (edited ||= id === 'x')} />
  </div>
  <div class="setupActions">
    <button type="button" class="quiet" id="skipAccounts" onclick={run(skip)}>Skip</button>
    <button type="submit" id="accountsNext" disabled={loading}>{loading ? 'Loading…' : 'Continue'}</button>
  </div>
</form>

<form id="nameForm" class="onboardingStep" hidden={step !== 'profile'} onsubmit={run(createProfile)}>
  <h2>Sign up</h2>
  <div class="profilePreview" class:withBanner={!!profile.banner}>
    {#if profile.banner}
      <div class="previewBanner">
        <img src={profile.banner} alt="" />
        <button type="button" class="remove" id="removeBanner" aria-label="Remove banner" title="Remove banner"
          onclick={() => (profile.banner = undefined)}>×</button
        >
      </div>
    {/if}
    <div class="previewIdentity">
      <span class="avatar previewAvatar">
        {#if profile.picture}
          <img src={profile.picture} alt="" />
          <button type="button" class="remove" id="removePicture" aria-label="Remove picture" title="Remove picture"
            onclick={() => (profile.picture = undefined)}>×</button
          >
        {:else}{profile.name.trim().slice(0, 1).toUpperCase()}{/if}
      </span>
      <input
        id="profileName"
        bind:this={nameField}
        bind:value={profile.name}
        oninput={run(usePastedKey)}
        aria-label="Your name"
        placeholder="What's your name?"
        autocomplete="off"
        maxlength="100"
        required
      />
    </div>
    <textarea id="profileAbout" bind:value={profile.about} aria-label="About you" placeholder="About you (optional)" rows="4"
      maxlength="1000"></textarea>
    {#if profile.website}
      <p class="previewWebsite">
        <span>{profile.website}</span><button type="button" class="remove" id="removeWebsite" aria-label="Remove website"
          title="Remove website" onclick={() => (profile.website = undefined)}>×</button
        >
      </p>
    {/if}
  </div>
  <p class="hint">Signing up publishes this profile and your public key to Nostr relays. Your secret key is stored on this device.</p>
  <div class="setupActions">
    <button type="button" class="quiet" id="backToAccounts" onclick={run(() => show('accounts'))}>Back</button>
    <button type="submit" id="signUp">Sign up</button>
  </div>
</form>
{#if step !== 'signin'}{@render signInLink()}{/if}

<div id="existingLogin" hidden={step !== 'signin'}>
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
    <a href="#signup" id="signupLink" onclick={run(() => show(previous))}>Don't have an account?</a>
    <button type="button" class="secondary" id="cancelLogin" onclick={run(() => show(previous))}>Sign up</button>
  </div>
</div>
