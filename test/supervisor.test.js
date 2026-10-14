import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Supervisor, BlockedError } from '../src/supervisor.js';
import { simulatedAdapter, simulatedReviewer } from '../src/adapters/simulated.js';

function fixture(t, adapter = simulatedAdapter, reviewer = simulatedReviewer) {
  const directory = mkdtempSync(join(tmpdir(), 'nightshift-test-'));
  const store = new Store(directory);
  store.acquire();
  t.after(() => { store.release(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, supervisor: new Supervisor(store, adapter, reviewer) };
}
const task = id => ({ id, title: id, acceptance: 'Defined evidence must pass.' });

test('verified dependencies advance and completed tasks are not replayed after reopening', async t => {
  const { store, supervisor } = fixture(t);
  supervisor.add(task('a'));
  supervisor.add({ ...task('b'), dependencies: ['a'] });
  await supervisor.run();
  assert.deepEqual(supervisor.snapshot().tasks.map(x => x.status), ['done', 'done']);
  const reopened = new Supervisor(store, simulatedAdapter, simulatedReviewer);
  assert.equal((await reopened.run()).dispatched, 0);
});

test('review failures exhaust the persisted attempt budget', async t => {
  const reviewer = { review: async () => ({ passed: false, reason: 'Required behavior is missing.' }) };
  const { store, supervisor } = fixture(t, simulatedAdapter, reviewer);
  supervisor.add({ ...task('a'), maxAttempts: 2 });
  await supervisor.tick();
  assert.equal(supervisor.snapshot().tasks[0].status, 'ready');
  const reopened = new Supervisor(store, simulatedAdapter, reviewer);
  await reopened.run();
  assert.equal(reopened.snapshot().tasks[0].attempts, 2);
  assert.equal(reopened.snapshot().tasks[0].status, 'blocked');
});

test('a blocked task leaves independent work runnable and dependent work waiting', async t => {
  const adapter = { execute: async task => {
    if (task.id === 'a') throw new BlockedError('Needs user permission.');
    return simulatedAdapter.execute(task);
  } };
  const { supervisor } = fixture(t, adapter);
  supervisor.add(task('a'));
  supervisor.add({ ...task('b'), dependencies: ['a'] });
  supervisor.add(task('c'));
  await supervisor.run();
  assert.deepEqual(supervisor.snapshot().tasks.map(x => x.status), ['blocked', 'ready', 'done']);
});

test('an interrupted task is blocked on recovery rather than automatically dispatched', t => {
  const { store, supervisor } = fixture(t);
  supervisor.add(task('a'));
  const state = supervisor.snapshot();
  state.tasks[0].status = 'running';
  store.save(state);
  const reopened = new Supervisor(store, simulatedAdapter, simulatedReviewer);
  assert.equal(reopened.snapshot().tasks[0].status, 'blocked');
  assert.match(reopened.snapshot().tasks[0].reason, /reconcile/);
});

test('pause prevents dispatch and concurrent ticks cannot duplicate a task', async t => {
  let finish;
  let calls = 0;
  const adapter = { execute: task => {
    calls++;
    return new Promise(resolve => { finish = async () => resolve(await simulatedAdapter.execute(task)); });
  } };
  const { supervisor } = fixture(t, adapter);
  supervisor.add(task('a'));
  supervisor.pause();
  assert.equal(await supervisor.tick(), false);
  supervisor.pause(false);
  const running = supervisor.tick();
  assert.equal(await supervisor.tick(), false);
  await finish();
  await running;
  assert.equal(calls, 1);
});

test('worker claims without evidence cannot be marked complete', async t => {
  const { supervisor } = fixture(t, { execute: async () => ({ summary: 'Done!', evidence: [] }) });
  supervisor.add(task('a'));
  await supervisor.run();
  assert.equal(supervisor.snapshot().tasks[0].status, 'blocked');
});

test('a second runner cannot acquire the same state', t => {
  const { directory } = fixture(t);
  assert.throws(() => new Store(directory).acquire(), /locked/);
});

test('invalid legacy state is not silently discarded', t => {
  const directory = mkdtempSync(join(tmpdir(), 'nightshift-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'state.json'), '{broken');
  assert.throws(() => new Store(directory).acquire(), SyntaxError);
  assert.equal(existsSync(join(directory, 'state.json')), true);
  // The failed attempt released its lease: the retry fails the same way, not as locked.
  assert.throws(() => new Store(directory).acquire(), SyntaxError);
});

test('dispatch cap bounds work even when more tasks are ready', async t => {
  const { supervisor } = fixture(t);
  supervisor.add(task('a'));
  supervisor.add(task('b'));
  const result = await supervisor.run({ maxDispatches: 1 });
  assert.equal(result.dispatched, 1);
  assert.deepEqual(result.state.tasks.map(x => x.status), ['done', 'ready']);
});
