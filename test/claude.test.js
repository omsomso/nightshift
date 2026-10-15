import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ClaudeAdapter, ClaudeReviewer } from '../src/adapters/claude.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { RpcClient } from '../src/codex/rpc-client.js';
import { Supervisor, BillingGuardError, InterruptedError } from '../src/supervisor.js';
import { Store } from '../src/store.js';

const fixtureFile = fileURLToPath(new URL('../fixtures/claude-cli.js', import.meta.url));
const codexFixture = fileURLToPath(new URL('../fixtures/codex-server.js', import.meta.url));
const smokeScript = fileURLToPath(new URL('../src/smoke.js', import.meta.url));
const sampleTask = { id: 'inspect', title: 'Inspect project', acceptance: 'Cite files.' };
const options = (mode = 'normal', overrides = {}) => ({ cwd: process.cwd(), timeoutMs: 3000,
  command: process.execPath, baseArgs: [fixtureFile, mode], maxLineBytes: 4096, ...overrides });

function supervisorFixture(t, adapter, reviewer) {
  const directory = mkdtempSync(join(tmpdir(), 'nightshift-claude-'));
  const store = new Store(directory);
  store.acquire();
  t.after(() => { store.release(); rmSync(directory, { recursive: true, force: true }); });
  return { store, supervisor: new Supervisor(store, adapter, reviewer) };
}

for (const mode of ['normal', 'text-result']) {
  test(`claude adapter handles ${mode} output, UTF-8 chunks, and unrelated sessions`, async () => {
    const events = [];
    const result = await new ClaudeAdapter(options(mode)).execute(sampleTask, { onEvent: event => events.push(event) });
    assert.equal(result.summary, 'Fixture résumé 🦉');
    assert.equal(events.find(x => x.type === 'output').text, 'Résumé 🦉');
    assert.equal(events.find(x => x.type === 'tool-activity').tool, 'Read');
    assert.equal(events.find(x => x.type === 'usage').costUsd, 0.0123);
    assert.deepEqual(events.find(x => x.type === 'usage').tokens, { input: 10, cachedInput: 0, output: 5 });
    assert.equal(events.find(x => x.type === 'turn-started').authSource, 'none');
    assert.equal(events.filter(x => x.type === 'turn-completed').length, 1);
    assert.ok(events.every(x => x.provider === 'claude'));
    const order = ['session', 'dispatch-intent', 'turn-started'].map(type => events.findIndex(x => x.type === type));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
  });
}

test('claude adapter resumes the saved session instead of starting a new one', async () => {
  const events = [];
  const saved = '7f1f0a52-3c47-4f5e-9d8c-3c1e2a9b6d10';
  await new ClaudeAdapter(options()).execute({ ...sampleTask, sessions: { worker: { provider: 'claude', threadId: saved } } },
    { onEvent: event => events.push(event) });
  assert.equal(events.find(x => x.type === 'session').threadId, saved);
  assert.equal(events.find(x => x.type === 'turn-started').threadId, saved);
});

for (const [mode, pattern] of [
  ['denial', /requires human handling: denied Bash/], ['error-result', /error_max_turns/],
  ['disconnect', /disconnected/], ['malformed', /Claude stream failure/], ['oversize', /size limit/],
  ['bad-output', /not JSON/], ['wrong-session', /different session/], ['not-logged-in', /Claude turn error: Not logged in/]
]) {
  test(`claude adapter fails explicitly on ${mode}`, async () => {
    const events = [];
    await assert.rejects(() => new ClaudeAdapter(options(mode)).execute(sampleTask, { onEvent: event => events.push(event) }), pattern);
    if (mode === 'denial') assert.equal(events.find(x => x.type === 'approval-required').tool, 'Bash');
  });
}

test('claude processes never see API-key or provider-switch variables', async t => {
  const names = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : process.env[name] = value; });
  for (const name of names) process.env[name] = 'should-not-leak';
  const result = await new ClaudeAdapter(options()).execute(sampleTask);
  assert.equal(result.summary, 'Fixture résumé 🦉');
});

