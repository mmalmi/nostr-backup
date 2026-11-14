<script lang="ts">
  import { tick } from 'svelte';
  import { handlePattern, loginKey } from '../model.ts';
  import { socialSettings } from '../social.ts';
  import type { NewProfile } from '../types.ts';
  import { notice, send } from '../ui.ts';
  import AccountFields, { type Usernames } from './AccountFields.svelte';
  import WizardSteps from './WizardSteps.svelte';
  import { app, page } from './page.svelte.ts';

  // A new user signs up: which accounts to back up, then the profile it will publish, prefilled
  // from the X account when there is one. Someone already on Nostr signs in with their key instead.
  let step = $state<'welcome' | 'accounts' | 'profile' | 'signin'>('welcome');
  let previous: 'welcome' | 'accounts' | 'profile' = 'welcome';
  let usernames = $state<Usernames>({ x: '', facebook: '', instagram: '' });
  // Accounts signed in on open X and Instagram tabs, and the Instagram profile found there.
  let detected = $state<Partial<Usernames>>({});
  let instagramProfile: NewProfile | undefined;
  const edited = new Set<keyof Usernames>();
  let profile = $state<NewProfile>({ name: '' });
  // Profile details you typed or removed are never replaced by ones that arrive later.
  const touched = new Set<keyof NewProfile>();
  let filledFrom = '';
  let loading = $state(false);
  let signingIn = false;
  let keyDisabled = $state(false);
  let xField: HTMLElement;
  let nameField: HTMLInputElement;
  let keyField: HTMLInputElement;
  let startButton: HTMLButtonElement;

  const clean = (value: string) => value.trim().replace(/^@/, '').toLowerCase();
  const chosen = $derived({ x: !!clean(usernames.x), any: Object.values(usernames).some((value) => !!clean(value)) });

  // Fields are read and cleared directly so a pasted key leaves the page at once.
  export function reset() {
    if (keyField) keyField.value = '';
    step = 'welcome';
    usernames = { x: '', facebook: '', instagram: '' };
    profile = { name: '' };
    detected = {};
    instagramProfile = undefined;
    filledFrom = '';
    edited.clear();
    touched.clear();
  }
  export function focus() {
    (step === 'signin' ? keyField : step === 'profile' ? nameField : step === 'accounts' ? xField?.querySelector('input') : startButton)?.focus();
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
      if ((step === 'welcome' || step === 'accounts') && !page.status?.conf.pubkey) void detect();
    };
    addEventListener('pagehide', reset);
    // Coming back from a newly opened X tab picks up its account.
    addEventListener('focus', again);
    return () => {
      removeEventListener('pagehide', reset);
      removeEventListener('focus', again);
    };
  });

  // Accounts signed in on open tabs fill their fields until you type in or clear them.
  async function detect() {
    const found = await send('detectAccounts').catch(() => undefined);
    if (!found || (step !== 'welcome' && step !== 'accounts')) return;
    detected = { x: found.x, instagram: found.instagram };
    instagramProfile = found.instagramProfile;
    for (const id of ['x', 'instagram'] as const) {
      const value = found[id];
      if (value && !edited.has(id)) usernames[id] = value;
    }
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
    // The public profile of the X account, with the signed-in Instagram account filling what X lacks.
    // The profile screen opens at once and fills in as the X profile arrives.
    const instagram = detected.instagram && clean(usernames.instagram) === detected.instagram ? instagramProfile : undefined;
    const source = handle + ' ' + (instagram ? detected.instagram : '');
    await show('profile');
    if (!source.trim() || source === filledFrom) return;
    filledFrom = source;
    if (instagram) fill(instagram);
    loading = !!handle;
    if (!handle) return;
    const fromX = await send('xProfile', { handle }).catch(() => null);
    if (filledFrom !== source) return;
    loading = false;
    if (fromX) fill({ ...instagram, ...fromX });
  }
  function fill(next: Partial<NewProfile>) {
    for (const field of ['name', 'about', 'picture', 'banner', 'website'] as const)
      if (!touched.has(field) && (field !== 'name' || next.name)) profile[field] = next[field] as string;
  }
  function remove(field: 'picture' | 'banner' | 'website') {
    touched.add(field);
    profile[field] = undefined;
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
    page.flow = 'signin';
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
      page.created = true;
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

<div id="welcome" class="onboardingStep" hidden={step !== 'welcome'}>
  <h2>Back up your posts</h2>
  <p class="hint">Keep a copy of your X, Facebook and Instagram posts, and share the public ones on Nostr.</p>
  <button id="startSignUp" class="setupNext" bind:this={startButton} onclick={run(() => ((page.flow = 'signup'), show('accounts')))}
    >Sign up</button
  >
  <!-- Signing in keeps your Nostr profile; setup then links your accounts the same way. -->
  <div class="existingProfile">
    <span>Already on Nostr?</span>
    <button type="button" class="secondary" id="existingProfile" onclick={run(() => ((page.flow = 'signin'), show('signin')))}
      >Sign in</button
    >
  </div>
</div>

<form id="accountsForm" class="onboardingStep" hidden={step !== 'accounts'} onsubmit={run(next)}>
  <WizardSteps flow="signup" current="accounts" {chosen} />
  <h2>Which accounts should we back up?</h2>
  <p class="hint">Posts are saved as you scroll your own profile.</p>
  <div bind:this={xField}>
    <AccountFields bind:usernames {detected} onedit={(id) => edited.add(id)} />
  </div>
  <div class="setupActions">
    <button type="button" class="quiet" id="skipAccounts" onclick={run(skip)}>Skip</button>
    <button type="submit" id="accountsNext">Continue</button>
  </div>
</form>

<form id="nameForm" class="onboardingStep" hidden={step !== 'profile'} onsubmit={run(createProfile)}>
  <WizardSteps flow="signup" current="profile" {chosen} />
  <h2>Sign up</h2>
  <div class="profilePreview" class:withBanner={!!profile.banner}>
    {#if profile.banner}
      <div class="previewBanner">
        <img src={profile.banner} alt="" />
        <button type="button" class="remove" id="removeBanner" aria-label="Remove banner" title="Remove banner"
          onclick={() => remove('banner')}>×</button
        >
      </div>
    {/if}
    <div class="previewIdentity">
      <span class="avatar previewAvatar">
        {#if profile.picture}
          <img src={profile.picture} alt="" />
          <button type="button" class="remove" id="removePicture" aria-label="Remove picture" title="Remove picture"
            onclick={() => remove('picture')}>×</button
          >
        {:else}{profile.name.trim().slice(0, 1).toUpperCase()}{/if}
      </span>
      <input
        id="profileName"
        bind:this={nameField}
        bind:value={profile.name}
        oninput={(event) => {
          touched.add('name');
          run(usePastedKey)(event);
        }}
        aria-label="Your name"
        placeholder={loading ? 'Loading your X profile…' : "What's your name?"}
        autocomplete="off"
        maxlength="100"
        required
      />
    </div>
    <textarea id="profileAbout" bind:value={profile.about} oninput={() => touched.add('about')} aria-label="About you" placeholder="About you (optional)" rows="4"
      maxlength="1000"></textarea>
    {#if profile.website}
      <p class="previewWebsite">
        <span>{profile.website}</span><button type="button" class="remove" id="removeWebsite" aria-label="Remove website"
          title="Remove website" onclick={() => remove('website')}>×</button
        >
      </p>
    {/if}
  </div>
  <p class="hint">Signing up publishes this profile to Nostr, with its own copies of your pictures. Your secret key is stored on this device.</p>
  <div class="setupActions">
    <button type="button" class="quiet" id="backToAccounts" onclick={run(() => show('accounts'))}>Back</button>
    <button type="submit" id="signUp">Sign up</button>
  </div>
</form>

<div id="existingLogin" hidden={step !== 'signin'}>
  <WizardSteps flow={page.flow ?? 'signin'} current="signin" {chosen} />
  <h2>Sign in</h2>
  <p id="loginHelp" class="hint">
    Use your secret key to sign in. Your Nostr profile stays as it is. To view a backup without making changes, use your user ID instead. Your relays receive the public key to find your posts.
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
    <a href="#signup" id="signupLink" onclick={run(() => ((page.flow = 'signup'), show('accounts')))}>Don't have an account?</a>
    <button type="button" class="secondary" id="cancelLogin" onclick={run(() => ((page.flow = 'signup'), show('accounts')))}
      >Sign up</button
    >
  </div>
</div>
