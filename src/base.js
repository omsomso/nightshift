import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { home, readConfig } from './home.js';

// Where a plan starts. Not whatever happens to be checked out: by default the project's main
// branch as it is on its remote (fetched first), so work merged from other sessions is
// included. `defaultBase` in the config can be 'remote' (default), 'local', or 'head'.
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 }).trim();
const tryGit = (cwd, args) => { try { return git(cwd, args); } catch { return null; } };

export function defaultBranch(repo) {
  const remoteHead = tryGit(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (remoteHead) return remoteHead.replace(/^origin\//, '');
  for (const name of ['main', 'master']) if (tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])) return name;
  return tryGit(repo, ['branch', '--show-current']) || 'HEAD';
}

export function resolveBase(repo, { base, fetch = true } = {}) {
  const notes = [];
  const hasOrigin = Boolean(tryGit(repo, ['remote', 'get-url', 'origin']));
  if (fetch && hasOrigin && (!base || base.startsWith('origin/'))) {
    try { git(repo, ['fetch', '--quiet', 'origin']); notes.push('fetched origin'); }
    catch (error) { notes.push(`could not fetch origin (${String(error.stderr || error.message).trim().split('\n')[0]}); using the last fetched state`); }
  }
  let ref = base;
  if (!ref) {
    const mode = readConfig().defaultBase ?? 'remote';
    const name = defaultBranch(repo);
    const remote = hasOrigin && tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`]);
    ref = mode === 'head' ? 'HEAD' : mode === 'remote' && remote ? `origin/${name}` : name;
  }
  const commit = tryGit(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (!commit) throw new Error(`${ref} is not a commit in ${repo}.`);
  const isSha = /^[0-9a-f]{7,40}$/.test(ref);
  const branch = ref === 'HEAD' || isSha ? (tryGit(repo, ['branch', '--show-current']) || null) : ref.replace(/^origin\//, '');
  return { ref, commit, branch, date: git(repo, ['log', '-1', '--format=%cI', commit]), subject: git(repo, ['log', '-1', '--format=%s', commit]), notes };
}

// Recent branches to start from, newest first (Nightshift's own plan branches left out).
export function listBranches(repo, { limit = 15 } = {}) {
  const out = tryGit(repo, ['for-each-ref', '--sort=-committerdate', `--count=${limit * 3}`,
    '--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)%09%(subject)', 'refs/heads', 'refs/remotes/origin']) ?? '';
  return out.split('\n').filter(Boolean).map(line => {
    const [ref, commit, date, ...subject] = line.split('\t');
    return { ref, commit, date, subject: subject.join('\t') };
  }).filter(b => b.ref !== 'origin' && b.ref !== 'origin/HEAD' && !b.ref.startsWith('nightshift/') && !b.ref.startsWith('origin/nightshift/'))
    .slice(0, limit);
}

// A read-only checkout of the base commit, so planning reads exactly the code a plan will
// start from. One per repository, moved when the base changes.
export function snapshotDir(repo) {
  const tag = createHash('sha256').update(repo).digest('hex').slice(0, 8);
  return join(home(), 'snapshots', `${basename(repo).replace(/[^A-Za-z0-9._-]/g, '_')}-${tag}`);
}

export function snapshot(repo, commit) {
  const dir = snapshotDir(repo);
  if (existsSync(dir)) {
    if (tryGit(dir, ['rev-parse', 'HEAD']) === commit) return dir;
    tryGit(repo, ['worktree', 'remove', '--force', dir]);
    rmSync(dir, { recursive: true, force: true });
    tryGit(repo, ['worktree', 'prune']);
  }
  mkdirSync(join(home(), 'snapshots'), { recursive: true });
  git(repo, ['worktree', 'add', '--detach', '--force', dir, commit]);
  return dir;
}

export const describeBase = base => `${base.ref} @ ${base.commit.slice(0, 7)} (${base.subject}${base.date ? `, ${base.date.slice(0, 16).replace('T', ' ')}` : ''})`;