test('a turn that reports API-key billing is stopped before it starts', async () => {
  const events = [];
  const started = Date.now();
  await assert.rejects(() => new ClaudeAdapter(options('api-key')).execute(sampleTask, { onEvent: event => events.push(event) }),
    error => error instanceof BillingGuardError && /API-key billing \(ANTHROPIC_API_KEY\)/.test(error.message));
  assert.ok(Date.now() - started < 2500, 'the process was killed rather than awaited');
  assert.equal(events.some(x => x.type === 'turn-started'), false);
});

test('API-key billing blocks the task and pauses the whole queue', async t => {
  const { store, supervisor } = supervisorFixture(t, new ClaudeAdapter(options('api-key')), new ClaudeReviewer(options()));
  supervisor.add(sampleTask);
  supervisor.add({ ...sampleTask, id: 'second' });
  await supervisor.run();
  const saved = store.read();
  assert.deepEqual(saved.tasks.map(x => x.status), ['blocked', 'ready']);
  assert.equal(saved.paused, true);
  assert.ok(saved.events.some(x => x.type === 'billing-guard'));
});

test('claude interrupt kills the running process promptly', async () => {
  const abort = new AbortController();
  const started = Date.now();
  const run = new ClaudeAdapter(options('stall', { timeoutMs: 10_000 })).execute(sampleTask, { signal: abort.signal,
    onEvent: event => { if (event.type === 'turn-started') abort.abort(new InterruptedError('Stopped by test.')); } });
  await assert.rejects(run, error => error instanceof InterruptedError);
  assert.ok(Date.now() - started < 3000);
});

test('claude whole-turn deadline bounds a stalled process', async () => {
  await assert.rejects(() => new ClaudeAdapter(options('stall', { timeoutMs: 150 })).execute(sampleTask), /timed out/);
});

test('claude persistence failure prevents the process from starting', async () => {
  const events = [];
  await assert.rejects(() => new ClaudeAdapter(options()).execute(sampleTask, { onEvent: event => {
    events.push(event);
    if (event.type === 'session') throw new Error('Disk unavailable');
  } }), /Disk unavailable/);
  assert.equal(events.some(x => x.type === 'dispatch-intent'), false);
});

test('claude unknown executable produces a useful failure without hanging', async () => {
  await assert.rejects(() => new ClaudeAdapter(options('normal', { command: '/nonexistent/nightshift-claude', baseArgs: [] }))
    .execute(sampleTask), /could not start/);
});

test('a saved session from another provider is never resumed', async () => {
  await assert.rejects(() => new ClaudeAdapter(options()).execute({ ...sampleTask,
    sessions: { worker: { provider: 'codex', threadId: 'codex-thread' } } }), /belongs to codex/);
});

test('supervisor persists distinct Claude worker/reviewer sessions', async t => {
  const { store, supervisor } = supervisorFixture(t, new ClaudeAdapter(options()), new ClaudeReviewer(options()));
  supervisor.add(sampleTask);
  await supervisor.run();
  const saved = store.read().tasks[0];
  assert.equal(saved.status, 'done');
  assert.notEqual(saved.sessions.worker.threadId, saved.sessions.reviewer.threadId);
  assert.equal(saved.sessions.worker.status, 'completed');
  assert.ok(saved.sessions.worker.turnId);
});

test('Codex work can be reviewed by Claude', async t => {
  const codex = { cwd: process.cwd(), timeoutMs: 3000,
    createClient: () => new RpcClient({ command: process.execPath, args: [codexFixture, 'normal'] }) };
  const { store, supervisor } = supervisorFixture(t, new CodexAdapter(codex), new ClaudeReviewer(options()));
  supervisor.add(sampleTask);
  await supervisor.run();
  const saved = store.read().tasks[0];
  assert.equal(saved.status, 'done');
  assert.equal(saved.sessions.worker.provider, 'codex');
  assert.equal(saved.sessions.reviewer.provider, 'claude');
});

function smokeFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'nightshift-smoke-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const claude = join(directory, 'claude-fixture');
  writeFileSync(claude, `#!/usr/bin/env node\nif (process.argv[2] === '--version') console.log('claude-fixture 1'); else if (process.argv[2] === 'auth') { const method = process.env.FIXTURE_AUTH_METHOD ?? 'claude.ai'; console.log(JSON.stringify({ loggedIn: method !== 'signed-out', authMethod: method === 'signed-out' ? 'none' : method, subscriptionType: 'plan', email: 'private@example.com' })); process.exitCode = method === 'signed-out' ? 1 : 0; } else { process.argv.splice(2, 0, process.env.FIXTURE_CLAUDE_MODE ?? 'normal'); import(${JSON.stringify(pathToFileURL(fixtureFile).href)}); }\n`, { mode: 0o700 });
  const codex = join(directory, 'codex-fixture');
  writeFileSync(codex, `#!/usr/bin/env node\nif (process.argv[2] === '--version') console.log('codex-fixture 1'); else if (process.argv[2] === 'login') { const auth = process.env.FIXTURE_CODEX_AUTH ?? 'chatgpt'; console.error(auth === 'chatgpt' ? 'Logged in using ChatGPT' : auth === 'api-key' ? 'Logged in using an API key - sk-proj-SECRET***' : 'Not logged in'); process.exitCode = auth === 'signed-out' ? 1 : 0; } else { process.argv[2] = 'normal'; import(${JSON.stringify(pathToFileURL(codexFixture).href)}); }\n`, { mode: 0o700 });
  return { stateDirectory: join(directory, 'state'),
    env: { ...process.env, NIGHTSHIFT_CLAUDE_BIN: claude, NIGHTSHIFT_CLAUDE_VERSION: 'claude-fixture 1',
      NIGHTSHIFT_CODEX_BIN: codex, NIGHTSHIFT_CODEX_VERSION: 'codex-fixture 1' } };
}

for (const pairing of ['claude', 'codex:claude', 'claude:codex']) {
  test(`smoke command runs ${pairing} end-to-end against fixtures and is idempotent`, t => {
    const f = smokeFixture(t);
    const run = () => execFileSync(process.execPath, [smokeScript, pairing, process.cwd(), f.stateDirectory], { env: f.env, encoding: 'utf8', timeout: 10_000 });
    run();
    const first = Store.inspect(f.stateDirectory);
    assert.equal(first.tasks[0].status, 'done');
    assert.equal(first.project.claudeVersion, 'claude-fixture 1');
    assert.equal(first.project.claudeAuth, 'claude.ai plan');
    assert.doesNotMatch(JSON.stringify(first), /private@example\.com/);
    assert.equal(first.project.pairing, pairing.includes(':') ? pairing : `${pairing}:${pairing}`);
    run();
    const second = Store.inspect(f.stateDirectory);
    assert.equal(second.tasks[0].attempts, 1);
    assert.equal(second.events.length, first.events.length);
  });
}

const repairScript = fileURLToPath(new URL('../src/repair-check.js', import.meta.url));
for (const pairing of ['claude', 'codex', 'codex:claude']) {
  test(`repair check forces one review failure and resumes both ${pairing} sessions`, t => {
    const f = smokeFixture(t);
    const output = execFileSync(process.execPath, [repairScript, pairing, process.cwd(), f.stateDirectory], { env: f.env, encoding: 'utf8', timeout: 20_000 });
    const report = JSON.parse(output.slice(output.indexOf('{')));
    assert.deepEqual(report.checks, { forcedFailureApplied: true, secondAttemptRan: true, workerResumed: true, reviewerResumed: true, passed: true });
    assert.ok(Store.inspect(f.stateDirectory).events.some(e => e.type === 'review-failed' && /FORCED FAILURE/.test(e.detail)));
  });
}

