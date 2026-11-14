<script lang="ts">
  import { onMount } from 'svelte';
  import { npubEncode } from 'nostr-tools/nip19';
  import type { Approval } from '../types.ts';
  import { notice, send } from '../ui.ts';
  import { permissionLabel } from '../signer-storage.ts';

  const id = location.hash.slice(1);
  let request = $state<Approval>();
  let remember = $state(false);
  let deciding = $state(false);

  onMount(() => {
    send('approval', { id })
      .then((r) => (request = r))
      .catch((e) => notice(e.message));
  });

  const event = $derived(request?.event);
  const isPost = $derived(event?.kind === 1 && !!event.content.trim());
  const title = $derived(
    !request ? 'Review request' : isPost ? 'Allow this website to use this post?' : event ? 'Approve this request?' : 'Allow website login?',
  );
  const allowLabel = $derived(isPost ? 'Approve post' : event ? 'Approve request' : 'Share user ID');
  const permission = $derived(request ? permissionLabel(event?.kind ?? -1) : undefined);
  // Show invisible direction and spacing characters so a request cannot hide its real content.
  const details = $derived(
    event
      ? JSON.stringify(event, null, 2).replace(
          /[؜​-‏‪-‮⁠-⁩﻿]/g,
          (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'),
        )
      : '',
  );

  async function decide(allow: boolean) {
    deciding = true;
    try {
      await send('approval', { id, decision: allow, remember });
      window.close();
    } catch (e) {
      deciding = false;
      notice((e as Error).message);
    }
  }
</script>

<h1 id="reviewTitle">{title}</h1>
<p id="origin">
  {#if request}
    {event
      ? request.origin +
        ' wants your approval to act as ' +
        npubEncode(request.pubkey) +
        '. Check the details before approving.'
      : request.origin + ' is asking for your user ID to sign you in.'}
  {/if}
</p>
<p id="postPreview" hidden={!isPost}>{isPost ? event?.content : ''}</p>
<details id="requestDetails" hidden={!event} open={!!event}>
  <summary>Request details</summary>
  <pre id="event">{details}</pre>
</details>
<label class="check" id="rememberOption" hidden={!permission}
  ><input type="checkbox" id="remember" bind:checked={remember} />
  <span id="rememberLabel">{permission ? 'Remember my choice for ' + permission + ' on ' + request?.origin : ''}</span></label
>
<div class="actions">
  <button id="deny" class="secondary" disabled={deciding} onclick={() => decide(false)}>Decline</button
  ><button id="allow" disabled={!request || deciding} onclick={() => decide(true)}>{allowLabel}</button>
</div>
