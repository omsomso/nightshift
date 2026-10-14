import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ClaudeAdapter, ClaudeReviewer } from '../src/adapters/claude.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { RpcClient } from '../src/codex/rpc-client.js';
import { Supervisor } from '../src/supervisor.js';
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
  writeFileSync(claude, `#!/usr/bin/env node\nif (process.argv[2] === '--version') console.log('claude-fixture 1'); else { process.argv.splice(2, 0, 'normal'); import(${JSON.stringify(pathToFileURL(fixtureFile).href)}); }\n`, { mode: 0o700 });
  const codex = join(directory, 'codex-fixture');
  writeFileSync(codex, `#!/usr/bin/env node\nif (process.argv[2] === '--version') console.log('codex-fixture 1'); else { process.argv[2] = 'normal'; import(${JSON.stringify(pathToFileURL(codexFixture).href)}); }\n`, { mode: 0o700 });
  return { stateDirectory: join(directory, 'state'),
    env: { ...process.env, NIGHTSHIFT_CLAUDE_BIN: claude, NIGHTSHIFT_CLAUDE_VERSION: 'claude-fixture 1',
      NIGHTSHIFT_CODEX_BIN: codex, NIGHTSHIFT_CODEX_VERSION: 'codex-fixture 1' } };
}

for (const pairing of ['claude', 'codex:claude', 'claude:codex']) {
  test(`smoke command runs ${pairing} end-to-end against fixtures and is idempotent`, t => {
    const f = smokeFixture(t);
    const run = () => execFileSync(process.execPath, [smokeScript, pairing, process.cwd(), f.stateDirectory], { env: f.env, encoding: 'utf8', timeout: 10_000 });
    run();
    const first = JSON.parse(readFileSync(join(f.stateDirectory, 'state.json'), 'utf8'));
    assert.equal(first.tasks[0].status, 'done');
    assert.equal(first.project.claudeVersion, 'claude-fixture 1');
    assert.equal(first.project.pairing, pairing.includes(':') ? pairing : `${pairing}:${pairing}`);
    run();
    const second = JSON.parse(readFileSync(join(f.stateDirectory, 'state.json'), 'utf8'));
    assert.equal(second.tasks[0].attempts, 1);
    assert.equal(second.events.length, first.events.length);
  });
}

test('smoke command refuses to reuse state with a different provider pairing', t => {
  const f = smokeFixture(t);
  execFileSync(process.execPath, [smokeScript, 'claude', process.cwd(), f.stateDirectory], { env: f.env, encoding: 'utf8', timeout: 10_000 });
  const result = spawnSync(process.execPath, [smokeScript, 'codex:claude', process.cwd(), f.stateDirectory], { env: f.env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /created for claude:claude/);
});

test('smoke command refuses an unpinned Claude runtime before creating state', t => {
  const f = smokeFixture(t);
  const result = spawnSync(process.execPath, [smokeScript, 'claude', process.cwd(), f.stateDirectory], {
    env: { ...f.env, NIGHTSHIFT_CLAUDE_VERSION: 'different version' }, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /claude version mismatch/);
  assert.equal(existsSync(f.stateDirectory), false);
});
