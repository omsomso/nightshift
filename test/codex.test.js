import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RpcClient } from '../src/codex/rpc-client.js';
import { CodexAdapter, CodexReviewer } from '../src/adapters/codex.js';
import { Supervisor } from '../src/supervisor.js';
import { Store } from '../src/store.js';

const fixtureFile = fileURLToPath(new URL('../fixtures/codex-server.js', import.meta.url));
const sampleTask = { id: 'inspect', title: 'Inspect project', acceptance: 'Cite files.' };
function options(mode = 'normal', overrides = {}) {
  return { cwd: process.cwd(), timeoutMs: 3000,
    createClient: () => new RpcClient({ command: process.execPath, args: [fixtureFile, mode], requestTimeoutMs: 2000, maxLineBytes: 4096 }),
    ...overrides };
}

for (const mode of ['normal', 'early']) {
  test(`adapter handles ${mode} events, UTF-8 chunks, and unrelated turns`, async () => {
    const events = [];
    const result = await new CodexAdapter(options(mode)).execute(sampleTask, { onEvent: event => events.push(event) });
    assert.equal(result.summary, 'Fixture résumé 🦉');
    assert.equal(events.find(x => x.type === 'output').text, 'Résumé 🦉');
    assert.equal(events.filter(x => x.type === 'turn-completed').length, 1);
    assert.ok(events.findIndex(x => x.type === 'session') < events.findIndex(x => x.type === 'dispatch-intent'));
  });
}

test('adapter resumes the saved provider thread', async () => {
  const events = [];
  await new CodexAdapter(options()).execute({ ...sampleTask, sessions: { worker: { threadId: 'saved-thread' } } },
    { onEvent: event => events.push(event) });
  assert.equal(events.find(x => x.type === 'session').threadId, 'saved-thread');
});

for (const [mode, pattern] of [
  ['approval', /requires human handling/], ['disconnect', /disconnected/],
  ['rpc-error', /initialization failed/], ['malformed', /protocol failure/],
  ['bad-output', /JSON/], ['failed-turn', /Fixture failure/],
  ['active', /still active/], ['oversize', /size limit/]
]) {
  test(`adapter fails explicitly on ${mode}`, async () => {
    const events = [];
    await assert.rejects(() => new CodexAdapter(options(mode)).execute(sampleTask, { onEvent: event => events.push(event) }), pattern);
    if (mode === 'approval') assert.equal(events.find(x => x.type === 'approval-required').requestId, 'approval-1');
  });
}

for (const mode of ['stall', 'start-stall']) {
  test(`whole-turn deadline bounds ${mode}`, async () => {
    await assert.rejects(() => new CodexAdapter(options(mode, { timeoutMs: 150 })).execute(sampleTask), /timed out/);
  });
}

test('RPC request timeout also bounds initialization', async () => {
  const createClient = () => new RpcClient({ command: process.execPath, args: [fixtureFile, 'rpc-timeout'], requestTimeoutMs: 150 });
  await assert.rejects(() => new CodexAdapter(options('normal', { createClient })).execute(sampleTask), /timed out/);
});

test('persistence failure prevents a turn from being dispatched', async () => {
  const events = [];
  await assert.rejects(() => new CodexAdapter(options()).execute(sampleTask, { onEvent: event => {
    events.push(event);
    if (event.type === 'session') throw new Error('Disk unavailable');
  } }), /Disk unavailable/);
  assert.equal(events.some(x => x.type === 'dispatch-intent'), false);
});

test('supervisor persists distinct worker/reviewer sessions and streamed evidence', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'nightshift-codex-'));
  const store = new Store(directory);
  store.acquire();
  t.after(() => { store.release(); rmSync(directory, { recursive: true, force: true }); });
  const supervisor = new Supervisor(store, new CodexAdapter(options()), new CodexReviewer(options()));
  supervisor.add(sampleTask);
  await supervisor.run();
  const saved = store.read();
  assert.equal(saved.tasks[0].status, 'done');
  assert.notEqual(saved.tasks[0].sessions.worker.threadId, saved.tasks[0].sessions.reviewer.threadId);
  assert.ok(saved.tasks[0].sessions.worker.turnId);
  assert.equal(saved.tasks[0].sessions.worker.status, 'completed');
  assert.ok(saved.events.some(x => x.type === 'provider:output'));
});

test('unknown executable produces a useful failure without hanging', async () => {
  const createClient = () => new RpcClient({ command: '/nonexistent/nightshift-codex' });
  await assert.rejects(() => new CodexAdapter(options('normal', { createClient })).execute(sampleTask), /could not start/);
});

function smokeFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'nightshift-smoke-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const command = join(directory, 'codex-fixture');
  writeFileSync(command, `#!/usr/bin/env node\nif (process.argv[2] === '--version') console.log('codex-fixture 1'); else { process.argv[2] = 'normal'; import(${JSON.stringify(pathToFileURL(fixtureFile).href)}); }\n`, { mode: 0o700 });
  return { directory, stateDirectory: join(directory, 'state'),
    script: fileURLToPath(new URL('../src/codex-smoke.js', import.meta.url)),
    env: { ...process.env, NIGHTSHIFT_CODEX_BIN: command, NIGHTSHIFT_CODEX_VERSION: 'codex-fixture 1' } };
}

test('VM smoke command runs end-to-end against a fixture and is idempotent', t => {
  const f = smokeFixture(t);
  const run = () => execFileSync(process.execPath, [f.script, process.cwd(), f.stateDirectory], { env: f.env, encoding: 'utf8', timeout: 10_000 });
  run();
  const first = JSON.parse(readFileSync(join(f.stateDirectory, 'state.json'), 'utf8'));
  assert.equal(first.tasks[0].status, 'done');
  assert.equal(first.project.codexVersion, 'codex-fixture 1');
  run();
  const second = JSON.parse(readFileSync(join(f.stateDirectory, 'state.json'), 'utf8'));
  assert.equal(second.tasks[0].attempts, 1);
  assert.equal(second.events.length, first.events.length);
});

test('VM smoke command refuses an unpinned runtime before creating state', t => {
  const f = smokeFixture(t);
  const result = spawnSync(process.execPath, [f.script, process.cwd(), f.stateDirectory], {
    env: { ...f.env, NIGHTSHIFT_CODEX_VERSION: 'different version' }, encoding: 'utf8', timeout: 10_000
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /version mismatch/);
  assert.equal(existsSync(f.stateDirectory), false);
});
