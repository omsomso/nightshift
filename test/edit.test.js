import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../src/store.js';
import { Supervisor } from '../src/supervisor.js';
import { Workspace } from '../src/workspace.js';
import { loadPlan } from '../src/plan.js';
import { claudeArgs } from '../src/claude/session.js';

const cliFile = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// A small repository whose check fails when any note contains BAD.
function makeRepo(t) {
  const root = mkdtempSync(join(tmpdir(), 'nightshift-edit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'notes'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main', repo);
  writeFileSync(join(repo, 'notes', '.keep'), '');
  writeFileSync(join(repo, 'AGENTS.md'), 'Rules.\n');
  writeFileSync(join(repo, 'check.js'), "const fs = require('fs');\n" +
    "for (const f of fs.readdirSync('notes')) if (fs.readFileSync('notes/' + f, 'utf8').includes('BAD')) { console.error('BAD in ' + f); process.exit(1); }\n" +
    "console.log('notes ok');\n");
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  return { root, repo, state: join(root, 'state') };
}

function writePlan(env, overrides = {}) {
  const plan = { id: 'demo-plan', repo: env.repo, brief: 'Write two notes.', checks: ['node check.js'], allowedPaths: ['notes/'],
    tasks: [{ id: 'one', title: 'Write note one', acceptance: 'notes/one.txt exists.' },
      { id: 'two', title: 'Write note two', acceptance: 'notes/two.txt exists.' }], ...overrides };
  const file = join(env.root, 'plan.json');
  writeFileSync(file, JSON.stringify(plan));
  return file;
}

const cli = (env, ...args) => execFileSync(process.execPath, [cliFile, ...args, '--state', env.state],
  { encoding: 'utf8', timeout: 20_000, env: env.processEnv ?? process.env });

// Starts a plan through the CLI, then runs it in-process with scripted agents.
function startPlan(t, env, worker, reviewer, overrides) {
  cli(env, 'plan', writePlan(env, overrides));
  const store = new Store(env.state);
  store.acquire();
  t.after(() => store.release());
  const workspace = new Workspace(store.read().plan);
  return { store, workspace, supervisor: new Supervisor(store, worker, reviewer, { workspace }) };
}

// `edits` maps "<task>:<attempt>" to { path: content }; the default writes notes/<task>.txt.
function scriptedWorker(edits = {}) {
  const calls = [];
  return { calls, async execute(task, { plan }) {
    calls.push({ task: task.id, attempt: task.attempts, review: task.review?.reason });
    const files = edits[`${task.id}:${task.attempts}`] ?? edits[task.id] ?? { [`notes/${task.id}.txt`]: `${task.id}\n` };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(plan.worktree, path, '..'), { recursive: true });
      writeFileSync(join(plan.worktree, path), content);
    }
    return { summary: `Wrote ${Object.keys(files).join(', ') || 'nothing'}`, evidence: Object.keys(files).length ? Object.keys(files) : ['no files changed'] };
  } };
}
function scriptedReviewer(decide = () => true) {
  const calls = [];
  return { calls, async review(task, result, context) {
    calls.push({ task: task.id, final: context.final, diff: context.change?.reviewDiff ?? context.change?.planChange?.reviewDiff,
      checks: context.change?.checks?.passed });
    const passed = decide(task, context, calls.length);
    return { passed, reason: passed ? 'Looks right.' : 'Missing something concrete.' };
  } };
}

