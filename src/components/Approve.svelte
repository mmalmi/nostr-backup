<script lang="ts">
  import { onMount } from 'svelte';
  import { npubEncode } from 'nostr-tools/nip19';
  import type { Approval, ApprovalScope } from '../types.ts';
  import { notice, send } from '../ui.ts';
  import { permissionLabel } from '../signer-storage.ts';

  const id = location.hash.slice(1);
  let request = $state<Approval>();
  let scope = $state<ApprovalScope>('once');
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
      await send('approval', { id, decision: allow, scope });
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
  <summary>Request details{event ? ' · ' + permissionLabel(event.kind) : ''}</summary>
  <pre id="event">{details}</pre>
</details>
{#if request}
  <label for="scope">Apply this decision to
    <select id="scope" value={scope} onchange={(e) => (scope = e.currentTarget.value as ApprovalScope)}
      disabled={deciding} aria-describedby={scope === 'signing' ? 'scopeHint' : undefined}>
      <option value="once">{event ? 'This request only' : 'This login'}</option>
      {#if event}
        <option value="kind">Only {permissionLabel(event.kind)} from this site</option>
        <option value="signing">All signing requests from this site</option>
      {:else}
        <option value="kind">Future logins from this site</option>
      {/if}
    </select>
  </label>
  {#if scope === 'signing'}
    <p class="hint" id="scopeHint">This replaces your signing choices for this site, including posts, profile changes and deletions. You can revoke it in Profile.</p>
  {/if}
{/if}
<div class="actions">
  <button id="deny" class="secondary" disabled={!request || deciding} onclick={() => decide(false)}>{scope === 'once' ? 'Decline' : 'Always decline'}</button>
  <button id="allow" disabled={!request || deciding} onclick={() => decide(true)}>{scope === 'once' ? allowLabel : 'Always allow'}</button>
</div>
