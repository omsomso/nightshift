import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, rmSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { resolveBase, listBranches } from './base.js';
import { home, planDir, listPlanIds } from './home.js';
import { readDraft } from './plans.js';
import { Store } from './store.js';
import { Workspace } from './workspace.js';
import { defaultLimits } from './plan.js';

// Is a project ready for a plan? Answered while the owner is still there, instead of by a
// baseline that fails overnight: where the plan would start, work that would be left out,
// and whether the checks pass at exactly that commit.
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 }).trim();
const tryGit = (cwd, args) => { try { return git(cwd, args); } catch { return null; } };
const ahead = (repo, from, to) => Number(tryGit(repo, ['rev-list', '--count', `${from}..${to}`]) ?? 0);
const real = path => { try { return realpathSync(path); } catch { return path; } };

// Work that exists locally but would not be in the plan. Cheap: git only, no checks.
export function gitWarnings(repo, base, { recentDays = 3 } = {}) {
  const warnings = [];
  const add = (kind, message) => warnings.push({ kind, message });
  const short = base.commit.slice(0, 7);
  if (base.ref.startsWith('origin/') && base.branch && tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${base.branch}`])) {
    const n = ahead(repo, base.commit, `refs/heads/${base.branch}`);
    if (n) add('unpushed', `Local ${base.branch} has ${n} commit${n === 1 ? '' : 's'} that ${base.ref} does not; the plan will not include ${n === 1 ? 'it' : 'them'}. Push first, or start from ${base.branch} (--base ${base.branch}).`);
  }
  const current = tryGit(repo, ['branch', '--show-current']) || 'HEAD';
  const checkoutAhead = ahead(repo, base.commit, 'HEAD');
  if (checkoutAhead && current !== base.branch) {
    add('checkout', `Your checkout (${current}) has ${checkoutAhead} commit${checkoutAhead === 1 ? '' : 's'} not in ${base.ref} @ ${short}; the plan will not include ${checkoutAhead === 1 ? 'it' : 'them'} unless merged first.`);
  }
  if (tryGit(repo, ['status', '--porcelain', '--ignore-submodules=dirty'])) {
    add('uncommitted', 'Your checkout has uncommitted changes; the plan will not include them.');
  }
  // Recently active branches with work the base lacks (a local branch and its origin copy count once).
  const cutoff = Date.now() - recentDays * 86_400_000;
  const seen = new Set([current, base.branch]);
  for (const branch of listBranches(repo, { limit: 20 })) {
    const name = branch.ref.replace(/^origin\//, '');
    if (seen.has(name) || Date.parse(branch.date) < cutoff) continue;
    seen.add(name);
    const n = ahead(repo, base.commit, branch.commit);
    if (n) add('unmerged', `Branch ${name} has ${n} commit${n === 1 ? '' : 's'} not in ${base.ref} (last change ${branch.date.slice(0, 16).replace('T', ' ')}).`);
    if (warnings.filter(w => w.kind === 'unmerged').length >= 5) break;
  }
  return warnings;
}

// Check commands for a repository when none are given: those of the most recent plan or
// draft for it, otherwise the usual test command for its kind of project.
export function knownChecks(repo) {
  const target = real(repo);
  let latest = null;
  for (const id of listPlanIds()) {
    const dir = planDir(id);
    const draft = readDraft(dir);
    let plan = null;
    let at = null;
    try { const state = Store.inspect(dir); plan = state.plan; at = plan?.startedAt; } catch {}
    if (!plan && draft) { plan = draft.plan; at = draft.draftedAt; }
    if (!plan?.checks?.length || real(plan.repo) !== target) continue;
    if (!latest || String(at) > String(latest.at)) latest = { id, at, checks: plan.checks };
  }
  if (latest) return { source: `plan ${latest.id}`, commands: latest.checks };
  const detected = detectChecks(repo);
  return detected.length ? { source: 'detected', commands: detected } : { source: 'none', commands: [] };
}

export function detectChecks(dir) {
  const has = file => existsSync(join(dir, file));
  if (has('package.json')) {
    try {
      const test = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts?.test;
      if (test && !/no test specified/.test(test)) return ['npm test'];
    } catch {}
  }
  if (has('Cargo.toml')) return ['cargo test --offline'];
  if (has('go.mod')) return ['go test ./...'];
  if (has('Makefile') && /^test:/m.test(readFileSync(join(dir, 'Makefile'), 'utf8'))) return ['make test'];
  if (has('Package.swift')) return ['swift build'];
  if (has('pyproject.toml') || has('pytest.ini')) return ['python3 -m pytest -q'];
  return [];
}

// Runs the checks in a fresh detached worktree at the base commit (removed afterwards), the
// same way a plan's baseline will. Project checks are not sandboxed (as in plans).
// `ref` and `branch` name a draft's recorded start when `base` is its exact commit.
export async function checkReadiness(repo, { base, ref, branch, checks, checkSource = 'given', fetch = true, run = true, signal, onCheck } = {}) {
  const resolved = resolveBase(repo, { base, fetch });
  if (ref) Object.assign(resolved, { ref, branch: branch ?? resolved.branch });
  const warnings = gitWarnings(repo, resolved);
  const known = checks?.length ? { source: checkSource, commands: checks } : knownChecks(repo);
  const report = { repo, base: resolved, warnings, checks: { ...known, ran: false, passed: null, results: [] }, ready: null };
  if (!run || !known.commands.length) return report;
  const tag = createHash('sha256').update(repo).digest('hex').slice(0, 8);
  const dir = join(home(), 'checks', `${basename(repo).replace(/[^A-Za-z0-9._-]/g, '_')}-${tag}`);
  const remove = () => {
    tryGit(repo, ['worktree', 'remove', '--force', dir]);
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(home(), 'checks', 'check-tmp'), { recursive: true, force: true });
    tryGit(repo, ['worktree', 'prune']);
  };
  remove();
  mkdirSync(join(home(), 'checks'), { recursive: true });
  git(repo, ['worktree', 'add', '--detach', '--force', dir, resolved.commit]);
  try {
    const workspace = new Workspace({ repo, worktree: dir, checks: known.commands, limits: { checkMinutes: defaultLimits.checkMinutes } });
    const result = await workspace.runChecks({ signal, onCheck });
    Object.assign(report.checks, { ran: true, passed: result.passed, results: result.results });
    report.ready = result.passed;
  } finally {
    remove();
  }
  return report;
}
