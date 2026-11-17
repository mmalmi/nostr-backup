import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { Window, type HTMLInputElement } from 'happy-dom';
import { svelte } from '../scripts/svelte.ts';

const bundle = await build({
  stdin: { contents: `import {mount} from 'svelte'; import Panel from './src/components/XOnNostr.svelte';
    mount(Panel, {target:document.getElementById('app'),props:{view:{conf:{handle:'me',pubkey:'ab'.repeat(32)},unlocked:true,xFollows:200,xFollowingTotal:200}}});`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, minify: true, write: false, format: 'iife', plugins: [svelte],
});
const matches = Array.from({ length: 200 }, (_, n) => ({
  handle: 'person' + String(n).padStart(3, '0'), name: 'Person ' + String(n).padStart(3, '0'), pubkey: (n + 1).toString(16).padStart(64, '0'),
}));
async function until(check: () => boolean) {
  for (let n = 0; n < 50; n++) { if (check()) return; await delay(10); }
  assert.fail('Following UI did not reach the expected state');
}

test('200 matches stay paged and searchable, hide existing follows, and never display public-key codes', async t => {
  const page = new Window({ url: 'https://extension.test/archive.html' });
  t.after(() => page.happyDOM.abort());
  page.document.body.innerHTML = '<div id="app"></div><p id="notice"></p>';
  const followed = new Set(matches.slice(0, 20).map(m => m.pubkey));
  const published: string[][] = [];
  let queries = 0, finish: (() => void) | undefined;
  Object.defineProperty(page, 'chrome', { value: { runtime: { async sendMessage(message: { type: string; pubkeys?: string[] }) {
    if (message.type === 'findXFollows') {
      queries++;
      return { ok: true, value: { matches, following: [...followed], unchecked: 0 } };
    }
    assert.equal(message.type, 'followOnNostr');
    published.push([...message.pubkeys!]);
    await new Promise<void>(resolve => { finish = resolve; });
    for (const key of message.pubkeys!) followed.add(key);
    return { ok: true, value: message.pubkeys!.length };
  } } } });
  page.eval(bundle.outputFiles[0].text);
  const button = (name: string) => [...page.document.querySelectorAll('button')].find(b => b.textContent.trim() === name)!;
  const text = () => page.document.body.textContent;
  const rows = () => page.document.querySelectorAll('.xMatches li');
  await until(() => !!button('Find my X follows on Nostr'));
  assert.match(text(), /200 of 200 accounts loaded/);
  // Linking is a prominent, closed disclosure. No proof flow opens on initial render.
  const linking = page.document.querySelector('details')!;
  assert.equal(linking.open, false);
  assert.ok(linking.querySelector('summary.button.primary'));
  button('Find my X follows on Nostr').click();
  await until(() => rows().length === 10);
  assert.equal(linking.open, false);
  assert.match(text(), /200 on Nostr · 20 already following/);
  assert.ok(button('Follow 180 on Nostr'));
  assert.match(rows()[0].textContent, /Person 020/);
  assert.doesNotMatch(text(), /[a-f0-9]{8}…|[a-f0-9]{64}|npub1/);
  assert.match(rows()[0].querySelector('a')!.href, /^https:\/\/iris\.to\/npub1/);
  button('Next').click();
  await until(() => /Person 030/.test(rows()[0].textContent));
  rows()[0].querySelector('input')!.click();
  await until(() => !!button('Follow 179 on Nostr'));
  button('Previous').click();
  await until(() => /Person 020/.test(rows()[0].textContent));
  button('Next').click();
  await until(() => /Person 030/.test(rows()[0].textContent));
  assert.equal(rows()[0].querySelector('input')!.checked, false);
  button('Refresh Nostr matches').click();
  await until(() => queries === 2 && !button('Refresh Nostr matches').disabled);
  assert.equal(rows()[0].querySelector('input')!.checked, false, 'Refreshing must keep deliberate exclusions');
  const search = page.document.querySelector<HTMLInputElement>('input[type="search"]')!;
  search.value = '@person199';
  search.dispatchEvent(new page.Event('input', { bubbles: true }));
  await until(() => rows().length === 1);
  assert.ok(button('Follow 1 on Nostr'));
  assert.equal(queries, 2, 'Search and paging stay local');
  button('Clear selection').click();
  await until(() => !!button('Follow 0 on Nostr'));
  assert.equal(button('Follow 0 on Nostr').disabled, true);
  button('Select all results').click();
  await until(() => !!button('Follow 1 on Nostr'));
  button('Follow 1 on Nostr').click();
  button('Follow 1 on Nostr')?.click();
  await until(() => !!finish);
  assert.deepEqual(published, [[matches[199].pubkey]], 'Bulk follow acts on the filtered selection only');
  finish!();
  await until(() => /21 already following/.test(text()));
  assert.equal(rows().length, 0);
  const show = [...page.document.querySelectorAll('label')].find(l => l.textContent.includes('Show already following'))!;
  show.querySelector('input')!.click();
  await until(() => rows().length === 1);
  assert.equal(rows()[0].querySelector('input')!.disabled, true);
  assert.match(rows()[0].textContent, /Following/);
});
