import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, realpathSync, readdirSync } from 'node:fs';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../src/store.js';

const cliFile = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// A repository with a plan document, stand-in CLIs, and a private NIGHTSHIFT_HOME.
function setupEnv(t) {
  const root = mkdtempSync(join(tmpdir(), 'nightshift-run-'));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'notes'), { recursive: true });
  mkdirSync(join(repo, 'docs'));
  git(root, 'init', '-q', '-b', 'main', repo);
  writeFileSync(join(repo, 'notes', '.keep'), '');
  writeFileSync(join(repo, 'docs', 'PLAN.md'), '# Plan\n\n1. Write note one.\n2. Write note two.\n');
  writeFileSync(join(repo, 'check.js'), "require('fs').readdirSync('notes'); console.log('ok');\n");
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const claudeFixture = pathToFileURL(fileURLToPath(new URL('../fixtures/claude-cli.js', import.meta.url))).href;
  const codexFixture = pathToFileURL(fileURLToPath(new URL('../fixtures/codex-server.js', import.meta.url))).href;
  writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node\nif (process.argv[2] === '--version') console.log(process.env.FIXTURE_CLAUDE_VERSION ?? 'claude-fixture 1'); else if (process.argv[2] === 'auth') console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'plan' })); else { process.argv.splice(2, 0, 'normal'); import(${JSON.stringify(claudeFixture)}); }\n`, { mode: 0o700 });
  writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node\nif (process.argv[2] === '--version') console.log('codex-fixture 1'); else if (process.argv[2] === 'login') console.error('Logged in using ChatGPT'); else { process.argv[2] = 'normal'; import(${JSON.stringify(codexFixture)}); }\n`, { mode: 0o700 });
  const env = { ...process.env, NIGHTSHIFT_HOME: join(root, 'home'), NIGHTSHIFT_LAUNCH_AGENTS: join(root, 'agents'), NIGHTSHIFT_LAUNCHD: '0', NIGHTSHIFT_CLAUDE_BIN: join(bin, 'claude'), NIGHTSHIFT_CODEX_BIN: join(bin, 'codex') };
  delete env.NIGHTSHIFT_CLAUDE_VERSION;
  delete env.NIGHTSHIFT_CODEX_VERSION;
  const cli = (...args) => execFileSync(process.execPath, [cliFile, ...args], { cwd: repo, env, encoding: 'utf8', timeout: 30_000 });
  const json = () => JSON.parse(cli('list', '--json'));
  t.after(() => {
    // Stop any background runner this test started, then remove everything.
    try { for (const plan of json().plans) if (plan.runner) cli('stop', plan.id); } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  return { root, repo, env, cli, json };
}

async function until(check, ms = 20_000) {
  for (const deadline = Date.now() + ms; ; await new Promise(r => setTimeout(r, 150))) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting.');
  }
}

test('setup pins the installed versions, and runs refuse once a CLI changes', t => {
  const e = setupEnv(t);
  const out = e.cli('setup');
  assert.match(out, /claude: claude-fixture 1 \[claude\.ai plan\]/);
  assert.match(out, /codex: codex-fixture 1 \[chatgpt\]/);
  const config = JSON.parse(readFileSync(join(e.env.NIGHTSHIFT_HOME, 'config.json'), 'utf8'));
  assert.deepEqual(config.pins, { claude: 'claude-fixture 1', codex: 'codex-fixture 1' });
  const changed = spawnSync(process.execPath, [cliFile, 'draft', 'docs/PLAN.md'], { cwd: e.repo, encoding: 'utf8',
    env: { ...e.env, FIXTURE_CLAUDE_VERSION: 'claude-fixture 2' } });
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /version mismatch[\s\S]*Run `node src\/cli\.js setup`/);
});

test('one command drafts from a doc, runs in the background, and stops at approval; merge approves', async t => {
  const e = setupEnv(t);
  e.cli('setup');
  const out = e.cli('run', 'docs/PLAN.md', '--agents', 'claude:codex', '--yes');
  assert.match(out, /Plan fixture-notes for .*\(claude:codex\)/);
  assert.match(out, /1\. Write note one[\s\S]*2\. Write note two/);
  assert.match(out, /Started: plan fixture-notes/);
  const done = await until(() => e.json().plans.find(p => p.id === 'fixture-notes' && p.status === 'awaiting-approval'));
  assert.equal(done.runner, true, 'the runner keeps waiting until stopped');
  assert.deepEqual(done.tasks.map(x => x.status), ['done', 'done']);
  assert.equal(git(e.repo, 'log', '--oneline', 'main').split('\n').length, 1, 'main untouched before approval');
  assert.match(e.cli('merge', 'fixture-notes'), /Merged nightshift\/fixture-notes into main/);
  const merged = e.json().plans.find(p => p.id === 'fixture-notes');
  assert.equal(merged.status, 'merged');
  assert.equal(merged.runner, false);
  assert.match(git(e.repo, 'log', '-1', '--format=%s', 'main'), /^Merge fixture notes$/);
  assert.deepEqual(git(e.repo, 'ls-files', 'notes').split('\n').sort(), ['notes/.keep', 'notes/task-1.txt', 'notes/task-2.txt']);
});

