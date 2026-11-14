import test from 'node:test';
import assert from 'node:assert/strict';
import { publicXProfile, readPublicXProfile } from '../src/x-audience.ts';
import { profileContent } from '../src/accounts.ts';
import { publicProfileHTML } from './fixtures.ts';

test('the public X profile gives name, bio with full links, large avatar, banner and website', () => {
  const html = publicProfileHTML('Alice', {
    name: 'Alice & Co', bio: 'Shop: https://t.co/a', links: [['https://t.co/a', 'https://shop.example/']],
    avatar: 'https://pbs.twimg.com/profile_images/1/a_normal.png', banner: 'https://pbs.twimg.com/profile_banners/2/3',
    website: 'http://alice.example',
  });
  assert.deepEqual(publicXProfile(html, 'alice'), {
    name: 'Alice & Co',
    about: 'Shop: https://shop.example/',
    picture: 'https://pbs.twimg.com/profile_images/1/a_400x400.png',
    banner: 'https://pbs.twimg.com/profile_banners/2/3/1500x500',
    website: 'http://alice.example/',
  });
  // Another account's page, X's default avatar and a missing banner give nothing extra.
  assert.equal(publicXProfile(html, 'bob'), undefined);
  assert.deepEqual(publicXProfile(publicProfileHTML('bob', { name: 'Bob' }), 'bob'), { name: 'Bob' });
  assert.equal(publicXProfile('<html></html>', 'bob'), undefined);
});

test('the profile is read signed out from its own page', async () => {
  const page = (url: string) => {
    const response = new Response(publicProfileHTML('alice', { name: 'Alice' }), { headers: { 'content-type': 'text/html' } });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  };
  let init: RequestInit | undefined;
  assert.deepEqual(await readPublicXProfile('alice', async (_, options) => ((init = options), page('https://x.com/alice'))), { name: 'Alice' });
  assert.equal(init?.credentials, 'omit');
  // A redirect, for example to a login page, is not the profile.
  assert.equal(await readPublicXProfile('alice', async () => page('https://x.com/i/flow/login')), undefined);
});

test('a new profile publishes only public details with web addresses', () => {
  assert.deepEqual(profileContent({ name: ' Alice ', about: ' Hi ', picture: 'https://a.example/p.png', banner: '', website: 'http://alice.example' }),
    { name: 'Alice', about: 'Hi', picture: 'https://a.example/p.png', website: 'http://alice.example/' });
  assert.throws(() => profileContent({ name: '' }), /name/);
  assert.throws(() => profileContent({ name: 'Alice', about: 'nsec1' + 'q'.repeat(58) }), /secret key/);
  assert.throws(() => profileContent({ name: 'Alice', picture: 'http://a.example/p.png' }), /picture/);
  assert.throws(() => profileContent({ name: 'Alice', website: 'javascript:alert(1)' }), /website/);
});
