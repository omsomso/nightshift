import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RpcClient } from '../src/codex/rpc-client.js';
import { CodexAdapter, CodexReviewer } from '../src/adapters/codex.js';
import { Supervisor, BillingGuardError, InterruptedError } from '../src/supervisor.js';
import { createAppServer } from '../src/codex/session.js';
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
    assert.deepEqual(events.filter(x => x.type === 'output').map(x => x.text), ['Résumé 🦉']);
    const usage = events.find(x => x.type === 'usage');
    assert.deepEqual([usage.requests, usage.tokens], [2, { input: 300, cachedInput: 190, output: 30, reasoningOutput: 5 }]);
    assert.equal(usage.threadTotal.totalTokens, 330);
    assert.ok(events.findIndex(x => x.type === 'usage') < events.findIndex(x => x.type === 'turn-completed'));
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
    if (mode === 'approval') {
      const request = events.find(x => x.type === 'approval-required');
      assert.deepEqual([request.requestId, request.command], ['approval-1', 'touch build.log']);
    }
  });
}

for (const mode of ['stall', 'start-stall']) {
  test(`whole-turn deadline bounds ${mode}`, async () => {
    await assert.rejects(() => new CodexAdapter(options(mode, { timeoutMs: 150 })).execute(sampleTask), /timed out/);
  });
}

test('codex interrupt sends turn/interrupt for the running turn, then stops', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'nightshift-interrupt-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const marker = join(directory, 'marker');
  const saved = process.env.FIXTURE_MARKER;
  process.env.FIXTURE_MARKER = marker;
  t.after(() => { saved === undefined ? delete process.env.FIXTURE_MARKER : process.env.FIXTURE_MARKER = saved; });
  const abort = new AbortController();
  let turnId;
  const run = new CodexAdapter(options('stall', { timeoutMs: 10_000 })).execute(sampleTask, { signal: abort.signal,
    onEvent: event => { if (event.type === 'turn-started') { turnId = event.turnId; abort.abort(new InterruptedError('Stopped by test.')); } } });
  await assert.rejects(run, error => error instanceof InterruptedError);
  assert.equal(readFileSync(marker, 'utf8'), `interrupt ${turnId}\n`);
});

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

test('Codex processes never see API-key variables and are told to refuse API-key login', async t => {
  const names = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : process.env[name] = value; });
  for (const name of names) process.env[name] = 'should-not-leak';
  const createClient = () => createAppServer({ command: process.execPath, baseArgs: [fixtureFile, 'guarded'], requestTimeoutMs: 2000 });
  const result = await new CodexAdapter(options('normal', { createClient })).execute(sampleTask);
  assert.equal(result.summary, 'Fixture résumé 🦉');
});

for (const [mode, pattern] of [['api-key-account', /signed in with apiKey/], ['other-provider', /model provider ollama/]]) {
  test(`Codex ${mode} is refused before any turn starts`, async () => {
    const events = [];
    await assert.rejects(() => new CodexAdapter(options(mode)).execute(sampleTask, { onEvent: event => events.push(event) }),
      error => error instanceof BillingGuardError && pattern.test(error.message));
    assert.equal(events.some(x => x.type === 'dispatch-intent'), false);
  });
}

test('the ChatGPT account check records plan type but never email', async () => {
  const events = [];
  await new CodexAdapter(options()).execute(sampleTask, { onEvent: event => events.push(event) });
  const account = events.find(x => x.type === 'account');
  assert.deepEqual([account.accountType, account.planType], ['chatgpt', 'plus']);
  assert.doesNotMatch(JSON.stringify(events), /private@example\.com/);
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
  writeFileSync(command, `#!/usr/bin/env node\nif (process.argv[2] === '--version') console.log('codex-fixture 1'); else if (process.argv[2] === 'login') { const auth = process.env.FIXTURE_CODEX_AUTH ?? 'chatgpt'; console.error(auth === 'chatgpt' ? 'Logged in using ChatGPT' : auth === 'api-key' ? 'Logged in using an API key - sk-proj-SECRET***' : 'Not logged in'); process.exitCode = auth === 'signed-out' ? 1 : 0; } else { process.argv[2] = 'normal'; import(${JSON.stringify(pathToFileURL(fixtureFile).href)}); }\n`, { mode: 0o700 });
  return { directory, stateDirectory: join(directory, 'state'),
    script: fileURLToPath(new URL('../src/smoke.js', import.meta.url)),
    env: { ...process.env, NIGHTSHIFT_CODEX_BIN: command, NIGHTSHIFT_CODEX_VERSION: 'codex-fixture 1' } };
}

test('VM smoke command runs end-to-end against a fixture and is idempotent', t => {
  const f = smokeFixture(t);
  const run = () => execFileSync(process.execPath, [f.script, 'codex', process.cwd(), f.stateDirectory], { env: f.env, encoding: 'utf8', timeout: 10_000 });
  run();
  const first = Store.inspect(f.stateDirectory);
  assert.equal(first.tasks[0].status, 'done');
  assert.equal(first.project.codexVersion, 'codex-fixture 1');
  assert.equal(first.project.codexAuth, 'chatgpt');
  run();
  const second = Store.inspect(f.stateDirectory);
  assert.equal(second.tasks[0].attempts, 1);
  assert.equal(second.events.length, first.events.length);
});

for (const [auth, pattern] of [['api-key', /refuses API-key billing/], ['signed-out', /not signed in/]]) {
  test(`smoke command refuses a ${auth} Codex sign-in without echoing it`, t => {
    const f = smokeFixture(t);
    const result = spawnSync(process.execPath, [f.script, 'codex', process.cwd(), f.stateDirectory], {
      env: { ...f.env, FIXTURE_CODEX_AUTH: auth }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, pattern);
    assert.doesNotMatch(result.stderr + result.stdout, /SECRET/);
    assert.equal(existsSync(f.stateDirectory), false);
  });
}

test('VM smoke command refuses an unpinned runtime before creating state', t => {
  const f = smokeFixture(t);
  const result = spawnSync(process.execPath, [f.script, 'codex', process.cwd(), f.stateDirectory], {
    env: { ...f.env, NIGHTSHIFT_CODEX_VERSION: 'different version' }, encoding: 'utf8', timeout: 10_000
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /codex version mismatch/);
  assert.equal(existsSync(f.stateDirectory), false);
});