test('a plan runs task by task, Nightshift commits each, and the branch waits for approval', async t => {
  const env = makeRepo(t);
  const mainBefore = git(env.repo, 'rev-parse', 'HEAD');
  const reviewer = scriptedReviewer();
  const { store, supervisor } = startPlan(t, env, scriptedWorker(), reviewer);
  await supervisor.run();
  const state = store.read();
  assert.equal(state.plan.status, 'awaiting-approval');
  assert.deepEqual(state.tasks.map(x => x.status), ['done', 'done']);
  const log = git(env.repo, 'log', '--format=%an|%s|%(trailers:key=Nightshift-Task,valueonly,separator=)', 'nightshift/demo-plan', '-2');
  assert.deepEqual(log.split('\n').filter(Boolean), ['Nightshift|Write note two|two', 'Nightshift|Write note one|one']);
  assert.equal(git(env.repo, 'rev-parse', 'HEAD'), mainBefore, 'the owner checkout is untouched');
  assert.equal(git(env.repo, 'status', '--porcelain'), '');
  assert.ok(reviewer.calls[0].diff.includes('+one') && reviewer.calls[0].checks);
  assert.equal(reviewer.calls.at(-1).final, true);
  assert.match(reviewer.calls.at(-1).diff, /notes\/one\.txt[\s\S]*notes\/two\.txt/);
  const report = cli(env, 'report');
  assert.match(report, /ready for your review and merge/);
  assert.match(report, /git -C .* merge --no-ff nightshift\/demo-plan/);
});

test('failing checks send the task back with the check output, and a fix passes', async t => {
  const env = makeRepo(t);
  const worker = scriptedWorker({ 'one:1': { 'notes/one.txt': 'BAD\n' }, 'one:2': { 'notes/one.txt': 'good\n' } });
  const { store, supervisor } = startPlan(t, env, worker, scriptedReviewer(), { tasks: [{ id: 'one', title: 'Write note one', acceptance: 'x' }] });
  await supervisor.run();
  assert.equal(store.read().tasks[0].status, 'done');
  assert.equal(store.read().tasks[0].attempts, 2);
  assert.match(worker.calls[1].review, /checks failed[\s\S]*BAD in one\.txt/);
});

test('the same failing change twice is stopped as stagnation', async t => {
  const env = makeRepo(t);
  const worker = scriptedWorker({ one: { 'notes/one.txt': 'BAD\n' } });
  const { store, supervisor } = startPlan(t, env, worker, scriptedReviewer(), { tasks: [{ id: 'one', title: 'x', acceptance: 'x' }] });
  await supervisor.run();
  const task = store.read().tasks[0];
  assert.equal(task.status, 'blocked');
  assert.match(task.reason, /Stagnation: the same change failed the same way twice/);
  assert.equal(task.attempts, 2, 'stopped before using the third allowed attempt');
});

