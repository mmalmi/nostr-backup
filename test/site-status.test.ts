import test from 'node:test';
import assert from 'node:assert/strict';
import { siteBadge, siteState } from '../src/site-status.ts';

const conf = {
  pubkey: 'ab'.repeat(32), handle: 'alice', capture: true,
  social: { instagram: { handle: 'alice.example', capture: true }, facebook: { handle: '', capture: true } },
};

test('the dot is green while a site is backed up, and missing where the site is not set up', () => {
  assert.deepEqual(siteState('x', conf, true), { level: 'on', text: 'Backing up @alice on X' });
  assert.deepEqual(siteState('instagram', conf, true), { level: 'on', text: 'Backing up @alice.example on Instagram' });
  assert.deepEqual(siteState('facebook', { ...conf, social: { facebook: { handle: 'example.page', capture: true } } }, true),
    { level: 'on', text: 'Backing up example.page on Facebook' });
  // No username or a backup that is off is the user's choice: a sentence for the popup, and no dot.
  assert.deepEqual(siteState('facebook', conf, true), { text: 'Add your Facebook username in Sources' });
  assert.deepEqual(siteState('x', { ...conf, capture: false }, true), { text: 'X backup is off' });
  assert.deepEqual(siteState('instagram', { ...conf, social: {} }, false), { text: 'Instagram backup is off' });
  assert.deepEqual(siteBadge(undefined), { text: '' });
  assert.deepEqual(siteBadge('on'), { text: ' ', color: '#12a15f' });
});

test('the dot is yellow when the backup needs the user, and red when posts are not saved', () => {
  assert.deepEqual(siteState('x', undefined, false), { level: 'attention', text: 'Sign in to back up your posts' });
  assert.deepEqual(siteState('x', { ...conf, pubkey: '' }, true).level, 'attention');
  assert.deepEqual(siteState('x', conf, false), { level: 'attention', text: 'X backup is paused. Enter your secret key in Account' });
  assert.deepEqual(siteState('x', conf, true, { relaysDown: true }),
    { level: 'attention', text: 'Relays are not reachable. New posts stay on this device for now' });
  assert.deepEqual(siteState('x', conf, true, { unsaved: 1 }), { level: 'problem', text: '1 post on this page could not be backed up' });
  assert.deepEqual(siteState('instagram', conf, true, { unsaved: 2, relaysDown: true }),
    { level: 'problem', text: '2 posts on this page could not be backed up' });
  assert.deepEqual(siteState('x', conf, true, { failed: true, unsaved: 3 }), { level: 'problem', text: 'Your posts on this page could not be saved' });
  assert.deepEqual(siteState('x', conf, true, { stale: true, unsaved: 2 }), { level: 'attention', text: 'Reload this page to start the backup' });
  // A page's report means nothing while the backup is paused or off.
  assert.equal(siteState('x', conf, false, { unsaved: 2 }).level, 'attention');
  assert.equal(siteState('x', { ...conf, capture: false }, true, { failed: true }).level, undefined);
  // Yellow and red also differ from green by their mark, not by colour alone.
  assert.equal(siteBadge('attention').text, '!');
  assert.equal(siteBadge('problem').text, '!');
  assert.notEqual(siteBadge('attention').color, siteBadge('problem').color);
});
