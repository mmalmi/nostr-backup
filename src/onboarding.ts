import { loginKey } from './model.ts';
import { el, notice, on, send } from './ui.ts';

function showNameForm() {
  el('loginForm').reset();
  el('existingLogin').hidden = true;
  el('nameForm').hidden = false;
}

export function resetOnboarding() {
  el('nameForm').reset();
  showNameForm();
}

export function setupOnboarding(openBackup: () => Promise<void>) {
  let signingIn = false;
  async function signIn(submitted = false) {
    if (signingIn) return;
    const field = el('loginKey');
    const value = field.value.trim();
    let parsed: ReturnType<typeof loginKey>;
    try {
      parsed = loginKey(value);
    } catch {
      if (submitted || value.length >= 63) notice('Invalid key.');
      else notice('');
      return;
    }
    signingIn = true;
    field.disabled = true;
    field.value = '';
    notice('Signing in…');
    try {
      if (parsed.type === 'watch') await send('watch', { pubkey: parsed.key, account: '' });
      else await send('login', { key: parsed.key, account: '' });
      await openBackup();
      notice('');
    } finally {
      signingIn = false;
      field.disabled = false;
    }
  }
  function back() {
    showNameForm();
    notice('');
    el('profileName').focus();
  }
  function showLogin() {
    el('nameForm').hidden = true;
    el('existingLogin').hidden = false;
    notice('');
    el('loginKey').focus();
  }
  on('cancelLogin', 'click', back);
  on('signupLink', 'click', back);
  window.addEventListener('pagehide', resetOnboarding);
  async function usePastedKey() {
    const field = el('profileName');
    const value = field.value.trim();
    if (!/^(nsec1|npub1)/i.test(value) && !/^[a-f0-9]{64}$/i.test(value)) return false;
    field.value = '';
    showLogin();
    el('loginKey').value = value;
    await signIn();
    return true;
  }
  on('profileName', 'input', usePastedKey);
  on('nameForm', 'submit', async () => {
    const field = el('profileName');
    const name = field.value.trim();
    if (!name) {
      field.focus();
      throw Error('Enter your name.');
    }
    // Keys pasted into the name field must never become public profile metadata.
    if (await usePastedKey()) return;
    notice('');
    if (signingIn) return;
    signingIn = true;
    try {
      await send('createProfile', { name, account: '' });
      await openBackup();
    } finally {
      signingIn = false;
    }
  });
  on('existingProfile', 'click', showLogin);
  on('existingProfileLink', 'click', showLogin);
  on('loginKey', 'input', () => signIn());
  on('loginKey', 'change', () => signIn(true));
  on('loginForm', 'submit', () => signIn(true));
}
