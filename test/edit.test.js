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
  assert.match(report, /nightshift merge demo-plan/);
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

test('a failed final review becomes one fix-up task, and the plan then passes', async t => {
  const env = makeRepo(t);
  let finalCalls = 0;
  const reviewer = scriptedReviewer((task, context) => !context.final || ++finalCalls > 1);
  const worker = scriptedWorker();
  const { store, supervisor } = startPlan(t, env, worker, reviewer);
  await supervisor.run();
  const state = store.read();
  assert.equal(state.plan.status, 'awaiting-approval');
  assert.deepEqual(state.tasks.map(x => [x.id, x.status]), [['one', 'done'], ['two', 'done'], ['final-fixup-1', 'done']]);
  const fixup = state.tasks.at(-1);
  assert.match(fixup.acceptance, /Final review failed: Missing something concrete/);
  assert.ok(fixup.commit, 'the fix-up was committed like any task');
  assert.equal(state.plan.fixups, 1);
  assert.ok(state.events.some(e => e.type === 'final-fixup-added'));
  assert.equal(finalCalls, 2);
});

test('when the fix-up round is used up, a failed final review blocks until the owner reopens it', async t => {
  const env = makeRepo(t);
  let finalCalls = 0;
  const reviewer = scriptedReviewer((task, context) => !context.final || ++finalCalls > 2);
  const { store, supervisor } = startPlan(t, env, scriptedWorker(), reviewer);
  await supervisor.run();
  let state = store.read();
  assert.equal(state.plan.status, 'blocked');
  assert.match(state.plan.reason, /Final review failed/);
  assert.equal(state.paused, true);
  assert.equal(state.tasks.filter(x => x.id.startsWith('final-fixup')).length, 1, 'only one fix-up round by default');
  Store.enqueue(env.state, 'retry', { id: 'demo-plan' });
  Store.enqueue(env.state, 'resume');
  await supervisor.run();
  state = store.read();
  assert.equal(state.plan.status, 'awaiting-approval');
});

