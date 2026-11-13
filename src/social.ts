import { isMetaMedia } from './social-media.ts';
import type { CaptureDelivery, Settings, SocialCapture, SocialNetwork } from './types.ts';
import { instagramPermalink, instagramProfile } from './instagram.ts';
import { facebookPermalink, facebookProfile } from './facebook.ts';

export const socialNetworks = ['instagram', 'facebook'] as const;
export const captureSites = ['https://x.com/*', ...socialNetworks.flatMap(network =>
  ['https://' + network + '.com/*', 'https://www.' + network + '.com/*'])];

export function captureNetwork(url?: string) {
  if (!url) return;
  try {
    const origin = new URL(url).origin;
    if (origin === 'https://x.com') return 'x';
    return socialNetworks.find(site => origin === 'https://' + site + '.com' || origin === 'https://www.' + site + '.com');
  } catch { return; }
}

export function socialProfile(network: SocialNetwork, url: string) {
  return network === 'instagram' ? instagramProfile(url) : facebookProfile(url);
}

export function socialSettings(input: Settings['social'], previous: Settings['social'] = {}) {
  if (input === undefined) return previous;
  const result: Settings['social'] = { ...previous };
  for (const network of socialNetworks) {
    const value = input[network];
    if (value === undefined) continue;
    const handle = value.handle.trim().replace(/^@/, '').toLowerCase();
    if (handle && socialProfile(network, 'https://www.' + network + '.com/' + handle + '/') !== handle)
      throw Error('Enter your ' + (network === 'instagram' ? 'Instagram username' : 'Facebook username or numeric profile ID') + '.');
    result[network] = { handle, capture: value.capture === true };
  }
  return result;
}

export function canDeliverCapture(row: CaptureDelivery, conf: Settings) {
  return !!row.broadcast || (row.network ? !!conf.social?.[row.network]?.capture : conf.capture);
}

export function validateSocialPost(post: SocialCapture, network: SocialNetwork, handle: string) {
  const permalink = network === 'instagram' ? instagramPermalink : facebookPermalink;
  if (post.source !== network || post.author !== handle || !post.id || typeof post.url !== 'string' ||
      captureNetwork(post.url) !== network || permalink(post.url, handle) !== post.id ||
      !['public', 'unknown', 'private'].includes(post.visibility) ||
      !Number.isSafeInteger(post.time) || post.time < 1 || post.time > Date.now() / 1000 + 300 ||
      typeof post.text !== 'string' || !post.text.trim() || post.text.length > 120000)
    throw Error('Invalid social post.');
  for (const urls of [post.media, post.posters]) {
    if (urls === undefined) continue;
    if (!Array.isArray(urls) || urls.length > 100 || !urls.every(isMetaMedia))
      throw Error('Invalid attachment.');
  }
}

export function socialTemplate(post: SocialCapture) {
  if (post.visibility !== 'public') throw Error('Only public posts can be prepared for sharing.');
  const media = [...new Set([...(post.media ?? []), ...(post.posters ?? [])])];
  const content = [post.text, ...media.filter(url => !post.text.includes(url))].join('\n\n');
  return {
    kind: 1, created_at: post.time, content,
    tags: [['r', post.url], ['i', post.url], ['k', 'web'], ['client', 'Social Backup'],
      ...(post.timePrecision === 'day' ? [['time-precision', 'day']] : []),
      ...media.map(url => ['imeta', 'url ' + url])],
  };
}
