<script module lang="ts">
  export type Flow = 'signup' | 'signin';
  export type Slide = 'accounts' | 'profile' | 'signin' | 'nostr' | 'done' | 'key';
  /** The slides of each flow. Linking X needs an X account; "You're set" needs an account to open. */
  export function slides(flow: Flow, chosen: { x: boolean; any: boolean }): Slide[] {
    const after: Slide[] = [...(chosen.x ? ['nostr' as const] : []), ...(chosen.any ? ['done' as const] : [])];
    return flow === 'signup' ? ['accounts', 'profile', ...after, 'key'] : ['signin', 'accounts', ...after];
  }
</script>

<script lang="ts">
  let { flow, current, chosen }: { flow: Flow; current: Slide; chosen: { x: boolean; any: boolean } } = $props();
  const list = $derived(slides(flow, chosen));
  const index = $derived(list.indexOf(current));
</script>

{#if index >= 0}
  <ol class="wizardSteps" aria-label={'Step ' + (index + 1) + ' of ' + list.length}>
    {#each list as slide, i (slide)}
      <li class:current={i === index} class:past={i < index}></li>
    {/each}
  </ol>
{/if}
