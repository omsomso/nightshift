import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
