import { generateSecretKey } from 'nostr-tools/pure';
import { nsecEncode } from 'nostr-tools/nip19';
import { el, notice, on, send } from './ui.ts';

function showNameForm() {
  el('newProfile').reset();
  el('loginForm').reset();
  el('watch').reset();
  el('usePrivate').checked = true;
  el('loginForm').hidden = false;
  el('watch').hidden = true;
  el('newProfile').hidden = true;
  el('existingLogin').hidden = true;
  el('nameForm').hidden = false;
}

export function resetOnboarding() {
  el('nameForm').reset();
  showNameForm();
}

export function setupOnboarding(openBackup: () => Promise<void>) {
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
  on('cancelProfile', 'click', back);
  on('cancelLogin', 'click', back);
  window.addEventListener('pagehide', resetOnboarding);
  on('nameForm', 'submit', () => {
    const field = el('profileName');
    const name = field.value.trim();
    if (!name) {
      field.focus();
      throw Error('Enter your name.');
    }
    // A pasted Nostr key belongs in sign-in, never in public profile metadata.
    if (/^(nsec1|npub1)/i.test(name) || /^[a-f0-9]{64}$/i.test(name)) {
      field.value = '';
      showLogin();
      if (/^npub1/i.test(name)) {
        el('usePublic').click();
        el('watchKey').value = name;
      } else if (/^nsec1/i.test(name)) {
        el('loginKey').value = name;
      } else {
        notice('Choose your key type and enter your hex key to sign in.');
      }
      return;
    }
    notice('');
    el('recoveryKey').value = nsecEncode(generateSecretKey());
    el('nameForm').hidden = true;
    el('newProfile').hidden = false;
    el('recoveryKey').focus();
  });
  on('existingProfile', 'click', showLogin);
  on('keyChoice', 'change', () => {
    const readOnly = el('usePublic').checked;
    el('loginForm').reset();
    el('watch').reset();
    el('loginForm').hidden = readOnly;
    el('watch').hidden = !readOnly;
    notice('');
    el(readOnly ? 'watchKey' : 'loginKey').focus();
  });
  on('newProfile', 'submit', async () => {
    if (!el('keySaved').checked) throw Error('Save your private key before creating the profile.');
    await send('createProfile', {
      key: el('recoveryKey').value,
      name: el('profileName').value,
      account: '',
    });
    await openBackup();
    notice(
      'Profile created locally. Choose Broadcast in Backup to publish it to your saved relays.',
    );
  });
  on('loginForm', 'submit', async () => {
    const key = el('loginKey').value;
    el('loginKey').value = '';
    await send('login', { key, account: '' });
    await openBackup();
    notice('Logged in.');
  });
  on('watch', 'submit', async () => {
    await send('watch', { pubkey: el('watchKey').value, account: '' });
    await openBackup();
    notice('Read-only backup opened.');
  });
}
