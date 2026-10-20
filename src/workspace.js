import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { protectedPaths } from './plan.js';
import { checkCommand, sandboxHint } from './sandbox.js';
import { dirname } from 'node:path';

const reviewDiffChars = 60_000;
// Inside the working copy, for screenshots, logs, and other scratch files agents make. Its own
// .gitignore keeps it out of every change and commit.
export const scratchDir = '.nightshift-scratch';
const checkOutputChars = 8_000;

function git(cwd, args, options = {}) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

const tail = (text, limit) => text.length > limit ? `[…${text.length - limit} earlier characters omitted]\n${text.slice(-limit)}` : text;

// The plan's isolated working copy. Nightshift, never an agent, stages, inspects,
// and commits here; agents only edit files inside it under an OS sandbox.
export class Workspace {
  constructor({ repo, worktree, branch, baseCommit, checks, allowedPaths, limits }) {
    Object.assign(this, { repo, worktree, branch, baseCommit, checks, allowedPaths, limits });
  }

  // Creates branch nightshift/<plan-id> in a new worktree. Refuses to reuse either.
  static create(plan, directory) {
    const repo = git(plan.repo, ['rev-parse', '--show-toplevel']).trim();
    const branch = `nightshift/${plan.id}`;
    const worktree = join(directory, 'worktree');
    if (existsSync(worktree)) throw new Error(`${worktree} already exists; use a new state directory.`);
    try { git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); throw new Error(`Branch ${branch} already exists in ${repo}; choose a new plan id.`); }
    catch (error) { if (error.message.includes('already exists')) throw error; }
    const baseCommit = git(repo, ['rev-parse', '--verify', `${plan.base}^{commit}`]).trim();
    git(repo, ['worktree', 'add', '-b', branch, worktree, baseCommit]);
    return new Workspace({ repo, worktree: realpathSync(worktree), branch, baseCommit,
      checks: plan.checks, allowedPaths: plan.allowedPaths, limits: plan.limits });
  }

  ensureScratch() {
    const dir = join(this.worktree, scratchDir);
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, '.gitignore'))) writeFileSync(join(dir, '.gitignore'), '*\n');
    return dir;
  }

  // Files changed in the working copy and not yet committed (the scratch folder is ignored).
  pending() {
    try {
      return git(this.worktree, ['status', '--porcelain', '--ignore-submodules=dirty']).split('\n').filter(Boolean).map(line => line.slice(3)).slice(0, 40);
    } catch { return []; }
  }

  // Stages everything and describes the change since the last commit on the branch.
  inspect() {
    git(this.worktree, ['add', '-A']);
    const files = git(this.worktree, ['diff', '--cached', '--numstat', '-z', '--no-renames', '--ignore-submodules=dirty']).split('\0').filter(Boolean).map(entry => {
      const [added, removed, ...path] = entry.split('\t');
      return { path: path.join('\t'), added: Number(added) || 0, removed: Number(removed) || 0, binary: added === '-' };
    });
    const diff = git(this.worktree, ['diff', '--cached', '--no-renames', '--ignore-submodules=dirty']);
    return { files, changedLines: files.reduce((sum, f) => sum + f.added + f.removed, 0), diff,
      reviewDiff: diff.length > reviewDiffChars ? `${diff.slice(0, reviewDiffChars)}\n[…diff truncated for review]` : diff };
  }

  // Deterministic gates run before any review. `block` stops the task; `repair` asks the worker to fix it.
  // The owner's own fix may go outside the allowed paths (never into protected ones).
  gate(change, { owner = false } = {}) {
    if (!change.files.length) return { verdict: 'block', reason: owner ? 'There are no changes in the worktree to accept.' : 'Stagnation: the attempt changed no files.' };
    const isProtected = path => protectedPaths.some(p => p.endsWith('/') ? path.startsWith(p) : path === p || path.startsWith(`${p}/`));
    const blockedPaths = change.files.map(f => f.path).filter(isProtected);
    if (blockedPaths.length) return { verdict: 'block', reason: `Drift: protected paths changed: ${blockedPaths.join(', ')}.` };
    const outside = owner ? [] : change.files.map(f => f.path).filter(path => !this.allowedPaths.some(prefix => path.startsWith(prefix)));
    if (outside.length) return { verdict: 'block', reason: `Drift: changes outside the plan's allowed paths: ${outside.join(', ')}.` };
    if (!owner && change.changedLines > this.limits.changedLinesPerTask) {
      return { verdict: 'repair', reason: `The change is ${change.changedLines} lines, over this plan's cap of ${this.limits.changedLinesPerTask}. Make a smaller change that still meets the task.` };
    }
    return { verdict: 'ok' };
  }

  // Runs the plan's checks in the worktree, one at a time, each with a timeout, inside the
  // check sandbox unless the owner turned it off (src/sandbox.js).
  async runChecks({ signal, onCheck } = {}) {
    const results = [];
    for (const [index, command] of this.checks.entries()) {
      onCheck?.({ index, total: this.checks.length, command });
      const started = Date.now();
      const run = checkCommand(command, { worktree: this.worktree, tmpRoot: join(dirname(this.worktree), 'check-tmp') });
      const result = await new Promise(resolve => {
        const child = spawn(run.file, run.args, { cwd: this.worktree, env: run.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
        let output = '';
        let timedOut = false;
        const collect = chunk => { output = tail(output + chunk, checkOutputChars * 4); };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
        const timer = setTimeout(() => { timedOut = true; kill(); }, this.limits.checkMinutes * 60_000);
        signal?.addEventListener('abort', kill, { once: true });
        child.on('error', error => { output += `\n${error.message}`; });
        child.on('close', code => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', kill);
          const hint = code !== 0 && run.sandboxed ? sandboxHint(output) : '';
          resolve({ command, exitCode: timedOut ? null : code, timedOut, durationMs: Date.now() - started, sandboxed: run.sandboxed, output: tail(output, checkOutputChars) + hint });
        });
      });
      results.push(result);
      if (signal?.aborted) break;
    }
    return { passed: results.length === this.checks.length && results.every(r => r.exitCode === 0), results };
  }

  // Identifies an attempt for stagnation detection: same diff and same check output.
  static fingerprint(change, checks) {
    return createHash('sha256').update(change.diff).update(JSON.stringify(checks.results.map(r => [r.exitCode, r.output]))).digest('hex');
  }

  commit(task, planId) {
    // The worktree must still be this plan's branch in this repository before anything is committed.
    const branch = git(this.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const common = realpathSync(resolve(this.worktree, git(this.worktree, ['rev-parse', '--git-common-dir']).trim()));
    const expected = realpathSync(resolve(this.repo, git(this.repo, ['rev-parse', '--git-common-dir']).trim()));
    if (branch !== this.branch || common !== expected) throw new Error(`Worktree no longer points at ${this.branch} in ${this.repo}; refusing to commit.`);
    git(this.worktree, ['add', '-A']);
    git(this.worktree, ['-c', 'user.name=Nightshift', '-c', 'user.email=nightshift@local.invalid', 'commit', '--no-verify', '-q',
      '-m', task.title, '-m', `Nightshift-Plan: ${planId}\nNightshift-Task: ${task.id}`]);
    return git(this.worktree, ['rev-parse', 'HEAD']).trim();
  }

  planDiff() {
    const diff = git(this.worktree, ['diff', this.baseCommit, 'HEAD', '--no-renames']);
    const stat = git(this.worktree, ['diff', '--shortstat', this.baseCommit, 'HEAD']).trim();
    return { stat, reviewDiff: diff.length > reviewDiffChars ? `${diff.slice(0, reviewDiffChars)}\n[…diff truncated for review]` : diff };
  }

  // Dirty submodule contents (for example files a build generates inside them) do not count;
  // a changed submodule commit does.
  clean() { return !git(this.worktree, ['status', '--porcelain', '--ignore-submodules=dirty']).trim(); }
}
