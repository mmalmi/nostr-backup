import type { KindStats } from './storage-stats.ts';
import type { Settings } from './types.ts';
import { openArchive } from './archive.ts';
import { storageStats } from './storage-stats.ts';
import { el, on } from './ui.ts';

let version = 0,
  current: string | undefined;
const size = (n: number) =>
  n < 1024
    ? n + ' B'
    : n < 1048576
      ? (n / 1024).toFixed(1) + ' KiB'
      : (n / 1048576).toFixed(1) + ' MiB';
const labels = new Map([
  [0, 'Profile'],
  [1, 'Note'],
  [6, 'Repost'],
  [16, 'Generic repost'],
  [20, 'Picture'],
  [21, 'Video'],
  [22, 'Short video'],
  [1063, 'File metadata'],
  [1111, 'Comment'],
  [30023, 'Article'],
]);
function tag<K extends keyof HTMLElementTagNameMap>(name: K, text: string | number) {
  const node = document.createElement(name);
  node.textContent = String(text);
  return node;
}

function kindSection(row: KindStats) {
  const section = document.createElement('details');
  section.append(
    tag(
      'summary',
      `Kind ${row.kind} · ${labels.get(row.kind) ?? 'Events'} · ${row.events.length} · ${size(row.bytes)}`,
    ),
  );
  section.addEventListener('toggle', () => {
    if (!section.open || section.querySelector('table')) return;
    const table = document.createElement('table');
    const header = table.createTHead().insertRow();
    header.append(...['Event ID', 'Created', 'Bytes'].map((text) => tag('th', text)));
    const body = table.createTBody(),
      more = tag('button', 'Show more');
    more.className = 'quiet';
    let offset = 0;
    function next() {
      for (const event of row.events.slice(offset, offset + 25)) {
        body
          .insertRow()
          .append(
            tag('td', event.id),
            tag('td', new Date(event.createdAt * 1000).toLocaleString()),
            tag('td', event.bytes.toLocaleString()),
          );
      }
      offset += 25;
      more.hidden = offset >= row.events.length;
    }
    more.onclick = next;
    section.append(table, more);
    next();
  });
  return section;
}

export function showStorage(conf: Pick<Settings, 'archiveName'>, visible: boolean, force = false) {
  const name = visible ? conf.archiveName : undefined;
  if (name === current && !force) return;
  current = name;
  const request = ++version;
  el('storageDetails').hidden = true;
  el('kindList').replaceChildren();
  el('storageTotals').replaceChildren();
  el('refreshStats').hidden = !name;
  el('storageState').textContent = name ? 'Reading the local index…' : '';
  if (!name) return;
  (async () => {
    const db = await openArchive(name);
    try {
      const stats = await storageStats(db);
      if (request !== version) return;
      const totals: [string, string | number][] = [
        ['Currently indexed events', stats.kinds.reduce((n, kind) => n + kind.events.length, 0)],
        ['Indexed event payloads', size(stats.kinds.reduce((n, kind) => n + kind.bytes, 0))],
        ['Archived event versions', stats.retained],
        ['Event index blocks', stats.blocks],
        ['Index block storage', size(stats.blockBytes)],
        ['Unique media files', stats.mediaFiles],
        ['Original media bytes', size(stats.mediaBytes)],
        ['Media block storage', size(stats.mediaBlockBytes)],
        ['Unsigned public captures', stats.drafts],
        ['Pending event deliveries', stats.pending],
      ];
      for (const [label, value] of totals)
        el('storageTotals').append(tag('dt', label), tag('dd', value));
      el('kindList').replaceChildren(...stats.kinds.map(kindSection));
      el('storageDetails').hidden = false;
      el('storageState').textContent = stats.kinds.length
        ? ''
        : 'This archive has no indexed events yet.';
    } finally {
      db.close();
    }
  })().catch((e) => {
    if (request === version) el('storageState').textContent = e.message;
  });
}
on('refreshStats', 'click', () => {
  if (current) showStorage({ archiveName: current }, true, true);
});