test('a draft waits for approval, ids never collide, and merge refuses unsafe states', async t => {
  const e = setupEnv(t);
  e.cli('setup');
  const first = JSON.parse(e.cli('draft', 'docs/PLAN.md', '--json'));
  const second = JSON.parse(e.cli('draft', 'docs/PLAN.md', '--json', '--agents', 'codex:claude'));
  assert.deepEqual([first.id, second.id], ['fixture-notes', 'fixture-notes-2']);
  const listed = e.json().plans;
  assert.deepEqual(listed.map(p => [p.id, p.status, p.runner]), [['fixture-notes', 'draft', false], ['fixture-notes-2', 'draft', false]]);
  assert.match(spawnSync(process.execPath, [cliFile, 'merge', 'fixture-notes'], { cwd: e.repo, env: e.env, encoding: 'utf8' }).stderr, /No plan named/);
  e.cli('start', 'fixture-notes-2');
  await until(() => e.json().plans.find(p => p.id === 'fixture-notes-2' && p.status === 'awaiting-approval'));
  writeFileSync(join(e.repo, 'dirty.txt'), 'uncommitted\n');
  const refused = spawnSync(process.execPath, [cliFile, 'merge', 'fixture-notes-2'], { cwd: e.repo, env: e.env, encoding: 'utf8' });
  assert.match(refused.stderr, /uncommitted changes/);
  assert.equal(git(e.repo, 'log', '--oneline', 'main').split('\n').length, 1);
  assert.equal(e.json().plans.find(p => p.id === 'fixture-notes-2').status, 'awaiting-approval');
});

test('stop ends an idle runner promptly instead of after its poll interval', async t => {
  const e = setupEnv(t);
  e.cli('setup');
  e.cli('draft', 'docs/PLAN.md', '--json');
  e.cli('start', 'fixture-notes');
  await until(() => e.json().plans.find(p => p.status === 'awaiting-approval'));
  const pid = Number(/runner pid (\d+)/.exec(e.cli('start', 'fixture-notes'))[1]);
  const started = Date.now();
  e.cli('stop', 'fixture-notes');
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 3000);
  assert.ok(Date.now() - started < 3000);
});

