import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, closeSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { Supervisor } from './supervisor.js';
import { Workspace } from './workspace.js';
import { validatePlan } from './plan.js';
import { planDir, listPlanIds } from './home.js';
import { collectRules } from './rules.js';
import { validateEffort } from './effort.js';
import { readConfig } from './home.js';

const cliFile = fileURLToPath(new URL('./cli.js', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Plan lifecycle shared by the CLI and the app: draft → start → (runner) → merge.

export function saveDraft(id, draft) {
  const dir = planDir(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'draft.json'), JSON.stringify(draft, null, 2) + '\n');
  return dir;
}

export function readDraft(dir) {
  const file = join(dir, 'draft.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

// Creates the plan's worktree and queues its tasks in order. The state directory must be new.
export function createPlan(definition, directory, { agents } = {}) {
  const store = new Store(directory);
  store.acquire();
  try {
    const state = store.read();
    if (state.plan || state.tasks.length) throw new Error('This state directory already has work; use a new state directory for each plan.');
    const workspace = Workspace.create(definition, directory);
    const supervisor = new Supervisor(store, null, null);
    // The rules as of the plan's base commit, fixed for the whole plan.
    const rules = collectRules(workspace.repo, { root: workspace.worktree });
    const effort = validateEffort({ ...readConfig().effort, ...definition.effort });
    supervisor.state.plan = { ...definition, ...(agents ? { agents } : {}), rules, effort, repo: workspace.repo, worktree: workspace.worktree,
      branch: workspace.branch, baseCommit: workspace.baseCommit, status: 'running', startedAt: new Date().toISOString() };
    supervisor.record(null, 'plan-started', `${definition.tasks.length} tasks on ${workspace.branch} from ${workspace.baseCommit.slice(0, 12)}`);
    definition.tasks.forEach((task, index) => supervisor.add({ ...task, maxAttempts: definition.limits.attemptsPerTask,
      dependencies: index ? [definition.tasks[index - 1].id] : [] }));
    return supervisor.snapshot().plan;
  } finally { store.release(); }
}

// Approving a draft creates the plan; starting runs `serve` detached, logging to serve.log.
// The runner survives the terminal closing; it does not survive a reboot (see docs/SERVICE.md).
export async function startPlan(id, { agents } = {}) {
  const dir = planDir(id);
  let state = Store.inspect(dir);
  if (!state.plan) {
    const draft = readDraft(dir);
    if (!draft) throw new Error(`No plan or draft named ${id}.`);
    createPlan(validatePlan(draft.plan, draft.plan.repo, `draft ${id}`), dir, { agents: agents ?? draft.agents });
    state = Store.inspect(dir);
  }
  if (state.runner?.alive) return { id, dir, pid: state.runner.pid, already: true };
  const spec = agents ?? state.plan.agents;
  if (!spec) throw new Error('No agents recorded for this plan; pass --agents.');
  const log = openSync(join(dir, 'serve.log'), 'a');
  const child = spawn(process.execPath, [cliFile, 'serve', '--agents', spec, '--state', dir, '--poll-seconds', '5'],
    { detached: true, stdio: ['ignore', log, log], env: process.env });
  child.unref();
  closeSync(log);
  // Wait until it holds the lease, or report why it exited.
  const exited = new Promise(done => child.once('exit', code => done(code)));
  for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
    const code = await Promise.race([exited, new Promise(done => setTimeout(() => done(undefined), 250))]);
    if (code !== undefined) throw new Error(`The runner stopped at once (exit ${code}): ${tailLog(dir)}`);
    if (Store.inspect(dir).runner?.alive) return { id, dir, pid: child.pid, already: false };
  }
  throw new Error(`The runner did not start within 30 seconds: ${tailLog(dir)}`);
}

export function tailLog(dir, lines = 5) {
  try { return readFileSync(join(dir, 'serve.log'), 'utf8').trim().split('\n').slice(-lines).join(' | '); }
  catch { return '(no log)'; }
}

// Stops the runner after its current step (SIGTERM), waiting up to `waitMs`.
export async function stopRunner(id, { waitMs = 15_000 } = {}) {
  const dir = planDir(id);
  const runner = Store.inspect(dir).runner;
  if (!runner?.alive) return false;
  process.kill(runner.pid, 'SIGTERM');
  for (const deadline = Date.now() + waitMs; Date.now() < deadline; await new Promise(done => setTimeout(done, 250))) {
    if (!Store.inspect(dir).runner?.alive) return true;
  }
  throw new Error(`The runner (pid ${runner.pid}) is still finishing its current step; try again shortly, or interrupt it first.`);
}

// The owner's approval: merge the plan branch into the repository's current branch.
// Refuses on a dirty checkout, a detached HEAD, or a conflict (which it aborts).
export async function mergePlan(id) {
  const dir = planDir(id);
  const before = Store.inspect(dir).plan;
  if (!before) throw new Error(`No plan named ${id}.`);
  if (before.status !== 'awaiting-approval') throw new Error(`Plan ${id} is ${before.status}; only a plan awaiting approval can be merged.`);
  await stopRunner(id);
  const { repo, branch, worktree } = before;
  const target = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (target === 'HEAD') throw new Error(`${repo} has a detached HEAD; check out the branch to merge into first.`);
  if (git(repo, 'status', '--porcelain')) throw new Error(`${repo} has uncommitted changes; commit or stash them before merging.`);
  try { git(repo, 'merge', '--no-ff', '-m', `Merge Nightshift plan ${id}`, branch); }
  catch (error) {
    try { git(repo, 'merge', '--abort'); } catch {}
    throw new Error(`Merging ${branch} into ${target} conflicted; nothing was changed. Merge it by hand. (${error.stderr?.trim() ?? error.message})`);
  }
  const merged = git(repo, 'rev-parse', 'HEAD');
  try { git(repo, 'worktree', 'remove', worktree); } catch {}
  const store = new Store(dir);
  store.acquire();
  try {
    const supervisor = new Supervisor(store, null, null);
    supervisor.state.plan.status = 'merged';
    supervisor.state.plan.mergedAt = new Date().toISOString();
    supervisor.state.plan.mergeCommit = merged;
    supervisor.record(null, 'plan-merged', `Merged ${branch} into ${target} as ${merged.slice(0, 12)}; branch kept.`);
    store.save(supervisor.state);
  } finally { store.release(); }
  return { target, merged, branch };
}

// Removes an unmerged plan: a draft's directory, or a started plan's worktree, branch, and
// directory. Without `confirm` it only describes what it would remove.
export function discardPlan(id, { confirm = false } = {}) {
  const dir = planDir(id);
  const state = Store.inspect(dir);
  const plan = state.plan;
  if (!plan && !readDraft(dir)) throw new Error(`No plan or draft named ${id}.`);
  if (state.runner?.alive) throw new Error(`Plan ${id} has a running runner (pid ${state.runner.pid}); stop it first with \`stop ${id}\`.`);
  if (plan?.status === 'merged') throw new Error(`Plan ${id} is merged; it cannot be discarded.`);
  const removes = plan ? [`worktree ${plan.worktree}`, `branch ${plan.branch} in ${plan.repo}`, `directory ${dir}`] : [`draft directory ${dir}`];
  if (!confirm) return { removed: false, removes };
  if (plan) {
    if (existsSync(plan.worktree)) git(plan.repo, 'worktree', 'remove', '--force', plan.worktree);
    else git(plan.repo, 'worktree', 'prune');
    let branchExists = true;
    try { git(plan.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${plan.branch}`); } catch { branchExists = false; }
    if (branchExists) git(plan.repo, 'branch', '-D', plan.branch);
  }
  rmSync(dir, { recursive: true, force: true });
  return { removed: true, removes };
}

// One line per plan for the CLI list and the app.
export function summarize(id) {
  const dir = planDir(id);
  const state = Store.inspect(dir);
  const draft = readDraft(dir);
  const plan = state.plan;
  if (!plan) {
    return draft ? { id, dir, status: 'draft', repo: draft.plan.repo, brief: draft.plan.brief, notes: draft.notes, rules: draft.rules ?? [],
      agents: draft.agents, source: draft.source, tasks: draft.plan.tasks.map(t => ({ ...t, status: 'draft' })), runner: false } : null;
  }
  const dispatches = state.events.filter(e => e.type === 'dispatched').length;
  const tokens = state.events.filter(e => e.type === 'provider:usage')
    .reduce((sum, e) => sum + (Number(e.detail?.tokens?.input) || 0) + (Number(e.detail?.tokens?.output) || 0), 0);
  const hours = ((plan.finishedAt ? Date.parse(plan.finishedAt) : Date.now()) - Date.parse(plan.startedAt)) / 3_600_000;
  const current = state.tasks.find(t => ['running', 'review'].includes(t.status));
  const blocked = state.tasks.find(t => t.status === 'blocked');
  const last = state.events.at(-1);
  return {
    id, dir, status: plan.status, paused: state.paused, runner: Boolean(state.runner?.alive),
    repo: plan.repo, branch: plan.branch, worktree: plan.worktree, agents: plan.agents ?? state.project?.pairing ?? null,
    brief: plan.brief, startedAt: plan.startedAt, finishedAt: plan.finishedAt ?? null,
    blocker: plan.reason ?? blocked?.reason ?? null, current: current ? { id: current.id, title: current.title, status: current.status } : null,
    finalReview: plan.final?.review?.reason ?? null,
    rules: (plan.rules ?? []).map(r => [r.path, ...(r.also ?? [])].join(' = ')),
    tasks: state.tasks.map(t => ({ id: t.id, title: t.title, status: t.status, attempts: t.attempts, commit: t.commit ?? null, reason: t.reason ?? null,
      skipped: t.skipped === true, difficulty: t.difficulty ?? null, difficultyReason: plan.tasks?.find(p => p.id === t.id)?.difficultyReason ?? null, effort: t.effort ?? null })),
    effort: plan.effort ?? null,
    limits: { dispatches: [dispatches, plan.limits.dispatches], tokens: [tokens, plan.limits.tokens], hours: [Number(hours.toFixed(2)), plan.limits.hours] },
    lastEvent: last ? { at: last.at, type: last.type } : null,
    log: tailLog(dir, 3)
  };
}

export const listPlans = () => listPlanIds().map(summarize).filter(Boolean);

// The owner's difficulty rating for one task: edits a draft directly, or queues the change
// for a started plan (it applies from the task's next attempt).
export function setTaskDifficulty(id, taskId, level) {
  if (!['low', 'medium', 'high'].includes(level)) throw new Error('Difficulty must be low, medium, or high.');
  const dir = planDir(id);
  if (Store.inspect(dir).plan) {
    Store.enqueue(dir, 'difficulty', { id: taskId, level });
    return 'queued';
  }
  const draft = readDraft(dir);
  if (!draft) throw new Error(`No plan or draft named ${id}.`);
  const task = draft.plan.tasks.find(t => t.id === taskId);
  if (!task) throw new Error(`No task ${taskId} in draft ${id}.`);
  task.difficulty = level;
  task.difficultyReason = `Set by the owner (was: ${task.difficultyReason ?? 'not rated'}).`;
  saveDraft(id, draft);
  return 'updated';
}
