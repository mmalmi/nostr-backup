<script lang="ts">
  import { readProfileFields } from '@iris/profile-events';

  let { content, review, disabled }: { content: string; review: (content: string) => void; disabled: boolean } = $props();
  const standard = [
    ['name', 'Username'], ['display_name', 'Display name'], ['about', 'Bio'], ['website', 'Website'],
    ['picture', 'Picture URL'], ['banner', 'Banner URL'], ['nip05', 'Nostr address (NIP-05)'], ['lud16', 'Lightning address'],
  ];
  const base = $derived(readProfileFields(content));
  function common(key: string) {
    return standard.some(([field]) => field === key) && (!Object.hasOwn(base, key) || typeof base[key] === 'string');
  }
  type Row = { id: number; name: string; type: 'Text' | 'JSON'; value: string };
  let values = $state<Record<string, string>>({});
  let rows = $state<Row[]>([]);
  let originalKeys = $state<string[]>([]);
  let error = $state('');
  let nextId = 0;
  $effect(() => {
    values = Object.fromEntries(standard.filter(([key]) => common(key)).map(([key]) => [key, String(base[key] ?? '')]));
    const extras = Object.entries(base).filter(([key]) => !common(key));
    originalKeys = extras.map(([key]) => key);
    rows = extras.map(([name, value]) => ({ id: nextId++, name, type: typeof value === 'string' ? 'Text' : 'JSON',
      value: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }));
    error = '';
  });
  export function draftContent(): string {
      const result = new Map(Object.entries(base));
      for (const [key] of standard) {
        if (!common(key) || values[key] === (base[key] ?? '')) continue;
        if (!values[key]) result.delete(key);
        else result.set(key, values[key]);
      }
      for (const key of originalKeys) result.delete(key);
      for (const row of rows) {
        if (!row.name.trim()) throw Error('Give each custom field a name.');
        if (common(row.name) || result.has(row.name)) throw Error('The field “' + row.name + '” already exists.');
        let value: unknown = row.value;
        if (row.type === 'JSON') {
          try { value = JSON.parse(row.value); } catch { throw Error('Enter valid JSON for “' + row.name + '”.'); }
        }
        result.set(row.name, value);
      }
      return JSON.stringify(Object.fromEntries(result));
  }
  function submit() {
    try {
      error = '';
      review(draftContent());
    } catch (e) { error = (e as Error).message; }
  }
</script>
<form onsubmit={(e) => { e.preventDefault(); submit(); }}>
  <fieldset {disabled}>
    <div class="profileFields">
      {#each standard.filter(([key]) => common(key)) as [key, label] (key)}
        <label class:wide={key === 'about'}>{label}
          {#if key === 'about'}<textarea rows="3" bind:value={values[key]}></textarea>
          {:else}<input bind:value={values[key]} />{/if}
        </label>
      {/each}
    </div>
    <details class="fieldDetails">
      <summary>Custom fields ({rows.length})</summary>
      {#each rows as row (row.id)}
        <div class="customField">
          <div class="profileFields">
            <label>Field name<input bind:value={row.name} spellcheck="false" /></label>
            <label>Value type<select aria-label="Value type" bind:value={row.type}><option>Text</option><option>JSON</option></select></label>
          </div>
          <label>Value<textarea bind:value={row.value} rows={row.type === 'Text' ? 1 : 3}></textarea></label>
          <button type="button" class="secondary" onclick={() => rows = rows.filter(r => r.id !== row.id)}>Remove field</button>
        </div>
      {/each}
      <button type="button" class="secondary" onclick={() => rows.push({id: nextId++, name: '', type: 'Text', value: ''})}>Add custom field</button>
    </details>
    {#if error}<p role="alert">{error}</p>{/if}
    <button type="submit">Review changes</button>
  </fieldset>
</form>