test('draft and run accept --base; the plan records it and its worktree starts there', async t => {
  const e = setupEnv(t);
  e.cli('setup');
  const first = git(e.repo, 'rev-parse', 'HEAD');
  writeFileSync(join(e.repo, 'later.txt'), 'later\n');
  git(e.repo, 'add', '-A');
  git(e.repo, 'commit', '-q', '-m', 'later');
  const head = git(e.repo, 'rev-parse', 'HEAD');

  const drafted = JSON.parse(e.cli('draft', 'docs/PLAN.md', '--json', '--base', 'HEAD~1'));
  assert.equal(drafted.draft.plan.base, first, 'the draft pins the exact commit it planned against');
  assert.equal(drafted.draft.plan.baseRef, 'HEAD~1');
  e.cli('start', drafted.id);
  let state = Store.inspect(join(e.env.NIGHTSHIFT_HOME, 'plans', drafted.id));
  assert.equal(state.plan.baseRef, 'HEAD~1');
  assert.equal(state.plan.baseCommit, first);
  assert.equal(existsSync(join(state.plan.worktree, 'later.txt')), false, 'the worktree starts from the chosen commit');

  const out = e.cli('run', 'docs/PLAN.md', '--yes', '--base', first);
  assert.match(out, new RegExp(`starting from ${first}`));
  const id = /Started: plan (\S+)/.exec(out)[1];
  state = Store.inspect(join(e.env.NIGHTSHIFT_HOME, 'plans', id));
  assert.equal(state.plan.baseCommit, first);

  const plain = JSON.parse(e.cli('draft', 'docs/PLAN.md', '--json'));
  assert.equal(plain.draft.plan.baseRef, 'main', 'without a remote, the local main branch');
  assert.equal(plain.draft.plan.base, head);
  e.cli('start', plain.id);
  assert.equal(Store.inspect(join(e.env.NIGHTSHIFT_HOME, 'plans', plain.id)).plan.baseCommit, head);

  const bad = spawnSync(process.execPath, [cliFile, 'draft', 'docs/PLAN.md', '--base', 'no-such-ref'], { cwd: e.repo, env: e.env, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /no-such-ref is not a commit/);
});

test('a turned-off provider is never started, and defaults follow the switch', t => {
  const e = setupEnv(t);
  assert.match(e.cli('disable', 'codex'), /codex is now off\. New plans default to: claude\./);
  assert.match(e.cli('setup'), /codex: turned off; skipped/);
  const drafted = JSON.parse(e.cli('draft', 'docs/PLAN.md', '--json'));
  assert.equal(drafted.draft.agents, 'claude', 'Claude works and reviews when Codex is off');
  const refused = spawnSync(process.execPath, [cliFile, 'draft', 'docs/PLAN.md', '--agents', 'codex:claude'], { cwd: e.repo, env: e.env, encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /codex is turned off in Nightshift\. Run `node src\/cli\.js enable codex`/);
  assert.match(e.cli('enable', 'codex'), /codex is now on\. New plans default to: claude:codex\./);
  assert.equal(JSON.parse(e.cli('draft', 'docs/PLAN.md', '--json')).draft.agents, 'claude:codex');
});

test('setup installs the nightshift command and skill, and never overwrites foreign files', t => {
  const e = setupEnv(t);
  const root = join(e.root, 'install-root');
  mkdirSync(join(root, '.claude'), { recursive: true });
  mkdirSync(join(root, '.local', 'bin'), { recursive: true });
  e.env.NIGHTSHIFT_INSTALL_ROOT = root;
  const out = e.cli('setup');
  assert.match(out, /installed: .*\.local\/bin\/nightshift/);
  assert.match(out, /installed: .*\.claude\/skills\/nightshift\/SKILL\.md/);
  assert.doesNotMatch(out, /\.codex\/skills/, 'no Codex folder, no Codex skill');
  const skill = readFileSync(join(root, '.claude', 'skills', 'nightshift', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: nightshift\n/);
  const listed = execFileSync(join(root, '.local', 'bin', 'nightshift'), ['list'], { env: e.env, encoding: 'utf8' });
  assert.match(listed, /No plans yet/);
  assert.match(e.cli('setup'), /unchanged: .*nightshift/);
  writeFileSync(join(root, '.local', 'bin', 'nightshift'), '#!/bin/sh\necho mine\n');
  assert.match(e.cli('setup'), /skipped \(a file Nightshift did not write is already there\): .*\.local\/bin\/nightshift/);
});

test('plan chat keeps one conversation and extracts the plan document', t => {
  const e = setupEnv(t);
  e.cli('setup');
  const first = JSON.parse(e.cli('chat', '--repo', e.repo, '--message', 'Help me plan two notes.'));
  assert.match(first.session, /^[0-9a-f-]{36}$/);
  assert.equal(first.document, '# Plan\n\n1. Write note one.\n');
  const second = JSON.parse(e.cli('chat', '--repo', e.repo, '--session', first.session, '--message', 'Add a second note.'));
  assert.equal(second.session, first.session, 'the same conversation is resumed');
  assert.match(second.document, /2\. Write note two\./);
  const status = JSON.parse(e.cli('providers', '--json'));
  assert.deepEqual(status.providers.map(p => [p.name, p.enabled, p.signedIn]), [['codex', true, true], ['claude', true, true]]);
});

test('interview from notes: picks the project, asks questions, then writes the roadmap', async t => {
  const e = setupEnv(t);
  e.cli('setup');
  e.cli('workspaces', 'set', e.root);
  const listed = JSON.parse(e.cli('projects', '--json'));
  assert.ok(listed.projects.some(p => p.path === e.repo && p.name === 'repo'));
  const first = JSON.parse(e.cli('chat', '--notes', '--message', 'notes: two notes please, keep them short'));
  assert.equal(realpathSync(first.repo), realpathSync(e.repo), 'the interviewer picked the project');
  assert.deepEqual(first.questions, [{ question: 'Keep notes short?', multiple: false, options: [{ label: 'Yes' }, { label: 'No' }] }]);
  const { parseReply } = await import('../src/chat.js');
  const rich = parseReply('```nightshift-questions\n[{"question": "Q?", "options": [{"label": "A", "detail": "why A", "recommended": true}, "B", {"nolabel": 1}]}]\n```');
  assert.deepEqual(rich.questions[0].options, [{ label: 'A', detail: 'why A', recommended: true }, { label: 'B' }]);
  assert.doesNotMatch(first.reply, /nightshift-(repo|questions)/, 'machine blocks are not shown as text');
  const second = JSON.parse(e.cli('chat', '--session', first.session, '--cwd', first.cwd, '--repo', first.repo, '--with-rules',
    '--message', 'Keep notes short?: Yes'));
  assert.equal(second.session, first.session);
  assert.match(second.document, /1\. Write note one\./);
});

test('drafts carry difficulty ratings the owner can change; effort settings are validated', t => {
  const e = setupEnv(t);
  e.cli('setup');
  assert.match(e.cli('effort'), /within medium…xhigh[\s\S]*Reviewers: high/);
  assert.match(e.cli('effort', 'set', 'reviewer', 'max'), /Reviewers: max/);
  const bad = spawnSync(process.execPath, [cliFile, 'effort', 'set', 'min', 'max'], { cwd: e.repo, env: e.env, encoding: 'utf8' });
  assert.match(bad.stderr, /min \(max\) is above max \(xhigh\)/);
  const drafted = JSON.parse(e.cli('draft', 'docs/PLAN.md', '--json'));
  assert.deepEqual(drafted.draft.plan.tasks.map(task => task.difficulty), ['low', 'high']);
  assert.match(e.cli('draft', 'docs/PLAN.md'), /\[high: Pretend this is subtle\.\]/);
  assert.match(e.cli('difficulty', 'note-two', 'medium', '--plan', drafted.id), /Draft updated/);
  const listed = e.json().plans.find(p => p.id === drafted.id);
  assert.equal(listed.tasks[1].difficulty, 'medium');
});

test('by default a plan starts from the fetched main branch, not the checkout, and plans from a snapshot of it', async t => {
  const e = setupEnv(t);
  e.cli('setup');
  // A remote whose main is ahead of this checkout, which sits on an old feature branch.
  const remote = join(e.root, 'origin.git');
  git(e.root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(e.repo, 'remote', 'add', 'origin', remote);
  git(e.repo, 'push', '-q', '-u', 'origin', 'main');
  git(e.repo, 'remote', 'set-head', 'origin', 'main');
  const other = join(e.root, 'other');
  git(e.root, 'clone', '-q', remote, other);
  writeFileSync(join(other, 'merged-elsewhere.txt'), 'work merged by another session\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-q', '-m', 'merged elsewhere');
  git(other, 'push', '-q', 'origin', 'main');
  const upstream = git(other, 'rev-parse', 'HEAD');
  git(e.repo, 'checkout', '-q', '-b', 'old-feature');
  const listed = JSON.parse(e.cli('branches', '--repo', e.repo, '--json'));
  assert.equal(listed.default.ref, 'origin/main');
  assert.equal(listed.default.commit, upstream);
  assert.ok(listed.branches.some(b => b.ref === 'old-feature'));
  const drafted = JSON.parse(e.cli('draft', 'docs/PLAN.md', '--json'));
  assert.deepEqual([drafted.draft.plan.baseRef, drafted.draft.plan.base, drafted.draft.plan.baseBranch], ['origin/main', upstream, 'main']);
  const snapshots = readdirSync(join(e.env.NIGHTSHIFT_HOME, 'snapshots'));
  assert.equal(snapshots.length, 1);
  assert.ok(existsSync(join(e.env.NIGHTSHIFT_HOME, 'snapshots', snapshots[0], 'merged-elsewhere.txt')), 'the planner reads the fetched main');
  e.cli('start', drafted.id);
  await until(() => e.json().plans.find(p => p.id === drafted.id && p.status === 'awaiting-approval'));
  const plan = Store.inspect(join(e.env.NIGHTSHIFT_HOME, 'plans', drafted.id)).plan;
  assert.equal(plan.baseCommit, upstream);
  assert.ok(existsSync(join(plan.worktree, 'merged-elsewhere.txt')), 'the plan starts from the fetched main');
  // Approval merges into main (the base branch), not into the checked-out old-feature branch.
  assert.match(e.cli('merge', drafted.id), /into main/);
  assert.equal(git(e.repo, 'branch', '--show-current'), 'old-feature', 'the checkout was not switched');
  assert.match(git(e.repo, 'log', '-1', '--format=%s', 'main'), /^Merge /);
  assert.equal(git(e.repo, 'rev-parse', 'old-feature~0'), git(e.repo, 'rev-parse', 'HEAD'));
  // The merge is local only, so the next plan would leave it out until it is pushed.
  const after = JSON.parse(e.cli('branches', '--repo', e.repo, '--json', '--no-fetch'));
  assert.ok(after.warnings.some(w => w.kind === 'unpushed' && /Local main has \d+ commits? that origin\/main does not/.test(w.message)));
});

test('stopping a chat turn ends the Claude process and the command at once', async t => {
  const e = setupEnv(t);
  e.cli('setup');
  e.cli('workspaces', 'set', e.root);
  const child = spawn(process.execPath, [cliFile, 'chat', '--notes', '--message', 'take your time'], { cwd: e.repo, env: e.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(done => child.once('exit', code => done(code)));
  await new Promise(r => setTimeout(r, 1500));
  const started = Date.now();
  child.kill('SIGTERM');
  const code = await exited;
  assert.notEqual(code, 0);
  assert.ok(Date.now() - started < 3000, 'stopped promptly');
  assert.match(stderr, /Stopped by the owner/);
  // The stopped Claude process may need a moment to exit.
  await until(() => !spawnSync('pgrep', ['-f', 'take your time'], { encoding: 'utf8' }).stdout.trim(), 2000);
});

test('check reports where a plan would start, what it leaves out, and whether the checks pass there', async t => {
  const e = setupEnv(t);
  e.cli('setup');
  // Work the default start would leave out: a checked-out feature branch with a commit, and an uncommitted file.
  git(e.repo, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(e.repo, 'feature.txt'), 'feature work\n');
  git(e.repo, 'add', '-A');
  git(e.repo, 'commit', '-q', '-m', 'feature work');
  writeFileSync(join(e.repo, 'scratch.txt'), 'not committed\n');
  const ok = JSON.parse(e.cli('check', '--repo', e.repo, '--check', 'node check.js', '--json'));
  assert.equal(ok.base.ref, 'main');
  assert.deepEqual(ok.warnings.map(w => w.kind).sort(), ['checkout', 'uncommitted']);
  assert.deepEqual([ok.checks.source, ok.checks.ran, ok.ready], ['given', true, true]);
  assert.equal(readdirSync(join(e.env.NIGHTSHIFT_HOME, 'checks')).length, 0, 'the check worktree is removed');
  assert.equal(git(e.repo, 'worktree', 'list').split('\n').length, 1);
  // The checks run at the start commit, not in the checkout: a file only on the feature branch is absent.
  const absent = JSON.parse(e.cli('check', '--repo', e.repo, '--check', 'test ! -e feature.txt', '--json'));
  assert.equal(absent.ready, true);
  // A failing check: not ready, exit code 2, with the output.
  const failed = spawnSync(process.execPath, [cliFile, 'check', '--repo', e.repo, '--check', 'node -e "console.log(\'broken build\'); process.exit(3)"'],
    { cwd: e.repo, env: e.env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(failed.status, 2);
  assert.match(failed.stdout, /FAIL .*exit 3/);
  assert.match(failed.stdout, /broken build/);
  assert.match(failed.stdout, /Not ready/);
  // Drafts record what they leave out; check --plan uses the draft's own start and checks.
  const drafted = JSON.parse(e.cli('draft', 'docs/PLAN.md', '--json'));
  assert.ok(drafted.draft.warnings.some(w => w.kind === 'checkout'));
  assert.ok(e.json().plans.find(p => p.id === drafted.id).warnings.length >= 1);
  const byPlan = JSON.parse(e.cli('check', '--plan', drafted.id, '--json'));
  assert.deepEqual(byPlan.checks.commands, drafted.draft.plan.checks);
  assert.equal(byPlan.base.commit, drafted.draft.plan.base);
  // Without --check, a repository's latest plan supplies the checks; --no-run only reports.
  const known = JSON.parse(e.cli('check', '--repo', e.repo, '--no-run', '--json'));
  assert.deepEqual([known.checks.source, known.checks.ran, known.ready], [`plan ${drafted.id}`, false, null]);
});

test('queued plans run one after another: the next starts when the running one stops for the owner', async t => {
  const e = setupEnv(t);
  e.cli('setup');
  const first = JSON.parse(e.cli('draft', 'docs/PLAN.md', '--json')).id;
  const second = JSON.parse(e.cli('draft', 'docs/PLAN.md', '--json')).id;
  e.cli('queue', 'add', first);
  e.cli('queue', 'add', second);
  assert.deepEqual(JSON.parse(e.cli('queue', 'up', second, '--json')).queue, [second, first]);
  assert.deepEqual(e.json().plans.map(p => [p.id, p.queued]), [[first, 2], [second, 1]]);
  assert.match(e.cli('queue', 'start'), new RegExp(`Started ${second}`));
  await until(() => e.json().plans.every(p => p.status === 'awaiting-approval'), 40_000);
  assert.deepEqual(e.json().queue, []);
  const state = Store.inspect(join(e.env.NIGHTSHIFT_HOME, 'plans', second));
  assert.ok(state.events.some(ev => ev.type === 'queue-advanced' && ev.detail.includes(first)));
});

test('autostart installs a login item; resume-runners restarts runners that were on, not ones the owner stopped', async t => {
  const e = setupEnv(t);
  e.cli('setup');
  assert.match(e.cli('autostart', 'on'), /On: runners that were on start again at login/);
  const plist = readFileSync(join(e.env.NIGHTSHIFT_LAUNCH_AGENTS, 'com.nightshift.runners.plist'), 'utf8');
  assert.match(plist, /<string>resume-runners<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.equal(JSON.parse(e.cli('settings', '--json')).autostart, true);
  const id = JSON.parse(e.cli('draft', 'docs/PLAN.md', '--json')).id;
  e.cli('start', id);
  e.cli('pause', '--plan', id);
  await until(() => Store.inspect(join(e.env.NIGHTSHIFT_HOME, 'plans', id)).paused);
  // A restart: the runner dies without being stopped.
  const runner = Store.inspect(join(e.env.NIGHTSHIFT_HOME, 'plans', id)).runner;
  process.kill(runner.pid, 'SIGKILL');
  await until(() => !e.json().plans.find(p => p.id === id).runner);
  assert.match(e.cli('resume-runners'), new RegExp(`Started: ${id}`));
  assert.equal(e.json().plans.find(p => p.id === id).runner, true);
  // An explicit stop is remembered.
  e.cli('stop', id);
  assert.match(e.cli('resume-runners'), /Nothing to start/);
  e.cli('autostart', 'off');
  assert.equal(existsSync(join(e.env.NIGHTSHIFT_LAUNCH_AGENTS, 'com.nightshift.runners.plist')), false);
});

test('run settings are validated and stored', async t => {
  const e = setupEnv(t);
  e.cli('setup');
  e.cli('settings', 'set', 'onUsageLimit', 'stop');
  e.cli('settings', 'set', 'mergeStyle', 'pr');
  e.cli('settings', 'set', 'sandboxChecks', 'false');
  assert.deepEqual(JSON.parse(e.cli('settings', '--json')), { onUsageLimit: 'stop', sandboxChecks: false, checkNetwork: false, mergeStyle: 'pr', autostart: false, claudeModel: null, codexModel: null });
  // A model for Claude's agents, used by every runner and planner started afterwards; "default" clears it.
  e.cli('settings', 'set', 'claudeModel', 'claude-sonnet-5-5');
  assert.equal(JSON.parse(e.cli('settings', '--json')).claudeModel, 'claude-sonnet-5-5');
  const id = JSON.parse(e.cli('draft', 'docs/PLAN.md', '--json')).id;
  e.cli('start', id);
  return until(() => e.json().plans.find(p => p.id === id)?.models, 20_000).then(() => {
    // The stand-in reports the model it was started with (--model).
    assert.equal(e.json().plans.find(p => p.id === id).models.worker, 'claude-sonnet-5-5');
    e.cli('settings', 'set', 'claudeModel', 'default');
    assert.equal(JSON.parse(e.cli('settings', '--json')).claudeModel, null);
    const bad = spawnSync(process.execPath, [cliFile, 'settings', 'set', 'claudeModel', 'bad model; rm'], { env: e.env, encoding: 'utf8' });
    assert.match(bad.stderr, /must be a model name/);
  });
  const bad = spawnSync(process.execPath, [cliFile, 'settings', 'set', 'mergeStyle', 'push'], { env: e.env, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /must be one of: local, pr/);
});

test('approval can open a pull request instead: the branch is pushed and gh opens it into the base branch', async t => {
  const e = setupEnv(t);
  e.cli('setup');
  const remote = join(e.root, 'origin.git');
  git(e.root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(e.repo, 'remote', 'add', 'origin', remote);
  git(e.repo, 'push', '-q', '-u', 'origin', 'main');
  // A stand-in GitHub CLI that records its arguments.
  const ghLog = join(e.root, 'gh.log');
  writeFileSync(join(e.root, 'bin', 'gh'), `#!/bin/sh\necho "$@" >> ${ghLog}\n[ "$1" = auth ] && exit 0\necho "Creating pull request"\necho "https://github.com/example/repo/pull/7"\n`, { mode: 0o755 });
  e.env.NIGHTSHIFT_GH_BIN = join(e.root, 'bin', 'gh');
  const id = JSON.parse(e.cli('draft', 'docs/PLAN.md', '--json')).id;
  e.cli('start', id);
  await until(() => e.json().plans.find(p => p.id === id && p.status === 'awaiting-approval'), 30_000);
  assert.match(e.cli('merge', id, '--pr'), /opened a pull request into main: https:\/\/github.com\/example\/repo\/pull\/7/);
  assert.match(git(remote, 'branch', '--list', `nightshift/${id}`), new RegExp(`nightshift/${id}`), 'the plan branch was pushed');
  assert.match(readFileSync(ghLog, 'utf8'), new RegExp(`pr create --base main --head nightshift/${id} --title Write two notes\\.`));
  const plan = e.json().plans.find(p => p.id === id);
  assert.deepEqual([plan.status, plan.pullRequest], ['pr-open', 'https://github.com/example/repo/pull/7']);
  assert.equal(git(e.repo, 'log', '-1', '--format=%s', 'main'), 'initial', 'nothing was merged locally');
  assert.match(spawnSync(process.execPath, [cliFile, 'discard', id], { env: e.env, encoding: 'utf8' }).stderr, /stay on GitHub/);
  e.cli('discard', id, '--yes');
  assert.match(git(remote, 'branch', '--list', `nightshift/${id}`), /nightshift/, 'the remote branch stays');
});

test('a draft can be edited before approval: reword, reorder, remove, add tasks, change checks', t => {
  const e = setupEnv(t);
  e.cli('setup');
  const drafted = JSON.parse(e.cli('draft', 'docs/PLAN.md', '--json'));
  const [one, two] = drafted.draft.plan.tasks;
  const changes = join(e.root, 'changes.json');
  writeFileSync(changes, JSON.stringify({ checks: ['node check.js', 'node -e "1"'], tasks: [
    { ...two, title: 'Write note two first' }, { title: 'Write a third note', acceptance: 'notes/three.txt exists.' }, { title: 'Write a third note', acceptance: 'Again.' }] }));
  const edited = JSON.parse(e.cli('edit', drafted.id, '--file', changes, '--json'));
  assert.deepEqual(edited.tasks.map(t => t.id), [two.id, 'write-a-third-note', 'write-a-third-note-2']);
  assert.equal(edited.tasks[0].title, 'Write note two first');
  assert.equal(edited.limits.dispatches, 11);
  const listed = e.json().plans.find(p => p.id === drafted.id);
  assert.deepEqual(listed.tasks.map(t => t.title), ['Write note two first', 'Write a third note', 'Write a third note']);
  assert.ok(!listed.tasks.some(t => t.id === one.id), 'removed task is gone');
  writeFileSync(changes, JSON.stringify({ checks: [] }));
  const bad = spawnSync(process.execPath, [cliFile, 'edit', drafted.id, '--file', changes], { env: e.env, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /checks must list at least one command/);
});

test('review, activity, usage, and fix-prompt describe a plan for the owner', async t => {
  const e = setupEnv(t);
  e.cli('setup');
  const done = JSON.parse(e.cli('draft', 'docs/PLAN.md', '--json')).id;
  e.cli('start', done);
  await until(() => e.json().plans.find(p => p.id === done && p.status === 'awaiting-approval'), 30_000);
  const review = JSON.parse(e.cli('review', done, '--json'));
  assert.equal(review.tasks.length, 2);
  assert.match(review.tasks[0].diff, /\+\+\+ b\/notes\/task-1\.txt/);
  assert.equal(review.tasks[0].review.reason, 'Fixture review only.');
  assert.equal(review.tasks[0].checks.passed, true);
  assert.match(review.final.stat, /2 files changed/);
  assert.match(review.final.diff, /task-2\.txt/);
  const live = JSON.parse(e.cli('activity', done, '--json'));
  assert.ok(live.lines.some(l => l.kind === 'tool' && /Read README\.md/.test(l.text)), 'tool calls show what they touched');
  assert.ok(live.lines.some(l => l.kind === 'commit'));
  const used = JSON.parse(e.cli('usage', '--json'));
  assert.equal(used.plans.find(p => p.id === done).turns > 0, true);
  assert.equal(used.days.length, 1);
  // A blocked plan gets a prompt for an interactive fix.
  writeFileSync(join(e.repo, 'check.js'), "const fs = require('fs'); for (const f of fs.readdirSync('notes')) if (fs.readFileSync('notes/' + f, 'utf8').includes('BAD')) { console.error('BAD in notes/' + f); process.exit(1); }\n");
  git(e.repo, 'commit', '-qam', 'stricter check');
  e.env.FIXTURE_EDIT_CONTENT = 'BAD';
  const blocked = JSON.parse(e.cli('draft', 'docs/PLAN.md', '--json')).id;
  e.cli('start', blocked);
  await until(() => e.json().plans.find(p => p.id === blocked)?.blocker, 30_000);
  const fix = JSON.parse(e.cli('fix-prompt', blocked, '--json'));
  assert.match(fix.cwd, /worktree$/);
  assert.match(fix.prompt, new RegExp(`nightshift accept note-one --plan ${blocked}`));
  assert.match(fix.prompt, /BAD in notes/);
});

test('plans merged outside Nightshift are noticed: by hand into main, or a pull request merged on GitHub', async t => {
  const e = setupEnv(t);
  e.cli('setup');
  const remote = join(e.root, 'origin.git');
  git(e.root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(e.repo, 'remote', 'add', 'origin', remote);
  git(e.repo, 'push', '-q', '-u', 'origin', 'main');
  writeFileSync(join(e.root, 'bin', 'gh'), `#!/bin/sh\n[ "$1" = auth ] && exit 0\n[ "$1 $2" = "pr view" ] && echo '{"state":"MERGED","mergedAt":"2026-10-20T15:33:36Z"}' && exit 0\necho "https://github.com/example/repo/pull/9"\n`, { mode: 0o755 });
  e.env.NIGHTSHIFT_GH_BIN = join(e.root, 'bin', 'gh');
  const byHand = JSON.parse(e.cli('draft', 'docs/PLAN.md', '--json')).id;
  const viaPr = JSON.parse(e.cli('draft', 'docs/PLAN.md', '--json')).id;
  e.cli('start', byHand);
  e.cli('start', viaPr);
  await until(() => e.json().plans.every(p => p.status === 'awaiting-approval'), 40_000);
  // The owner merges one branch by hand, and opens a pull request for the other.
  git(e.repo, 'merge', '-q', '--no-ff', '-m', 'merge by hand', `nightshift/${byHand}`);
  e.cli('merge', viaPr, '--pr');
  let plans = e.json().plans;
  const hand = plans.find(p => p.id === byHand);
  assert.deepEqual([hand.status, hand.mergedOutside], ['merged', 'its commits are in main']);
  assert.equal(plans.find(p => p.id === viaPr).status, 'pr-open', 'a squash-merged pull request needs GitHub to tell');
  assert.match(e.cli('sync'), new RegExp(`${viaPr}: merged \\(its pull request was merged on GitHub\\)`));
  plans = e.json().plans;
  assert.deepEqual([plans.find(p => p.id === viaPr).status, plans.find(p => p.id === viaPr).mergedAt], ['merged', '2026-10-20T15:33:36Z']);
  assert.match(e.cli('sync'), /No plan was merged outside Nightshift/);
});

test('a pause says why; a draft report shows the draft', t => {
  const e = setupEnv(t);
  e.cli('setup');
  const id = JSON.parse(e.cli('draft', 'docs/PLAN.md', '--json')).id;
  const report = e.cli('report', '--plan', id);
  assert.match(report, new RegExp(`# Draft \`${id}\`: waiting for approval`));
  assert.match(report, /1\. \*\*Write note one\*\* \(low\)[\s\S]*Done when: A first note exists\./);
  assert.match(report, /120 min per turn, 24 h per plan, 20M new tokens/);
  e.cli('start', id);
  e.cli('pause', '--plan', id, '--reason', 'Paused to raise the limits');
  const paused = () => e.json().plans.find(p => p.id === id);
  // The runner applies the pause at its next step; the plan may finish first, so only check when it paused.
  const state = Store.inspect(join(e.env.NIGHTSHIFT_HOME, 'plans', id));
  assert.ok(state.pendingCommands >= 0);
  return until(() => paused().pauseReason || paused().status === 'awaiting-approval', 20_000).then(() => {
    const plan = paused();
    if (plan.pauseReason) assert.equal(plan.pauseReason.text, 'Paused to raise the limits');
  });
});

test('setup from a test home or a temporary copy never takes over the installed command and skill', t => {
  const e = setupEnv(t);
  // A fake user home, so the real one is never touched; no NIGHTSHIFT_INSTALL_ROOT.
  const userHome = join(e.root, 'user');
  mkdirSync(join(userHome, '.claude'), { recursive: true });
  const env = { ...e.env, HOME: userHome };
  delete env.NIGHTSHIFT_INSTALL_ROOT;
  const out = execFileSync(process.execPath, [cliFile, 'setup'], { cwd: e.repo, env, encoding: 'utf8', timeout: 30_000 });
  assert.match(out, /skipped \(NIGHTSHIFT_HOME points to a separate home/);
  assert.equal(existsSync(join(userHome, '.local', 'bin', 'nightshift')), false);
  assert.equal(existsSync(join(userHome, '.claude', 'skills', 'nightshift', 'SKILL.md')), false);
});
