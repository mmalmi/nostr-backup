<script lang="ts">
  import type { SocialNetwork } from '../types.ts';
  import type { SourceSettings, SourcesView } from './views.ts';

  // Switches save as they change. A username saves only when the user chooses Save or presses
  // Enter, because a partial username would back up someone else's profile.
  let { save }: { save: () => Promise<void> } = $props();

  type Source = 'x' | SocialNetwork;
  const sources = ['x', 'instagram', 'facebook'] as const;
  const networks: { id: SocialNetwork; label: string; field: string; placeholder: string }[] = [
    { id: 'instagram', label: 'Instagram', field: 'Username', placeholder: '@yourname' },
    { id: 'facebook', label: 'Facebook', field: 'Username or numeric profile ID', placeholder: 'yourname' },
  ];

  let view = $state<SourcesView>();
  // What is stored, and what is typed into each username field.
  let saved = $state<Record<Source, string>>({ x: '', instagram: '', facebook: '' });
  let typed = $state<Record<Source, string>>({ x: '', instagram: '', facebook: '' });
  let capture = $state<Record<Source, boolean>>({ x: true, instagram: true, facebook: true });
  let skipCrossposts = $state(true);
  let saving = $state<Source>();

  // Matches how settings store a username.
  const normal = (value: string) => value.trim().replace(/^@/, '').toLowerCase();
  const dirty = (source: Source) => normal(typed[source]) !== saved[source];
  const anyDirty = $derived(sources.some(dirty));

  /**
   * Shows the latest status. `replace` loads every field from settings, for a new profile.
   * `sync` updates stored values but keeps usernames the user is still editing.
   */
  export function show(next: SourcesView, mode: 'replace' | 'sync' | 'none') {
    view = next;
    if (mode === 'none') return;
    const conf = next.conf;
    const stored: Record<Source, string> = {
      x: conf.handle,
      instagram: conf.social?.instagram?.handle ?? '',
      facebook: conf.social?.facebook?.handle ?? '',
    };
    for (const source of sources) {
      if (mode === 'replace' || !dirty(source)) typed[source] = stored[source];
      saved[source] = stored[source];
    }
    capture = {
      x: conf.capture,
      instagram: conf.social?.instagram?.capture ?? true,
      facebook: conf.social?.facebook?.capture ?? true,
    };
    skipCrossposts = conf.skipCrossposts !== false;
  }

  /** The settings to store: switches as shown, usernames only as saved. */
  export function values(): SourceSettings {
    return {
      handle: saved.x,
      capture: capture.x,
      skipCrossposts,
      social: {
        instagram: { handle: saved.instagram, capture: capture.instagram },
        facebook: { handle: saved.facebook, capture: capture.facebook },
      },
    };
  }

  export function hasUnsavedChanges() {
    return anyDirty;
  }

  async function saveUsername(source: Source) {
    if (!dirty(source) || saving) return;
    const previous = saved[source];
    saved[source] = normal(typed[source]);
    saving = source;
    try {
      await save();
    } catch {
      // The page already showed the error. Keep the typed username marked as unsaved.
      saved[source] = previous;
    } finally {
      saving = undefined;
    }
  }
  const finish = (source: Source) => (event: KeyboardEvent) => {
    if (event.key === 'Enter') void saveUsername(source);
  };
  const toggle = () => void save().catch(() => {});
  const fieldId = (source: Source) => (source === 'x' ? 'handle' : source + 'Handle');
  const count = (n: number) => n.toLocaleString();
  const locked = $derived(!view?.unlocked);
  const x = $derived(view?.x);
</script>

<svelte:window
  onbeforeunload={(event) => {
    if (anyDirty) event.preventDefault();
  }}
/>

{#snippet username(source: Source, label: string, placeholder: string)}
  <label for={fieldId(source)}>{label}</label>
  <div class="usernameRow">
    <input
      id={fieldId(source)}
      bind:value={typed[source]}
      onkeydown={finish(source)}
      {placeholder}
      autocomplete="off"
      spellcheck="false"
    />
    {#if dirty(source)}
      <button type="button" id={fieldId(source) + 'Save'} disabled={saving === source} onclick={() => saveUsername(source)}
        >Save</button
      >
    {/if}
  </div>
  {#if dirty(source)}<p class="unsaved" role="status">Unsaved changes</p>{/if}
{/snippet}

<h2>Sources</h2>
<p class="hint">
  When you save a username with backup on, you allow Social Backup to sign public posts from that profile with your
  Nostr key and send them to your relays. Private and unverified posts stay on this device.
</p>
<p id="sourcesReadOnly" class="hint" hidden={!locked}>Read-only mode. Sign in with your secret key to turn on backup.</p>

<section class="source" aria-labelledby="xTitle">
  <h3 id="xTitle">X</h3>
  {@render username('x', 'Username', '@yourname')}
  <label class="check"
    ><input type="checkbox" id="capture" bind:checked={capture.x} onchange={toggle} disabled={locked} /> Back up my X posts
    as I browse</label
  >
  <label class="check"
    ><input type="checkbox" id="skipCrossposts" bind:checked={skipCrossposts} onchange={toggle} disabled={locked} /> Skip
    posts already on Nostr</label
  >
  <div class="stats" aria-label="X backup statistics">
    <div><strong id="xCaptured">{count(x?.captured ?? 0)}</strong>Posts found</div>
    <div><strong id="xSigned">{count(x?.signed ?? 0)}</strong>New copies</div>
    <div><strong id="xMatched">{count(x?.matched ?? 0)}</strong>Already on Nostr</div>
    <div><strong id="xDrafts">{count(x?.drafts ?? 0)}</strong>Preparing</div>
  </div>
  <p id="localXCount" class="hint" hidden={!view?.localX}>{count(view?.localX ?? 0)} local only</p>
  <p id="xImageState" class="hint" hidden={!x?.media}>
    {#if x?.media}
      {count(x.media)} {x.media === 1 ? 'post' : 'posts'} waiting for images{x.mediaError ? ' · ' + x.mediaError : ''}
    {/if}
  </p>
</section>

{#each networks as network (network.id)}
  {@const counts = view?.social?.[network.id]}
  <section class="source" aria-labelledby={network.id + 'Title'}>
    <h3 id={network.id + 'Title'}>{network.label}</h3>
    {@render username(network.id, network.field, network.placeholder)}
    <label class="check"
      ><input
        type="checkbox"
        id={network.id + 'Capture'}
        bind:checked={capture[network.id]}
        onchange={toggle}
        disabled={locked}
      /> Back up my {network.label} posts as I browse</label
    >
    <p id={network.id + 'Count'} class="sourceCount">
      {counts?.saved
        ? count(counts.saved) + ' backed up · ' + count(counts.signed) + ' prepared for sharing'
        : 'No posts backed up yet'}
    </p>
  </section>
{/each}