for (const [name, files, pattern] of [
  ['a protected path', { 'AGENTS.md': 'New rules.\n' }, /Drift: protected paths changed: AGENTS\.md/],
  ['a path outside the plan', { 'check.js': 'process.exit(0)\n' }, /Drift: changes outside the plan's allowed paths: check\.js/],
  ['no change at all', {}, /Stagnation: the attempt changed no files/]
]) {
  test(`changing ${name} blocks the task before any review`, async t => {
    const env = makeRepo(t);
    const reviewer = scriptedReviewer();
    const { store, supervisor } = startPlan(t, env, scriptedWorker({ one: files }), reviewer, { tasks: [{ id: 'one', title: 'x', acceptance: 'x' }] });
    await supervisor.run();
    assert.match(store.read().tasks[0].reason, pattern);
    assert.equal(reviewer.calls.length, 0);
  });
}

test('an oversized change is sent back to be made smaller', async t => {
  const env = makeRepo(t);
  const worker = scriptedWorker({ 'one:1': { 'notes/one.txt': 'line\n'.repeat(50) }, 'one:2': { 'notes/one.txt': 'short\n' } });
  const { store, supervisor } = startPlan(t, env, worker, scriptedReviewer(),
    { tasks: [{ id: 'one', title: 'x', acceptance: 'x' }], limits: { changedLinesPerTask: 10 } });
  await supervisor.run();
  assert.equal(store.read().tasks[0].status, 'done');
  assert.match(worker.calls[1].review, /50 lines, over this plan's cap of 10/);
});

test('reaching the plan token limit pauses it; the owner can raise the limit and resume', async t => {
  const env = makeRepo(t);
  const worker = scriptedWorker();
  const hungry = { calls: worker.calls, async execute(task, context) {
    context.onEvent({ type: 'usage', provider: 'test', tokens: { input: 600, cachedInput: 0, output: 0 } });
    return worker.execute(task, context);
  } };
  // Limits are checked before each dispatch, so one task can overshoot; 500 stops before task two.
  const { store, supervisor } = startPlan(t, env, hungry, scriptedReviewer(), { limits: { tokens: 500 } });
  await supervisor.run();
  let state = store.read();
  assert.equal(state.paused, true);
  assert.deepEqual(state.tasks.map(x => x.status), ['done', 'ready']);
  assert.match(state.events.find(e => e.type === 'plan-limit').detail, /600 tokens \(limit 500\)/);
  Store.enqueue(env.state, 'limit', { name: 'tokens', value: 5000 });
  Store.enqueue(env.state, 'resume');
  await supervisor.run();
  state = store.read();
  assert.equal(state.plan.status, 'awaiting-approval');
});

test('a failed final review blocks the plan until the owner reopens it', async t => {
  const env = makeRepo(t);
  let finalCalls = 0;
  const reviewer = scriptedReviewer((task, context) => !context.final || ++finalCalls > 1);
  const { store, supervisor } = startPlan(t, env, scriptedWorker(), reviewer);
  await supervisor.run();
  let state = store.read();
  assert.equal(state.plan.status, 'blocked');
  assert.match(state.plan.reason, /Final review failed/);
  assert.equal(state.paused, true);
  Store.enqueue(env.state, 'retry', { id: 'demo-plan' });
  Store.enqueue(env.state, 'resume');
  await supervisor.run();
  state = store.read();
  assert.equal(state.plan.status, 'awaiting-approval');
});

test('plans are validated, and a state directory or branch is never reused', t => {
  const env = makeRepo(t);
  assert.throws(() => loadPlan(writePlan(env, { checks: [] })), /checks must list at least one command/);
  for (const command of ['git push origin main', 'npm test && git commit -am x', 'git  reset --hard', 'git rebase main']) {
    assert.throws(() => loadPlan(writePlan(env, { checks: ['node check.js', command] })),
      error => error.message.includes(`check "${command}" changes Git history`));
  }
  assert.equal(loadPlan(writePlan(env, { checks: ['git status --porcelain', 'git diff --check'] })).checks.length, 2);
  assert.throws(() => loadPlan(writePlan(env, { id: 'Bad Id' })), /id must be lowercase/);
  assert.throws(() => loadPlan(writePlan(env, { limits: { speed: 1 } })), /unknown limits: speed/);
  assert.throws(() => loadPlan(writePlan(env, { allowedPaths: ['../elsewhere'] })), /repository-relative/);
  const file = writePlan(env);
  cli(env, 'plan', file);
  assert.throws(() => cli(env, 'plan', file), /already has work/);
  const other = spawnSync(process.execPath, [cliFile, 'plan', file, '--state', join(env.root, 'state-2')], { encoding: 'utf8' });
  assert.match(other.stderr, /Branch nightshift\/demo-plan already exists/);
  assert.equal(existsSync(join(env.root, 'state-2', 'worktree')), false);
});

test('the Claude edit session is sandboxed with no network and no git history commands', () => {
  const args = claudeArgs({ sessionId: 'x', outputSchema: {}, edit: true });
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob,Edit,Write,Bash');
  assert.ok(args.includes('--restricted'));
  assert.deepEqual([settings.sandbox.enabled, settings.sandbox.allowUnsandboxedCommands, settings.sandbox.failIfUnavailable], [true, false, true]);
  assert.deepEqual(settings.sandbox.network, { allowedDomains: [], strictAllowlist: true });
  for (const command of ['push', 'commit', 'reset']) assert.ok(settings.permissions.deny.includes(`Bash(git ${command}:*)`));
  assert.ok(settings.sandbox.filesystem.denyRead.includes('~/.ssh'));
  assert.equal(claudeArgs({ sessionId: 'x', outputSchema: {} }).includes('--settings'), false, 'read-only sessions stay unchanged');
});

// End to end through `serve` with the stand-in CLIs, which edit one file per task.
function fixtureEnv(t, env) {
  const bin = join(env.root, 'bin');
  mkdirSync(bin);
  const claudeFixture = pathToFileURL(fileURLToPath(new URL('../fixtures/claude-cli.js', import.meta.url))).href;
  const codexFixture = pathToFileURL(fileURLToPath(new URL('../fixtures/codex-server.js', import.meta.url))).href;
  writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node\nif (process.argv[2] === '--version') console.log('claude-fixture 1'); else if (process.argv[2] === 'auth') console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'plan' })); else { process.argv.splice(2, 0, 'normal'); import(${JSON.stringify(claudeFixture)}); }\n`, { mode: 0o700 });
  writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node\nif (process.argv[2] === '--version') console.log('codex-fixture 1'); else if (process.argv[2] === 'login') console.error('Logged in using ChatGPT'); else { process.argv[2] = 'normal'; import(${JSON.stringify(codexFixture)}); }\n`, { mode: 0o700 });
  return { ...process.env, NIGHTSHIFT_CLAUDE_BIN: join(bin, 'claude'), NIGHTSHIFT_CLAUDE_VERSION: 'claude-fixture 1',
    NIGHTSHIFT_CODEX_BIN: join(bin, 'codex'), NIGHTSHIFT_CODEX_VERSION: 'codex-fixture 1' };
}

