import test from 'node:test';
import assert from 'node:assert/strict';
import { writeQueue } from '../src/write-queue.ts';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const later = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
};

test('settings saved during a sync wait only for the write in progress', async () => {
  const queue = writeQueue();
  const order: string[] = [];
  const first = later();
  const importing = queue.write(async () => {
    order.push('import 1');
    await first.promise;
  });
  await tick();
  const queued = [2, 3].map((n) => queue.write(() => void order.push('import ' + n)));
  const settings = queue.write(() => {
    order.push('settings');
    return 'saved';
  }, true);
  await tick();
  assert.deepEqual(order, ['import 1']);
  first.release();
  assert.equal(await settings, 'saved');
  await Promise.all([importing, ...queued, queue.idle()]);
  assert.deepEqual(order, ['import 1', 'settings', 'import 2', 'import 3']);
});

test('writes stay one at a time and in order, and a failure does not stop the queue', async () => {
  const queue = writeQueue();
  let active = 0,
    most = 0;
  const order: number[] = [];
  const step = (n: number) => async () => {
    most = Math.max(most, ++active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    order.push(n);
    active--;
    if (n === 2) throw Error('failed');
  };
  const writes = [queue.write(step(1))];
  await tick();
  writes.push(...[2, 3].map((n) => queue.write(step(n))));
  const urgent = [4, 5].map((n) => queue.write(step(n), true));
  await assert.rejects(writes[1], /failed/);
  await Promise.all([writes[0], writes[2], ...urgent]);
  await queue.idle();
  assert.equal(most, 1);
  // The first write had started; the urgent ones keep their own order ahead of the rest.
  assert.deepEqual(order, [1, 4, 5, 2, 3]);
});

test('a write starts on a later tick, and idle settles once the queue is empty', async () => {
  const queue = writeQueue();
  let ran = false;
  const done = queue.write(() => (ran = true));
  assert.equal(ran, false);
  await queue.idle();
  assert.equal(ran, true);
  assert.equal(await done, true);
  await queue.idle();
});