test('fixupRounds 0 blocks at the first failed final review', async t => {
  const env = makeRepo(t);
  const reviewer = scriptedReviewer((task, context) => !context.final);
  const { store, supervisor } = startPlan(t, env, scriptedWorker(), reviewer, { limits: { fixupRounds: 0 } });
  await supervisor.run();
  const state = store.read();
  assert.equal(state.plan.status, 'blocked');
  assert.equal(state.tasks.length, 2);
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

test('the planner reads project rules, and reviewers judge only within the allowed paths', async () => {
  const { plannerPrompt, editReviewerPrompt, finalReviewPrompt } = await import('../src/prompts.js');
  const plan = { brief: 'b', allowedPaths: ['src/', 'docs/ROADMAP.md'], checks: ['npm test'], tasks: [{ id: 't', title: 'T', acceptance: 'a' }] };
  const checks = { passed: true, results: [] };
  assert.match(plannerPrompt({ doc: 'docs/PLAN.md' }), /AGENTS\.md, CLAUDE\.md/);
  assert.match(plannerPrompt({ doc: 'docs/PLAN.md' }), /any file the agent instructions require updating/);
  assert.match(editReviewerPrompt(plan.tasks[0], {}, { checks, reviewDiff: '' }, plan), /Only require changes inside the allowed paths \(src\/, docs\/ROADMAP\.md\)/);
  const final = finalReviewPrompt(plan, { stat: '', reviewDiff: '' }, checks);
  assert.match(final, /Allowed paths: src\/, docs\/ROADMAP\.md/);
  assert.match(final, /Do not fail it for work the tasks did not ask for or that lies outside the allowed paths/);
});

test('project rules are collected once, snapshotted per plan, and reach every edit-mode prompt', async t => {
  const env = makeRepo(t);
  const { collectRules, rulesBlock } = await import('../src/rules.js');
  const { editWorkerPrompt, editReviewerPrompt, finalReviewPrompt } = await import('../src/prompts.js');
  writeFileSync(join(env.repo, 'CLAUDE.md'), '<!-- generated -->\nAlways commit and push. Codeword HERON.\n');
  writeFileSync(join(env.repo, 'AGENTS.md'), '<!-- generated differently -->\nAlways commit and push. Codeword HERON.\n');
  writeFileSync(join(env.repo, 'CLAUDE.local.md'), 'Local note: prefer short names.\n');
  git(env.repo, 'add', 'CLAUDE.md', 'AGENTS.md');
  git(env.repo, 'commit', '-q', '-m', 'rules');
  const rules = collectRules(env.repo);
  assert.deepEqual(rules.map(r => [r.path, r.also]), [['AGENTS.md', ['CLAUDE.md']], ['CLAUDE.local.md', []]]);
  const block = rulesBlock(rules);
  assert.match(block, /Nightshift wins: you cannot commit, push/);
  assert.match(block, /Left for the owner/);
  const { store } = startPlan(t, env, scriptedWorker(), scriptedReviewer());
  const plan = store.read().plan;
  assert.deepEqual(plan.rules.map(r => r.path), ['AGENTS.md', 'CLAUDE.local.md']);
  const task = plan.tasks[0];
  const checks = { passed: true, results: [] };
  for (const prompt of [editWorkerPrompt(task, plan), editReviewerPrompt(task, {}, { checks, reviewDiff: '' }, plan),
    finalReviewPrompt(plan, { stat: '', reviewDiff: '' }, checks)]) assert.match(prompt, /Codeword HERON[\s\S]*end of project rules/);
});

test('effort: rated difficulty sets the start, each retry goes one level up, reviewers stay fixed', async t => {
  const { workerEffort, validateEffort, codexEffort } = await import('../src/effort.js');
  const settings = validateEffort({});
  assert.deepEqual([1, 2, 3].map(attempts => workerEffort({ difficulty: 'medium', attempts }, settings)), ['medium', 'high', 'xhigh']);
  assert.equal(workerEffort({ difficulty: 'low', attempts: 1 }, settings), 'medium', 'never below the minimum');
  assert.equal(workerEffort({ difficulty: 'high', attempts: 5 }, settings), 'xhigh', 'never above the maximum');
  assert.equal(workerEffort({ attempts: 1 }, settings), 'medium', 'unrated tasks count as medium');
  assert.throws(() => validateEffort({ min: 'max', max: 'low' }), /min \(max\) is above max \(low\)/);
  assert.throws(() => validateEffort({ speed: 'high' }), /Unknown effort setting speed/);
  assert.deepEqual(['low', 'medium', 'high', 'xhigh', 'max'].map(codexEffort), ['low', 'medium', 'high', 'high', 'high']);

  const env = makeRepo(t);
  const seen = [];
  const worker = scriptedWorker({ 'one:1': { 'notes/one.txt': 'BAD\n' }, 'one:2': { 'notes/one.txt': 'good\n' } });
  const tracking = { async execute(task, context) { seen.push(['worker', task.attempts, context.effort]); return worker.execute(task, context); } };
  const reviewer = { async review(task, result, context) { seen.push([context.final ? 'final' : 'reviewer', null, context.effort]); return { passed: true, reason: 'ok' }; } };
  const { store, supervisor } = startPlan(t, env, tracking, reviewer, { tasks: [{ id: 'one', title: 'x', acceptance: 'x', difficulty: 'medium' }] });
  await supervisor.run();
  assert.deepEqual(seen, [['worker', 1, 'medium'], ['worker', 2, 'high'], ['reviewer', null, 'high'], ['final', null, 'high']]);
  const state = store.read();
  assert.equal(state.tasks[0].effort, 'high');
  assert.match(state.events.filter(e => e.type === 'dispatched').map(e => e.detail).join(' | '), /Attempt 1 at medium effort \| Attempt 2 at high effort/);
  const { claudeArgs } = await import('../src/claude/session.js');
  const args = claudeArgs({ sessionId: 'x', outputSchema: {}, effort: 'high' });
  assert.equal(args[args.indexOf('--effort') + 1], 'high');
});

test('a failing baseline blocks the plan before any task runs; retry re-checks it', async t => {
  const env = makeRepo(t);
  writeFileSync(join(env.repo, 'notes', 'old.txt'), 'BAD from before\n');
  git(env.repo, 'add', '-A');
  git(env.repo, 'commit', '-q', '-m', 'broken baseline');
  const worker = scriptedWorker();
  const { store, workspace, supervisor } = startPlan(t, env, worker, scriptedReviewer());
  await supervisor.run();
  let state = store.read();
  assert.equal(state.plan.status, 'blocked');
  assert.match(state.plan.reason, /checks fail before any change[\s\S]*BAD in old\.txt/);
  assert.equal(worker.calls.length, 0, 'no task was dispatched');
  // The owner fixes the project on the plan branch, then reopens the plan.
  writeFileSync(join(workspace.worktree, 'notes', 'old.txt'), 'fixed\n');
  git(workspace.worktree, 'commit', '-q', '-am', 'fix baseline');
  Store.enqueue(env.state, 'retry', { id: 'demo-plan' });
  Store.enqueue(env.state, 'resume');
  await supervisor.run();
  state = store.read();
  assert.equal(state.plan.status, 'awaiting-approval');
  assert.equal(state.events.filter(e => e.type === 'baseline-checks').length, 2);
});

test('the owner can skip a check-only task; dependents proceed', async t => {
  const env = makeRepo(t);
  const worker = scriptedWorker({ one: {} }); // task one changes nothing, like a "confirm the baseline" step
  const { store, supervisor } = startPlan(t, env, worker, scriptedReviewer());
  await supervisor.run();
  let state = store.read();
  assert.deepEqual(state.tasks.map(x => x.status), ['blocked', 'ready']);
  Store.enqueue(env.state, 'skip', { id: 'one' });
  await supervisor.run();
  state = store.read();
  assert.deepEqual(state.tasks.map(x => [x.status, x.skipped === true]), [['done', true], ['done', false]]);
  assert.equal(state.tasks[0].commit, undefined, 'skipped tasks are not committed');
  assert.equal(state.plan.status, 'awaiting-approval');
  const { plannerPrompt } = await import('../src/prompts.js');
  assert.match(plannerPrompt({ doc: 'd.md' }), /Every task must change files\. Do not create check-only tasks/);
});

test('files a build changes inside a submodule do not count as the plan\'s change', async t => {
  const env = makeRepo(t);
  const sub = join(env.root, 'sub');
  git(env.root, 'init', '-q', '-b', 'main', sub);
  writeFileSync(join(sub, 'lib.txt'), 'library\n');
  git(sub, 'add', '-A');
  git(sub, 'commit', '-q', '-m', 'lib');
  git(env.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'third_party/sub');
  git(env.repo, 'commit', '-q', '-m', 'add submodule');
  const { store, workspace, supervisor } = startPlan(t, env, scriptedWorker(), scriptedReviewer());
  git(workspace.worktree, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q');
  writeFileSync(join(workspace.worktree, 'third_party', 'sub', 'lib.txt'), 'patched by a build\n'); // dirty submodule
  await supervisor.run();
  const state = store.read();
  assert.equal(state.plan.status, 'awaiting-approval', state.plan.reason);
  assert.deepEqual(state.events.filter(e => e.type === 'change-inspected').map(e => e.detail.files), [['notes/one.txt'], ['notes/two.txt']]);
});

test('checks run in a sandbox: writes outside the worktree and network fail, with a hint; it can be turned off', async t => {
  const env = makeRepo(t);
  const home = mkdtempSync(join(tmpdir(), 'nightshift-home-'));
  const previous = process.env.NIGHTSHIFT_HOME;
  process.env.NIGHTSHIFT_HOME = home;
  t.after(() => { process.env.NIGHTSHIFT_HOME = previous; rmSync(home, { recursive: true, force: true }); });
  const worktree = join(env.root, 'wt');
  git(env.repo, 'worktree', 'add', '-q', '--detach', worktree);
  const outside = join(env.repo, 'escaped.txt');
  const checks = ['echo inside > inside.txt', `echo outside > ${JSON.stringify(outside)}`, 'echo t > "$TMPDIR/t.txt"'];
  const workspace = new Workspace({ repo: env.repo, worktree, checks, limits: { checkMinutes: 1 } });
  const sandboxed = await workspace.runChecks();
  assert.deepEqual(sandboxed.results.map(r => r.exitCode === 0), [true, false, true]);
  assert.equal(sandboxed.results[1].sandboxed, true);
  assert.match(sandboxed.results[1].output, /Operation not permitted[\s\S]*runs in a sandbox/);
  assert.equal(existsSync(outside), false, 'the owner\'s checkout was not touched');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ sandboxChecks: false }));
  const open = await workspace.runChecks();
  assert.equal(open.passed, true);
  assert.equal(existsSync(outside), true);
});

