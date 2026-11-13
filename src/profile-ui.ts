import { npubEncode } from 'nostr-tools/nip19';
import type { Profile } from './types.ts';
import { el } from './ui.ts';

export function showProfile(pubkey: string, profile?: Profile, readOnly = false) {
  const panel = el('signedInProfile');
  if (pubkey) panel.setAttribute('href', 'https://iris.to/' + npubEncode(pubkey));
  else panel.removeAttribute('href');
  panel.hidden = !pubkey;
  el('profileMode').hidden = !pubkey || !readOnly;
  const avatar = el('profileAvatar');
  const initials = el('profileInitials');
  const name = profile?.displayName || 'Your profile';
  el('displayName').textContent = name;
  el('profileIdentity').textContent =
    profile?.name && profile.name !== name ? '@' + profile.name : '';
  el('profileIdentity').hidden = !el('profileIdentity').textContent;
  initials.textContent = profile?.displayName
    ? [...profile.displayName][0].toUpperCase()
    : 'N';
  const picture = pubkey ? profile?.picture : undefined;
  if (avatar.getAttribute('src') !== (picture ?? null)) {
    avatar.hidden = true;
    initials.hidden = false;
    avatar.onload = () => {
      avatar.hidden = false;
      initials.hidden = true;
    };
    avatar.onerror = () => {
      avatar.hidden = true;
      initials.hidden = false;
    };
    if (picture) avatar.src = picture;
    else avatar.removeAttribute('src');
  }
}
