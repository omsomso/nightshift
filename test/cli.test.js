import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir, hostname } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { renderReport } from '../src/report.js';

const cliFile = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// A repository and a private NIGHTSHIFT_HOME. Plans are created with `plan --state`, so no agents run.
function setupEnv(t) {
  const root = mkdtempSync(join(tmpdir(), 'nightshift-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  mkdirSync(join(repo, 'notes'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main', repo);
  writeFileSync(join(repo, 'notes', '.keep'), '');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  const env = { ...process.env, NIGHTSHIFT_HOME: home };
  const run = (...args) => spawnSync(process.execPath, [cliFile, ...args], { cwd: repo, env, encoding: 'utf8', timeout: 20_000 });
  const cli = (...args) => {
    const result = run(...args);
    if (result.status !== 0) throw new Error(`cli ${args.join(' ')} exited ${result.status}: ${result.stderr}`);
    return result.stdout;
  };
  const planDir = id => join(home, 'plans', id);
  const definition = (id, overrides = {}) => ({ id, repo, brief: 'Write a note.', checks: ['true'], allowedPaths: ['notes/'],
    tasks: [{ id: 'one', title: 'Write note one', acceptance: 'notes/one.txt exists.' }], ...overrides });
  // A started plan: worktree, branch, and queued tasks, with no runner.
  const startedPlan = (id, overrides) => {
    const file = join(root, `${id}.json`);
    writeFileSync(file, JSON.stringify(definition(id, overrides)));
    cli('plan', file, '--state', planDir(id));
    return planDir(id);
  };
  const draft = (id, overrides) => {
    mkdirSync(planDir(id), { recursive: true });
    writeFileSync(join(planDir(id), 'draft.json'), JSON.stringify({ plan: definition(id, overrides), notes: '', agents: 'claude:codex' }));
    return planDir(id);
  };
  return { root, repo, home, env, run, cli, planDir, startedPlan, draft };
}

test('logs prints the tail of a plan runner log and rejects unknown plans', t => {
  const e = setupEnv(t);
  const dir = e.draft('notes');
  assert.match(e.cli('logs', 'notes'), /no runner log yet/);
  writeFileSync(join(dir, 'serve.log'), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  const all = e.cli('logs', 'notes').trimEnd().split('\n');
  assert.equal(all.length, 40);
  assert.deepEqual([all[0], all.at(-1)], ['line 11', 'line 50']);
  assert.deepEqual(e.cli('logs', 'notes', '--lines', '3').trimEnd().split('\n'), ['line 48', 'line 49', 'line 50']);
  const unknown = e.run('logs', 'missing');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /No plan or draft named missing/);
  assert.equal(e.run('logs', 'notes', '--lines', '0').status, 1);
});

// Edits a plan's saved state directly, as a runner or a merge would have.
function patchState(dir, { plan, lease, task } = {}) {
  const db = new DatabaseSync(join(dir, 'nightshift.db'));
  try {
    if (task) {
      const current = JSON.parse(db.prepare('SELECT data FROM tasks WHERE id = ?').get(task.id).data);
      db.prepare('UPDATE tasks SET status = ?, data = ? WHERE id = ?').run(task.status ?? current.status, JSON.stringify({ ...current, ...task }), task.id);
    }
    if (plan) {
      const current = JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'plan'").get().value);
      db.prepare("UPDATE meta SET value = ? WHERE key = 'plan'").run(JSON.stringify({ ...current, ...plan }));
    }
    if (lease) db.prepare('INSERT OR REPLACE INTO lease (id, owner, pid, host, acquired_at, expires_at) VALUES (1, ?, ?, ?, ?, ?)')
      .run('test', lease, hostname(), new Date().toISOString(), Date.now() + 60_000);
  } finally { db.close(); }
}

test('discard removes a draft, or a started plan with its worktree and branch, only with --yes', t => {
  const e = setupEnv(t);
  const draftDir = e.draft('sketch');
  const asked = e.run('discard', 'sketch');
  assert.equal(asked.status, 1);
  assert.match(asked.stderr, /would remove:[\s\S]*draft directory[\s\S]*--yes/);
  assert.equal(existsSync(draftDir), true);
  assert.match(e.cli('discard', 'sketch', '--yes'), /Discarded plan sketch/);
  assert.equal(existsSync(draftDir), false);

  const dir = e.startedPlan('work');
  const worktree = join(dir, 'worktree');
  writeFileSync(join(worktree, 'notes', 'wip.txt'), 'unfinished\n');
  git(worktree, 'add', '-A');
  git(worktree, '-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'accepted task');
  const preview = e.run('discard', 'work');
  assert.match(preview.stderr, /1 commit not merged anywhere; it is lost/);
  assert.equal(preview.status, 1);
  assert.match(preview.stderr, /worktree .*worktree[\s\S]*branch nightshift\/work[\s\S]*directory/);
  assert.equal(existsSync(worktree), true);
  e.cli('discard', 'work', '--yes');
  assert.equal(existsSync(dir), false);
  assert.equal(git(e.repo, 'branch', '--list', 'nightshift/work'), '');
  assert.doesNotMatch(git(e.repo, 'worktree', 'list'), /work/);
  assert.equal(e.run('discard', 'work', '--yes').status, 1, 'unknown plans are refused');
});

test('discard refuses while the runner is alive; a merged plan loses only its record and merged branch', t => {
  const e = setupEnv(t);
  const live = e.startedPlan('live');
  patchState(live, { lease: process.pid });
  const refused = e.run('discard', 'live', '--yes');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /running runner/);
  assert.equal(existsSync(join(live, 'worktree')), true);

  const merged = e.startedPlan('shipped');
  const main = git(e.repo, 'rev-parse', 'main');
  patchState(merged, { plan: { status: 'merged', mergeCommit: main } });
  const preview = e.run('discard', 'shipped');
  assert.match(preview.stderr, /plan record[\s\S]*branch nightshift\/shipped \(already merged\)/);
  assert.doesNotMatch(preview.stderr, /lost/);
  e.cli('discard', 'shipped', '--yes');
  assert.equal(existsSync(merged), false);
  assert.equal(git(e.repo, 'branch', '--list', 'nightshift/shipped'), '');
  assert.equal(git(e.repo, 'rev-parse', 'main'), main, 'the merged work stays');
});

test('limit rejects unknown names at once and queues known ones', t => {
  const e = setupEnv(t);
  const dir = e.startedPlan('limits');
  const refused = e.run('limit', 'speed', '5', '--plan', 'limits');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Unknown limit speed\. Valid limits: attemptsPerTask, turnMinutes, dispatches, tokens, hours, changedLinesPerTask, checkMinutes/);
  assert.equal(Store.inspect(dir).pendingCommands, 0, 'nothing was queued');
  assert.match(e.cli('limit', 'tokens', '8000000', '--plan', 'limits'), /Queued limit/);
  assert.equal(Store.inspect(dir).pendingCommands, 1);
});

