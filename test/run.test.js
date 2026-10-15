import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
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
  const env = { ...process.env, NIGHTSHIFT_HOME: join(root, 'home'), NIGHTSHIFT_CLAUDE_BIN: join(bin, 'claude'), NIGHTSHIFT_CODEX_BIN: join(bin, 'codex') };
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
  assert.match(git(e.repo, 'log', '-1', '--format=%s', 'main'), /Merge Nightshift plan fixture-notes/);
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
  assert.equal(drafted.draft.plan.base, 'HEAD~1');
  e.cli('start', drafted.id);
  let state = Store.inspect(join(e.env.NIGHTSHIFT_HOME, 'plans', drafted.id));
  assert.equal(state.plan.base, 'HEAD~1');
  assert.equal(state.plan.baseCommit, first);
  assert.equal(existsSync(join(state.plan.worktree, 'later.txt')), false, 'the worktree starts from the chosen commit');

  const out = e.cli('run', 'docs/PLAN.md', '--yes', '--base', first);
  assert.match(out, new RegExp(`starting from ${first}`));
  const id = /Started: plan (\S+)/.exec(out)[1];
  state = Store.inspect(join(e.env.NIGHTSHIFT_HOME, 'plans', id));
  assert.equal(state.plan.baseCommit, first);

  const plain = JSON.parse(e.cli('draft', 'docs/PLAN.md', '--json'));
  assert.equal(plain.draft.plan.base, 'HEAD');
  e.cli('start', plain.id);
  assert.equal(Store.inspect(join(e.env.NIGHTSHIFT_HOME, 'plans', plain.id)).plan.baseCommit, head);

  const bad = spawnSync(process.execPath, [cliFile, 'draft', 'docs/PLAN.md', '--base', 'no-such-ref'], { cwd: e.repo, env: e.env, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--base no-such-ref is not a commit/);
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