test('the owner can fix a blocked task in the worktree; accept checks it and commits it as the task', async t => {
  const env = makeRepo(t);
  const worker = scriptedWorker({ one: { 'notes/one.txt': 'BAD\n' } });
  const { store, workspace, supervisor } = startPlan(t, env, worker, scriptedReviewer());
  await supervisor.run();
  let state = store.read();
  assert.equal(state.tasks[0].status, 'blocked');
  // The owner (with Claude) fixes it by hand, here also touching a file outside the allowed paths.
  writeFileSync(join(workspace.worktree, 'notes', 'one.txt'), 'fixed by hand\n');
  writeFileSync(join(workspace.worktree, 'HANDNOTE.md'), 'why\n');
  Store.enqueue(env.state, 'accept', { id: 'one' });
  await supervisor.run();
  state = store.read();
  const one = state.tasks[0];
  assert.deepEqual([one.status, one.ownerFixed, one.review.reason], ['done', true, 'Fixed and accepted by the owner; the checks pass.']);
  assert.match(git(workspace.worktree, 'show', '--stat', '--format=%s', one.commit), /Write note one[\s\S]*HANDNOTE\.md/);
  assert.equal(worker.calls.filter(c => c.task === 'one').length, 2, 'no agent ran for the owner\'s fix');
  assert.equal(state.plan.status, 'awaiting-approval');
});