for (const pairing of ['claude', 'codex:claude']) {
  test(`serve runs a whole ${pairing} plan in its worktree and stops at approval`, async t => {
    const env = makeRepo(t);
    env.processEnv = fixtureEnv(t, env);
    cli(env, 'plan', writePlan(env));
    const serve = spawn(process.execPath, [cliFile, 'serve', '--agents', pairing, '--state', env.state, '--poll-seconds', '0.05'],
      { env: env.processEnv, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    serve.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise(done => serve.once('exit', done));
    t.after(() => serve.kill('SIGKILL'));
    const status = () => { try { return Store.inspect(env.state).plan.status; } catch { return undefined; } };
    for (const deadline = Date.now() + 20_000; status() === 'running'; await new Promise(r => setTimeout(r, 100))) {
      if (Date.now() > deadline) throw new Error(`Plan did not finish: ${stderr}`);
    }
    serve.kill('SIGTERM');
    assert.equal(await exited, 0, stderr);
    const state = Store.inspect(env.state);
    assert.equal(state.plan.status, 'awaiting-approval', state.plan.reason ?? stderr);
    const files = git(env.repo, 'diff', '--name-only', state.plan.baseCommit, 'nightshift/demo-plan');
    assert.deepEqual(files.split('\n'), ['notes/task-1.txt', 'notes/task-2.txt']);
    assert.match(readFileSync(join(state.plan.worktree, 'notes/task-1.txt'), 'utf8'), new RegExp(`by ${pairing.split(':')[0]} fixture`));
    assert.equal(state.tasks.every(task => task.sessions.worker.provider === pairing.split(':')[0]), true);
  });
}

test('Nightshift refuses to commit if the worktree was moved to another branch', async t => {
  const env = makeRepo(t);
  const sneaky = { async execute(task, { plan }) {
    git(plan.worktree, 'checkout', '-q', '-b', 'elsewhere');
    writeFileSync(join(plan.worktree, 'notes', 'one.txt'), 'one\n');
    return { summary: 'Wrote one', evidence: ['notes/one.txt'] };
  } };
  const { store, supervisor } = startPlan(t, env, sneaky, scriptedReviewer(), { tasks: [{ id: 'one', title: 'x', acceptance: 'x' }] });
  await supervisor.run();
  assert.match(store.read().tasks[0].reason, /no longer points at nightshift\/demo-plan/);
  assert.equal(git(env.repo, 'rev-list', '--count', 'nightshift/demo-plan'), '1', 'nothing was committed to the plan branch');
});