const cliScript = fileURLToPath(new URL('../src/cli.js', import.meta.url));
test('serve interrupts a running Claude turn on command from another process', async t => {
  const f = smokeFixture(t);
  const env = { ...f.env, FIXTURE_CLAUDE_MODE: 'stall' };
  const cli = (...args) => execFileSync(process.execPath, [cliScript, ...args, '--state', f.stateDirectory], { env, encoding: 'utf8', timeout: 10_000 });
  const serve = spawn(process.execPath, [cliScript, 'serve', '--agents', 'claude', '--repo', process.cwd(),
    '--state', f.stateDirectory, '--poll-seconds', '0.05'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  serve.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(done => serve.once('exit', done));
  t.after(() => serve.kill('SIGKILL'));
  cli('add', '--id', 'slow', '--title', 'Slow task', '--acceptance', 'Never finishes.');
  const status = () => { try { return Store.inspect(f.stateDirectory).tasks[0]?.sessions?.worker?.status; } catch { return undefined; } };
  for (const deadline = Date.now() + 8000; status() !== 'running'; await new Promise(r => setTimeout(r, 50))) {
    if (Date.now() > deadline) throw new Error(`Turn never started: ${stderr}`);
  }
  const requested = Date.now();
  cli('interrupt');
  const blocked = () => Store.inspect(f.stateDirectory).tasks[0].status === 'blocked';
  for (const deadline = Date.now() + 8000; !blocked(); await new Promise(r => setTimeout(r, 50))) {
    if (Date.now() > deadline) throw new Error(`Interrupt not applied: ${stderr}`);
  }
  assert.ok(Date.now() - requested < 4000, 'interrupt applied within a few seconds');
  const state = Store.inspect(f.stateDirectory);
  assert.equal(state.paused, true);
  assert.match(state.tasks[0].reason, /Interrupted by the owner/);
  assert.equal(state.tasks[0].sessions.worker.status, 'interrupted');
  serve.kill('SIGTERM');
  assert.equal(await exited, 0, stderr);
});

test('smoke command refuses to reuse state with a different provider pairing', t => {
  const f = smokeFixture(t);
  execFileSync(process.execPath, [smokeScript, 'claude', process.cwd(), f.stateDirectory], { env: f.env, encoding: 'utf8', timeout: 10_000 });
  const result = spawnSync(process.execPath, [smokeScript, 'codex:claude', process.cwd(), f.stateDirectory], { env: f.env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /created for claude:claude/);
});

for (const [method, pattern] of [['console', /refuses pay-per-token/], ['signed-out', /not signed in/]]) {
  test(`smoke command refuses a ${method} Claude sign-in before creating state`, t => {
    const f = smokeFixture(t);
    const result = spawnSync(process.execPath, [smokeScript, 'codex:claude', process.cwd(), f.stateDirectory], {
      env: { ...f.env, FIXTURE_AUTH_METHOD: method }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, pattern);
    assert.equal(existsSync(f.stateDirectory), false);
  });
}

test('smoke command refuses an unpinned Claude runtime before creating state', t => {
  const f = smokeFixture(t);
  const result = spawnSync(process.execPath, [smokeScript, 'claude', process.cwd(), f.stateDirectory], {
    env: { ...f.env, NIGHTSHIFT_CLAUDE_VERSION: 'different version' }, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /claude version mismatch/);
  assert.equal(existsSync(f.stateDirectory), false);
});

test('a denied git commit is recorded but does not block, unlike other denials', async () => {
  const events = [];
  const result = await new ClaudeAdapter(options('git-denial')).execute(sampleTask, { onEvent: event => events.push(event) });
  assert.equal(result.summary, 'Fixture résumé 🦉');
  const denied = events.find(x => x.type === 'policy-denied');
  assert.match(denied.command, /^git commit/);
  assert.equal(events.some(x => x.type === 'approval-required'), false);
});
