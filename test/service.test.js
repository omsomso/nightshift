import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { Supervisor, BlockedError } from '../src/supervisor.js';
import { simulatedAdapter, simulatedReviewer } from '../src/adapters/simulated.js';
import { renderReport } from '../src/report.js';

const cliFile = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const task = id => ({ id, title: id, acceptance: 'Defined evidence must pass.' });
function tempDir(t) {
  const directory = mkdtempSync(join(tmpdir(), 'nightshift-service-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function held(t, directory) {
  const store = new Store(directory);
  store.acquire();
  t.after(() => store.release());
  return store;
}
const cli = (directory, ...args) => execFileSync(process.execPath, [cliFile, ...args, '--state', directory], { encoding: 'utf8', timeout: 10_000 });
async function waitFor(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition.');
    await new Promise(done => setTimeout(done, 50));
  }
}
function setLease(directory, pid, expiresAt) {
  const db = new DatabaseSync(join(directory, 'nightshift.db'));
  db.prepare('INSERT OR REPLACE INTO lease (id, owner, pid, host, acquired_at, expires_at) VALUES (1, ?, ?, ?, ?, ?)')
    .run('someone-else', pid, hostname(), new Date().toISOString(), expiresAt);
  db.close();
}

test('the event log is append-only, even for direct database writes', t => {
  const directory = tempDir(t);
  const store = held(t, directory);
  const supervisor = new Supervisor(store, simulatedAdapter, simulatedReviewer);
  supervisor.add(task('a'));
  const state = supervisor.snapshot();
  state.events.pop();
  assert.throws(() => store.save(state), /append-only/);
  const db = new DatabaseSync(store.file);
  t.after(() => db.close());
  assert.throws(() => db.exec("UPDATE events SET type = 'forged'"), /append-only/);
  assert.throws(() => db.exec('DELETE FROM events'), /append-only/);
});

test('a JSON snapshot from an earlier version is imported once', t => {
  const directory = tempDir(t);
  writeFileSync(join(directory, 'state.json'), JSON.stringify({ version: 1, paused: false, project: { cwd: '/repo' },
    tasks: [{ id: 'a', title: 'a', acceptance: 'x', dependencies: [], maxAttempts: 2, attempts: 1, status: 'done' }],
    events: [{ taskId: 'a', type: 'verified', detail: 'ok', at: '2026-10-13T00:00:00.000Z' }] }));
  let store = new Store(directory);
  store.acquire();
  assert.equal(store.read().tasks[0].status, 'done');
  assert.equal(store.read().project.cwd, '/repo');
  store.release();
  assert.equal(existsSync(join(directory, 'state.json')), false);
  assert.equal(existsSync(join(directory, 'state.json.imported')), true);
  store = held(t, directory);
  assert.equal(store.read().events.length, 1);
});

test('a lease left by an exited runner is recovered and recorded', t => {
  const directory = tempDir(t);
  Store.enqueue(directory, 'pause'); // Creates the database.
  const exited = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  setLease(directory, Number(exited.stdout), Date.now() + 60_000);
  const store = held(t, directory);
  assert.equal(store.read().events.at(-1).type, 'lease-recovered');
});

test('a lease is never taken from a process that is still running', t => {
  const directory = tempDir(t);
  Store.enqueue(directory, 'pause');
  setLease(directory, process.pid, Date.now() - 1000);
  assert.throws(() => new Store(directory).acquire(), /may still be running/);
  setLease(directory, process.pid, Date.now() + 60_000);
  assert.throws(() => new Store(directory).acquire(), /locked by process/);
});

test('a runner that lost its lease cannot write', t => {
  const directory = tempDir(t);
  const store = held(t, directory);
  const supervisor = new Supervisor(store, simulatedAdapter, simulatedReviewer);
  setLease(directory, process.pid, Date.now() + 60_000);
  assert.throws(() => supervisor.add(task('a')), /lease was lost/);
  assert.throws(() => store.heartbeat(), /lease was lost/);
});

test('queued commands apply at the next task boundary', async t => {
  const directory = tempDir(t);
  const adapter = { execute: async item => {
    if (item.id === 'flaky' && item.attempts === 1) throw new BlockedError('Needs reconciliation.');
    return simulatedAdapter.execute(item);
  } };
  const store = held(t, directory);
  const supervisor = new Supervisor(store, adapter, simulatedReviewer);
  Store.enqueue(directory, 'add-task', task('flaky'));
  Store.enqueue(directory, 'add-task', task('flaky'));
  assert.equal(Store.inspect(directory).pendingCommands, 2);
  await supervisor.run();
  assert.equal(Store.inspect(directory).pendingCommands, 0);
  assert.equal(supervisor.snapshot().tasks[0].status, 'blocked');
  assert.ok(supervisor.snapshot().events.some(event => event.type === 'command-rejected'));
  assert.equal(Store.inspect(directory).tasks[0].status, 'blocked'); // Readable while the lease is held.

  Store.enqueue(directory, 'pause');
  Store.enqueue(directory, 'retry', { id: 'flaky' });
  assert.equal(await supervisor.tick(), false);
  assert.equal(supervisor.snapshot().tasks[0].status, 'ready');
  Store.enqueue(directory, 'resume');
  await supervisor.run();
  assert.equal(supervisor.snapshot().tasks[0].status, 'done');
  assert.equal(supervisor.snapshot().tasks[0].attempts, 2);
});

function startServe(t, directory, ...args) {
  const child = spawn(process.execPath, [cliFile, 'serve', '--agents', 'simulated', '--state', directory, '--poll-seconds', '0.05', ...args],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(done => child.once('exit', code => done({ code, stderr })));
  t.after(() => child.kill('SIGKILL'));
  return { child, exited };
}
const statusOf = (directory, id) => Store.inspect(directory).tasks.find(item => item.id === id)?.status;

test('serve keeps running, applies commands from other processes, and stops cleanly', async t => {
  const directory = tempDir(t);
  const { child, exited } = startServe(t, directory);
  await waitFor(() => existsSync(join(directory, 'nightshift.db')) && Store.inspect(directory).project);
  cli(directory, 'add', '--id', 'a', '--title', 'First', '--acceptance', 'Done.');
  cli(directory, 'add', '--id', 'b', '--title', 'Second', '--acceptance', 'Done.', '--after', 'a');
  await waitFor(() => statusOf(directory, 'b') === 'done');

  cli(directory, 'pause');
  await waitFor(() => Store.inspect(directory).paused);
  cli(directory, 'add', '--id', 'c', '--title', 'Third', '--acceptance', 'Done.');
  await waitFor(() => statusOf(directory, 'c') === 'ready');
  await new Promise(done => setTimeout(done, 200));
  assert.equal(statusOf(directory, 'c'), 'ready');
  cli(directory, 'resume');
  await waitFor(() => statusOf(directory, 'c') === 'done');

  child.kill('SIGTERM');
  const { code, stderr } = await exited;
  assert.equal(code, 0, stderr);
  held(t, directory); // The lease was released.
});

test('serve pauses itself at the dispatch cap, and the pause survives a restart', async t => {
  const directory = tempDir(t);
  cli(directory, 'add', '--id', 'a', '--title', 'a', '--acceptance', 'x');
  cli(directory, 'add', '--id', 'b', '--title', 'b', '--acceptance', 'x');
  let serve = startServe(t, directory, '--max-dispatches', '1');
  await waitFor(() => Store.inspect(directory).paused);
  serve.child.kill('SIGTERM');
  await serve.exited;
  assert.deepEqual(Store.inspect(directory).tasks.map(item => item.status), ['done', 'ready']);
  assert.ok(Store.inspect(directory).events.some(event => event.type === 'dispatch-cap-reached'));

  serve = startServe(t, directory, '--max-dispatches', '1');
  await new Promise(done => setTimeout(done, 300));
  assert.equal(statusOf(directory, 'b'), 'ready');
  serve.child.kill('SIGTERM');
  await serve.exited;
});

test('the report separates simulated, blocked, refused, and billed results', () => {
  const at = '2026-10-14T06:00:00.000Z';
  const state = { version: 1, paused: true, project: { cwd: '/repo', pairing: 'codex:claude' }, events: [
    { taskId: 'a', type: 'dispatched', detail: 'Attempt 1', at },
    { taskId: 'b', type: 'provider:approval-required', detail: { provider: 'claude', tool: 'Bash', reason: 'Denied automatically.' }, at },
    { taskId: 'b', type: 'provider:usage', detail: { provider: 'claude', costUsd: 0.0123 }, at },
    { taskId: 'a', type: 'provider:usage', detail: { provider: 'codex', requests: 3, tokens: { input: 1234567, cachedInput: 1000, output: 42 } }, at },
    { taskId: 'old', type: 'verified', detail: 'ok', at: '2026-10-01T00:00:00.000Z' }
  ], tasks: [
    { id: 'a', title: 'Simulated task', status: 'done', attempts: 1, dependencies: [],
      result: { summary: '[SIMULATED] a' }, review: { passed: true, reason: '[SIMULATED] ok' } },
    { id: 'b', title: 'Blocked task', status: 'blocked', attempts: 1, dependencies: [], reason: 'Provider request requires human handling' },
    { id: 'c', title: 'Waiting task', status: 'ready', attempts: 0, dependencies: ['b'] },
    { id: 'old', title: 'Old task', status: 'done', attempts: 1, dependencies: [], review: { reason: 'ok' } }
  ] };
  const report = renderReport(state, { since: '2026-10-14T00:00:00Z', now: new Date(at) });
  assert.match(report, /SIMULATED, not real verification/);
  assert.match(report, /retry b/);
  assert.match(report, /waiting on b/);
  assert.match(report, /claude: Bash/);
  assert.match(report, /\$0\.0123/);
  assert.match(report, /codex: 1 turn\(s\); 1,234,567 input tokens \(1,000 cached\), 42 output; no cost reported/);
  assert.match(report, /queue is paused/);
  assert.doesNotMatch(report, /Old task/);
  assert.throws(() => renderReport(state, { since: 'yesterday-ish' }), /ISO/);
});