test('list shows the running or reviewed task of each plan', t => {
  const e = setupEnv(t);
  e.draft('idea');
  const tasks = [{ id: 'one', title: 'Write note one', acceptance: 'x' }, { id: 'two', title: 'Write note two', acceptance: 'x' }];
  const busy = e.startedPlan('busy', { tasks });
  const checking = e.startedPlan('checking', { tasks });
  e.startedPlan('waiting', { tasks });
  patchState(busy, { task: { id: 'one', status: 'running' } });
  patchState(checking, { task: { id: 'two', status: 'review' } });
  const lines = e.cli('list').trimEnd().split('\n');
  const after = id => lines[lines.findIndex(line => line.startsWith(`${id} `)) + 1];
  assert.equal(after('busy'), '  now: Write note one');
  assert.equal(after('checking'), '  now: Write note two');
  assert.equal(lines.filter(line => line.includes('now:')).length, 2, 'drafts and idle plans have no now line');
});

test('the plan section of the report lists every task with attempts and latest checks', () => {
  const at = '2026-10-15T06:00:00.000Z';
  const task = (id, status, attempts) => ({ id, title: `Task ${id}`, status, attempts, dependencies: [] });
  const state = { version: 1, paused: false, plan: { id: 'p', status: 'running', branch: 'nightshift/p', baseCommit: 'abcdef1234567890',
    repo: '/repo', worktree: '/wt', startedAt: at, limits: { dispatches: 10, tokens: 1000, hours: 6 } },
  tasks: [task('a', 'done', 2), task('b', 'ready', 1), task('c', 'ready', 0)], events: [
    { taskId: 'a', type: 'checks', detail: { passed: false, results: [] }, at },
    { taskId: 'b', type: 'checks', detail: { passed: false, results: [] }, at },
    { taskId: 'a', type: 'checks', detail: { passed: true, results: [] }, at }
  ] };
  const report = renderReport(state, { now: new Date(at) });
  assert.match(report, /Tasks:\n- \*\*Task a\*\* \(`a`\) — done; 2 attempt\(s\); checks passed\n/);
  assert.match(report, /\(`b`\) — ready; 1 attempt\(s\); checks failed\n/);
  assert.match(report, /\(`c`\) — ready; 0 attempt\(s\); no checks yet\n/);
});

test('report --plan --json prints the same summary as that plan in list --json', t => {
  const e = setupEnv(t);
  e.startedPlan('alpha');
  e.draft('beta');
  const listed = JSON.parse(e.cli('list', '--json')).plans;
  for (const id of ['alpha', 'beta']) {
    const one = JSON.parse(e.cli('report', '--plan', id, '--json'));
    const entry = listed.find(p => p.id === id);
    assert.deepEqual(Object.keys(one), Object.keys(entry));
    assert.deepEqual({ ...one, limits: undefined }, { ...entry, limits: undefined }, 'only elapsed hours may differ');
  }
  assert.equal(JSON.parse(e.cli('report', '--plan', 'alpha', '--json')).status, 'running');
  const unknown = e.run('report', '--plan', 'missing', '--json');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /No plan or draft named missing/);
  assert.match(e.run('report', '--json').stderr, /requires --plan/);
  assert.match(e.cli('report', '--plan', 'alpha'), /^# Nightshift report/, 'without --json the Markdown report is unchanged');
});

test('the README command overview and --help describe the new commands', () => {
  const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
  const overview = readme.slice(readme.indexOf('Commands for plans'), readme.indexOf('## Try it offline'));
  for (const pattern of [/cli\.js logs <id>/, /cli\.js discard <id> --yes/, /--base/, /report --plan <id> --json/]) {
    assert.match(overview, pattern);
  }
  const help = spawnSync(process.execPath, [cliFile, '--help'], { encoding: 'utf8' }).stderr;
  for (const pattern of [/logs <id>/, /discard <id> --yes/, /--base ref/, /report --plan <id> --json/]) assert.match(help, pattern);
});