test('an owner fix that still fails the checks blocks again with the output', async t => {
  const env = makeRepo(t);
  const { store, workspace, supervisor } = startPlan(t, env, scriptedWorker({ one: { 'notes/one.txt': 'BAD\n' } }), scriptedReviewer());
  await supervisor.run();
  writeFileSync(join(workspace.worktree, 'notes', 'one.txt'), 'still BAD\n');
  Store.enqueue(env.state, 'accept', { id: 'one' });
  await supervisor.run();
  const one = store.read().tasks[0];
  assert.equal(one.status, 'blocked');
  assert.match(one.reason, /owner's fix fails the checks[\s\S]*BAD in one\.txt/);
});

test('scratch files stay out of the change and the commit; cache re-reads do not count toward the token limit', async t => {
  const env = makeRepo(t);
  const worker = scriptedWorker({ one: { 'notes/one.txt': 'one\n', '.nightshift-scratch/screenshot.png': 'png' } });
  const counting = { calls: worker.calls, async execute(task, context) {
    // A long session: most input is the same context read again from the cache.
    context.onEvent({ type: 'usage', provider: 'test', tokens: { input: 2_000_000, cachedInput: 1_999_900, output: 50 } });
    return worker.execute(task, context);
  } };
  const { store, workspace, supervisor } = startPlan(t, env, counting, scriptedReviewer(), { limits: { tokens: 1000 } });
  await supervisor.run();
  const state = store.read();
  assert.equal(state.plan.status, 'awaiting-approval', 'two tasks of 150 new tokens each stay under a 1,000-token limit');
  const one = state.tasks.find(x => x.id === 'one');
  assert.equal(git(workspace.worktree, 'show', '--name-only', '--format=', one.commit), 'notes/one.txt');
  assert.equal(existsSync(join(workspace.worktree, '.nightshift-scratch', 'screenshot.png')), true, 'the scratch file is still there for the agent');
  assert.equal(workspace.clean(), true);
});

test('the planner and the interviewer ask for milestones, not chores', async () => {
  const { plannerPrompt, interviewPrompt } = await import('../src/prompts.js');
  const planner = plannerPrompt({ doc: 'docs/PLAN.md', rules: [] });
  assert.match(planner, /Tasks are milestones, not chores/);
  assert.match(planner, /renaming something[\s\S]*never tasks of their own/);
  assert.doesNotMatch(planner, /Do not invent, merge, split, or reorder/);
  const interview = interviewPrompt({ notes: 'x', projects: [] });
  assert.match(interview, /Each step is a milestone/);
});

test('a timed-out turn is not a blocker: the task runs again, told what the last attempt left behind', async t => {
  const env = makeRepo(t);
  const { TurnTimeoutError } = await import('../src/supervisor.js');
  const seen = [];
  const worker = { async execute(task, { plan }) {
    seen.push({ attempt: task.attempts, leftover: task.leftover, timedOut: task.timedOut });
    if (task.id === 'one' && task.attempts === 1) {
      writeFileSync(join(plan.worktree, 'notes', 'one.txt'), 'half done\n');
      throw new TurnTimeoutError('Claude', 120);
    }
    writeFileSync(join(plan.worktree, 'notes', `${task.id}.txt`), `${task.id}\n`);
    return { summary: 'done', evidence: [`notes/${task.id}.txt`] };
  } };
  const { store, supervisor } = startPlan(t, env, worker, scriptedReviewer());
  await supervisor.run();
  const state = store.read();
  assert.equal(state.plan.status, 'awaiting-approval');
  assert.deepEqual(state.tasks.map(x => [x.id, x.status, x.attempts]), [['one', 'done', 2], ['two', 'done', 1]]);
  assert.deepEqual(seen[1], { attempt: 2, leftover: ['notes/one.txt'], timedOut: { minutes: 120, at: seen[1].timedOut.at } });
  assert.ok(state.events.some(e => e.type === 'turn-timeout' && /ran past 120 minutes[\s\S]*next attempt continues/.test(e.detail)));
  const { editWorkerPrompt } = await import('../src/prompts.js');
  const prompt = editWorkerPrompt({ ...state.tasks[0], attempts: 2, leftover: ['notes/one.txt'], timedOut: { minutes: 120 } }, state.plan);
  assert.match(prompt, /ran out of time after 120 minutes/);
  assert.match(prompt, /uncommitted changes from an earlier attempt \(notes\/one\.txt\)/);
  assert.match(prompt, /sandbox without a window server or network/);
});

test('a timeout on the last attempt blocks with advice to raise the time per turn', async t => {
  const env = makeRepo(t);
  const { TurnTimeoutError } = await import('../src/supervisor.js');
  const worker = { async execute() { throw new TurnTimeoutError('Claude', 120); } };
  const { store, supervisor } = startPlan(t, env, worker, scriptedReviewer(), { limits: { attemptsPerTask: 2 } });
  await supervisor.run();
  const one = store.read().tasks[0];
  assert.equal(one.status, 'blocked');
  assert.match(one.reason, /last attempt \(2 of 2\)[\s\S]*raise the time per turn \(limit turnMinutes\)/);
});

test('new plans get generous limits by default', async () => {
  const { defaultLimits } = await import('../src/plan.js');
  assert.deepEqual([defaultLimits.turnMinutes, defaultLimits.hours, defaultLimits.checkMinutes, defaultLimits.changedLinesPerTask, defaultLimits.tokens],
    [120, 24, 60, 3000, 20_000_000]);
});
