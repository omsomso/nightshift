import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, closeSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { Supervisor } from './supervisor.js';
import { Workspace, scratchDir } from './workspace.js';
import { validatePlan } from './plan.js';
import { planDir, listPlanIds } from './home.js';
import { collectRules } from './rules.js';
import { resolveBase } from './base.js';
import { validateEffort } from './effort.js';
import { readConfig } from './home.js';
import { advanceQueue, readQueue } from './queue.js';
import { planTokens } from './tokens.js';

const cliFile = fileURLToPath(new URL('./cli.js', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (cwd, ...args) => { try { return git(cwd, ...args); } catch { return null; } };

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
  const resolved = resolveBase(definition.repo, { base: definition.base, fetch: !definition.base || definition.base.startsWith('origin/') });
  definition = { ...definition, base: resolved.commit, baseRef: definition.baseRef ?? resolved.ref, baseBranch: definition.baseBranch ?? resolved.branch };
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
  // Remembered so autostart can bring the runner back after a restart; an explicit stop clears it.
  writeFileSync(join(dir, 'runner-wanted'), new Date().toISOString() + '\n');
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
  rmSync(join(dir, 'runner-wanted'), { force: true });
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
export async function mergePlan(id, { style = readConfig().mergeStyle ?? 'local' } = {}) {
  const dir = planDir(id);
  const before = Store.inspect(dir).plan;
  if (!before) throw new Error(`No plan named ${id}.`);
  if (before.status !== 'awaiting-approval') throw new Error(`Plan ${id} is ${before.status}; only a plan awaiting approval can be merged.`);
  if (style === 'pr') return openPullRequest(id);
  await stopRunner(id);
  const { repo, branch, worktree } = before;
  // Merge into the branch the plan started from (for example main), wherever it is checked
  // out; if it is not checked out anywhere, use a temporary worktree. Older plans without a
  // recorded base branch merge into the repository's current branch.
  const target = before.baseBranch ?? git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (target === 'HEAD') throw new Error(`${repo} has a detached HEAD; check out the branch to merge into first.`);
  const exists = ref => { try { git(repo, 'rev-parse', '--verify', '--quiet', ref); return true; } catch { return false; } };
  if (!exists(`refs/heads/${target}`)) git(repo, 'branch', target, before.baseRef ?? before.baseCommit);
  const checkedOut = git(repo, 'worktree', 'list', '--porcelain').split('\n\n')
    .map(block => ({ path: /^worktree (.+)$/m.exec(block)?.[1], branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] }))
    .find(entry => entry.branch === target);
  const temporary = checkedOut ? null : join(planDir(id), 'merge');
  const where = checkedOut?.path ?? temporary;
  if (temporary) { rmSync(temporary, { recursive: true, force: true }); git(repo, 'worktree', 'add', '-q', temporary, target); }
  let merged;
  try {
    if (git(where, 'status', '--porcelain', '--ignore-submodules=dirty')) throw new Error(`${where} (where ${target} is checked out) has uncommitted changes; commit or stash them before merging.`);
    try { git(where, 'merge', '--no-ff', '-m', `Merge Nightshift plan ${id}`, branch); }
    catch (error) {
      try { git(where, 'merge', '--abort'); } catch {}
      throw new Error(`Merging ${branch} into ${target} conflicted; nothing was changed. Merge it by hand. (${error.stderr?.trim() ?? error.message})`);
    }
    merged = git(where, 'rev-parse', 'HEAD');
  } finally {
    if (temporary) { try { git(repo, 'worktree', 'remove', '--force', temporary); } catch {} }
  }
  rmSync(join(worktree, scratchDir), { recursive: true, force: true });
  try { git(repo, 'worktree', 'remove', worktree); } catch {}
  const store = new Store(dir);
  store.acquire();
  try {
    const supervisor = new Supervisor(store, null, null);
    supervisor.state.plan.status = 'merged';
    supervisor.state.plan.mergedAt = new Date().toISOString();
    supervisor.state.plan.mergeCommit = merged;
    supervisor.record(null, 'plan-merged', `Merged ${branch} into ${target} as ${merged.slice(0, 12)}; branch kept; nothing pushed.`);
    store.save(supervisor.state);
  } finally { store.release(); }
  return { target, merged, branch };
}

// The other way to approve: push the plan branch and open a pull request into the branch the
// plan started from, for projects that merge through GitHub. Uses the GitHub CLI (`gh`) as
// the owner is signed in to it. The approval in the app or the explicit command is the
// owner's consent to push this one branch.
export async function openPullRequest(id) {
  const dir = planDir(id);
  const state = Store.inspect(dir);
  const plan = state.plan;
  if (plan?.status !== 'awaiting-approval') throw new Error(`Plan ${id} is ${plan?.status ?? 'missing'}; only a plan awaiting approval can become a pull request.`);
  const gh = process.env.NIGHTSHIFT_GH_BIN ?? 'gh';
  if (tryGit(plan.repo, 'remote', 'get-url', 'origin') === null) throw new Error(`${plan.repo} has no origin remote to open a pull request on.`);
  try { execFileSync(gh, ['auth', 'status'], { cwd: plan.repo, stdio: 'ignore' }); }
  catch { throw new Error('The GitHub CLI (gh) is not installed or not signed in. Install it and run `gh auth login`, or merge locally instead.'); }
  await stopRunner(id);
  const base = plan.baseBranch ?? 'main';
  git(plan.repo, 'push', '-u', 'origin', `${plan.branch}:${plan.branch}`);
  const tasks = state.tasks.map((t, i) => `${i + 1}. ${t.title}${t.skipped ? ' (skipped)' : t.commit ? ` (${t.commit.slice(0, 8)})` : ''}`).join('\n');
  const title = plan.brief.split(/(?<=\.)\s/)[0].slice(0, 100);
  const body = `${plan.brief}\n\n## Tasks\n${tasks}\n\n## Checks\n${plan.checks.map(c => `- \`${c}\``).join('\n')}\n\n` +
    `${plan.final?.review?.reason ? `## Final review\n${plan.final.review.reason}\n\n` : ''}Opened by Nightshift (plan \`${id}\`) after the owner approved it.`;
  const output = execFileSync(gh, ['pr', 'create', '--base', base, '--head', plan.branch, '--title', title, '--body', body],
    { cwd: plan.repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const url = output.trim().split('\n').filter(line => /^https?:\/\//.test(line)).at(-1) ?? output.trim();
  rmSync(join(plan.worktree, scratchDir), { recursive: true, force: true });
  try { git(plan.repo, 'worktree', 'remove', plan.worktree); } catch {}
  const store = new Store(dir);
  store.acquire();
  try {
    const supervisor = new Supervisor(store, null, null);
    supervisor.state.plan.status = 'pr-open';
    supervisor.state.plan.pullRequest = url;
    supervisor.record(null, 'pull-request-opened', `Pushed ${plan.branch} and opened ${url} into ${base}.`);
    store.save(supervisor.state);
  } finally { store.release(); }
  return { url, base, branch: plan.branch };
}

// Removes a plan: a draft's directory, or a started plan's worktree, branch, and record.
// Commits that exist on no other branch (local or remote) are named as lost; work already
// merged or pushed elsewhere is not. Each step is tried on its own, so a missing worktree or
// branch never leaves a half-deleted plan behind. Without `confirm` it only describes it.
export function discardPlan(id, { confirm = false } = {}) {
  const dir = planDir(id);
  const state = Store.inspect(dir);
  const plan = state.plan;
  if (!plan && !readDraft(dir)) throw new Error(`No plan or draft named ${id}.`);
  if (state.runner?.alive) throw new Error(`Plan ${id} has a running runner (pid ${state.runner.pid}); stop it first with \`stop ${id}\`.`);
  if (!plan) {
    const removes = [`draft directory ${dir}`];
    if (confirm) rmSync(dir, { recursive: true, force: true });
    return { removed: confirm, removes, problems: [] };
  }
  const branchExists = tryGit(plan.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${plan.branch}`) !== null;
  const unmerged = branchExists ? Number(tryGit(plan.repo, 'rev-list', '--count', plan.branch, '--not',
    `--exclude=${plan.branch}`, '--branches', `--exclude=origin/${plan.branch}`, '--remotes') ?? 0) : 0;
  const pushed = branchExists && tryGit(plan.repo, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${plan.branch}`) !== null;
  const removes = [
    ...(existsSync(plan.worktree) ? [`worktree ${plan.worktree}`] : []),
    ...(branchExists ? [`branch ${plan.branch} in ${plan.repo}${unmerged
      ? ` (${unmerged} commit${unmerged === 1 ? '' : 's'} on no other branch; ${unmerged === 1 ? 'it is' : 'they are'} lost)`
      : ' (its work is merged or kept elsewhere)'}`] : []),
    `plan record ${dir}`,
    ...(pushed || plan.status === 'pr-open' ? ['(the pull request and the remote branch stay on GitHub)'] : [])];
  if (!confirm) return { removed: false, removes, unmerged, problems: [] };
  const problems = [];
  const step = (label, work) => { try { work(); } catch (error) { problems.push(`${label}: ${String(error.stderr || error.message).trim().split('\n')[0]}`); } };
  step('worktree', () => {
    if (existsSync(plan.worktree)) git(plan.repo, 'worktree', 'remove', '--force', plan.worktree);
    else git(plan.repo, 'worktree', 'prune');
  });
  if (branchExists) step('branch', () => git(plan.repo, 'branch', '-D', plan.branch));
  rmSync(dir, { recursive: true, force: true });
  return { removed: true, removes, problems };
}

// A plan approved outside Nightshift (merged on GitHub, or by hand) is marked merged, so it
// moves to the archive. Locally: the plan branch's commits are in the starting branch (or
// its origin copy). With `network`: origin is fetched first, and an open pull request is
// asked about with gh, which also catches squash merges.
export async function syncMerges({ network = false } = {}) {
  const marked = [];
  for (const id of listPlanIds()) {
    let state;
    try { state = Store.inspect(planDir(id)); } catch { continue; }
    const plan = state.plan;
    if (!plan || !['awaiting-approval', 'pr-open'].includes(plan.status)) continue;
    const found = mergedElsewhere(plan, state, { network });
    if (!found) continue;
    try { if (await markMerged(id, found)) marked.push({ id, ...found }); }
    catch (error) { console.error(`${id}: merged elsewhere, but could not be marked: ${error.message}`); }
  }
  return marked;
}

function mergedElsewhere(plan, state, { network }) {
  const base = plan.baseBranch ?? 'main';
  const hasOrigin = tryGit(plan.repo, 'remote', 'get-url', 'origin') !== null;
  if (network && hasOrigin) tryGit(plan.repo, 'fetch', '--quiet', 'origin', base);
  const tip = tryGit(plan.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${plan.branch}`) ?? state.tasks.findLast(t => t.commit)?.commit;
  if (tip && tip !== plan.baseCommit) {
    for (const ref of [`refs/heads/${base}`, `refs/remotes/origin/${base}`]) {
      if (tryGit(plan.repo, 'rev-parse', '--verify', '--quiet', ref) === null) continue;
      if (tryGit(plan.repo, 'merge-base', '--is-ancestor', tip, ref) !== null) return { how: `its commits are in ${ref.replace(/^refs\/(heads|remotes)\//, '')}` };
    }
  }
  if (network && plan.status === 'pr-open' && plan.pullRequest) {
    try {
      const pr = JSON.parse(execFileSync(process.env.NIGHTSHIFT_GH_BIN ?? 'gh', ['pr', 'view', plan.pullRequest, '--json', 'state,mergedAt'],
        { cwd: plan.repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 }));
      if (pr.state === 'MERGED') return { how: 'its pull request was merged on GitHub', at: pr.mergedAt };
    } catch {}
  }
  return null;
}

async function markMerged(id, found) {
  const dir = planDir(id);
  try { await stopRunner(id, { waitMs: 5000 }); } catch { return false; } // still busy; next time
  const plan = Store.inspect(dir).plan;
  rmSync(join(plan.worktree, scratchDir), { recursive: true, force: true });
  tryGit(plan.repo, 'worktree', 'remove', plan.worktree); // only if clean; otherwise it stays
  const store = new Store(dir);
  store.acquire();
  try {
    const supervisor = new Supervisor(store, null, null);
    // mergedAt only when GitHub says when; noticedAt is when Nightshift saw it.
    Object.assign(supervisor.state.plan, { status: 'merged', ...(found.at ? { mergedAt: found.at } : {}), noticedAt: new Date().toISOString(), mergedOutside: found.how });
    supervisor.record(null, 'merge-detected', `Merged outside Nightshift: ${found.how}.`);
    store.save(supervisor.state);
  } finally { store.release(); }
  return true;
}

// The model each role last ran on, as the provider reported it.
function modelsUsed(state) {
  const models = {};
  for (const e of state.events) if (e.type === 'provider:turn-started' && e.detail?.model) models[e.detail.role ?? 'worker'] = e.detail.model;
  return Object.keys(models).length ? models : null;
}

// Why a plan is paused, in words: the last event that paused it.
function pauseReason(state) {
  if (!state.paused) return null;
  const event = [...state.events].reverse().find(e => ['paused', 'plan-limit', 'dispatch-cap-reached', 'usage-limit', 'billing-guard', 'interrupted', 'plan-blocked'].includes(e.type));
  if (!event) return null;
  const text = typeof event.detail === 'string' ? event.detail.replace(/\.?\s*Applies before the next dispatch\.$/, '') : event.type;
  return { at: event.at, type: event.type, text: text || 'Paused' };
}

const queuePosition = id => { const at = readQueue().indexOf(id); return at < 0 ? null : at + 1; };

// One line per plan for the CLI list and the app.
export function summarize(id) {
  const dir = planDir(id);
  const state = Store.inspect(dir);
  const draft = readDraft(dir);
  const plan = state.plan;
  if (!plan) {
    return draft ? { id, dir, status: 'draft', repo: draft.plan.repo, brief: draft.plan.brief, notes: draft.notes, rules: draft.rules ?? [],
      baseRef: draft.plan.baseRef ?? null, baseCommit: draft.plan.base ?? null, baseBranch: draft.plan.baseBranch ?? null,
      baseSubject: draft.baseInfo?.subject ?? null, baseDate: draft.baseInfo?.date ?? null, warnings: (draft.warnings ?? []).map(w => w.message),
      queued: queuePosition(id), agents: draft.agents, source: draft.source, limitSettings: draft.plan.limits, tasks: draft.plan.tasks.map(t => ({ ...t, status: 'draft' })), runner: false } : null;
  }
  const dispatches = state.events.filter(e => e.type === 'dispatched').length;
  const tokens = planTokens(state.events);
  const hours = ((plan.finishedAt ? Date.parse(plan.finishedAt) : Date.now()) - Date.parse(plan.startedAt)) / 3_600_000;
  const current = state.tasks.find(t => ['running', 'review'].includes(t.status));
  const blocked = state.tasks.find(t => t.status === 'blocked');
  const last = state.events.at(-1);
  return {
    id, dir, status: plan.status, paused: state.paused, runner: Boolean(state.runner?.alive), waitUntil: state.waitUntil ?? null,
    queued: queuePosition(id), runnerWanted: existsSync(join(dir, 'runner-wanted')),
    repo: plan.repo, branch: plan.branch, worktree: plan.worktree, agents: plan.agents ?? state.project?.pairing ?? null,
    baseRef: plan.baseRef ?? null, baseCommit: plan.baseCommit ?? null, baseBranch: plan.baseBranch ?? null,
    brief: plan.brief, startedAt: plan.startedAt, finishedAt: plan.finishedAt ?? null,
    blocker: plan.reason ?? blocked?.reason ?? null, current: current ? { id: current.id, title: current.title, status: current.status } : null,
    finalReview: plan.final?.review?.reason ?? null, pullRequest: plan.pullRequest ?? null,
    mergedAt: plan.mergedAt ?? null, noticedAt: plan.noticedAt ?? null, mergedOutside: plan.mergedOutside ?? null, limitSettings: plan.limits,
    pauseReason: pauseReason(state), models: modelsUsed(state),
    rules: (plan.rules ?? []).map(r => [r.path, ...(r.also ?? [])].join(' = ')),
    tasks: state.tasks.map(t => ({ id: t.id, title: t.title, status: t.status, attempts: t.attempts, commit: t.commit ?? null, reason: t.reason ?? null,
      skipped: t.skipped === true, ownerFixed: t.ownerFixed === true, difficulty: t.difficulty ?? null, difficultyReason: plan.tasks?.find(p => p.id === t.id)?.difficultyReason ?? null, effort: t.effort ?? null })),
    effort: plan.effort ?? null,
    limits: { dispatches: [dispatches, plan.limits.dispatches], tokens: [tokens, plan.limits.tokens], hours: [Number(hours.toFixed(2)), plan.limits.hours] },
    lastEvent: last ? { at: last.at, type: last.type } : null,
    log: tailLog(dir, 3)
  };
}

export const listPlans = () => listPlanIds().map(summarize).filter(Boolean);

// At login (autostart) or on request: bring back every runner that was on and not stopped by
// the owner, then start the queue if nothing is working.
export async function resumeRunners() {
  const started = [];
  for (const id of listPlanIds()) {
    const dir = planDir(id);
    if (!existsSync(join(dir, 'runner-wanted'))) continue;
    const state = Store.inspect(dir);
    if (!state.plan || state.runner?.alive || ['merged', 'awaiting-approval'].includes(state.plan.status)) continue;
    try { await startPlan(id); started.push(id); }
    catch (error) { console.error(`${id}: ${error.message}`); }
  }
  const next = await advanceQueue(startPlan);
  if (next) started.push(next);
  return started;
}

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

// The owner's edits to a draft before approving it: brief, checks, allowed paths, and the
// task list (reworded, reordered, removed, or added). Validated like any plan; new tasks
// without an id get one from their title.
export function editDraft(id, changes) {
  const dir = planDir(id);
  const draft = readDraft(dir);
  if (!draft) throw new Error(`${id} is not a draft; only drafts can be edited (a started plan takes new tasks with \`add\`).`);
  const taken = new Set();
  const slug = text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';
  const tasks = (changes.tasks ?? draft.plan.tasks).map(task => {
    let taskId = task.id || slug(task.title);
    for (let n = 2; taken.has(taskId); n += 1) taskId = `${slug(task.title)}-${n}`;
    taken.add(taskId);
    return { ...task, id: taskId };
  });
  const edited = { ...draft.plan, ...(changes.brief !== undefined ? { brief: changes.brief } : {}),
    ...(changes.checks ? { checks: changes.checks.map(c => String(c).trim()).filter(Boolean) } : {}),
    ...(changes.allowedPaths ? { allowedPaths: changes.allowedPaths.map(p => String(p).trim()) } : {}), tasks };
  if (changes.limits) edited.limits = { ...draft.plan.limits, ...changes.limits };
  else if (changes.tasks) edited.limits = { ...draft.plan.limits, dispatches: undefined }; // recomputed for the new task count
  const plan = validatePlan(edited, edited.repo, `draft ${id}`);
  saveDraft(id, { ...draft, plan, editedAt: new Date().toISOString() });
  return plan;
}

// A prompt for an interactive Claude session that helps the owner fix what blocked a plan.
export function fixPrompt(id) {
  const dir = planDir(id);
  const state = Store.inspect(dir);
  const plan = state.plan;
  if (!plan) throw new Error(`${id} has not started; nothing to fix yet.`);
  const task = state.tasks.find(t => t.status === 'blocked');
  const checks = [...state.events].reverse().find(e => ['checks', 'baseline-checks', 'final-checks'].includes(e.type))?.detail;
  const failing = (checks?.results ?? []).filter(r => r.exitCode !== 0).map(r => `$ ${r.command} -> exit ${r.exitCode}\n${r.output.slice(-3000)}`).join('\n\n');
  const planLevel = !task;
  const lines = [
    `Nightshift plan "${id}" is stopped and needs the owner. Help them fix it.`,
    '', `Plan: ${plan.brief}`, `Repository: ${plan.repo}`, `Plan branch: ${plan.branch} (worktree: ${plan.worktree})`,
    `Allowed paths: ${plan.allowedPaths.map(p => p || '(whole repository)').join(', ')}`, `Checks: ${plan.checks.join('; ')}`, '',
    task ? `Blocked task "${task.id}": ${task.title}\nDone when: ${task.acceptance}\nWhy it stopped: ${task.reason}`
      : `Why the plan stopped: ${plan.reason ?? state.events.filter(e => e.type === 'plan-blocked').at(-1)?.detail ?? 'see nightshift report'}`,
    ...(failing ? ['', 'Failing check output:', failing] : []), '',
    'How to work:',
    planLevel && plan.baseline && !plan.baseline.passed
      ? `- The checks already fail where the plan starts (${plan.baseRef ?? plan.baseCommit}). That needs fixing in the project itself, on ${plan.baseBranch ?? 'its main branch'}, not in this worktree. Fix it there with the owner (their usual rules for commits and pushes apply), then they retry the plan in Nightshift.`
      : `- You are in the plan's worktree on branch ${plan.branch}. Make the fix here, run the checks above, and explain what you changed.`,
    '- Do not commit, push, switch branches, or rewrite history: Nightshift commits the result itself.',
    task ? `- When the fix is ready, the owner presses "Accept Fix" in Nightshift (or runs: nightshift accept ${task.id} --plan ${id}). Nightshift runs the checks and, if they pass, commits it as this task and continues.`
      : '- When it is fixed, the owner presses Retry in Nightshift.',
  ];
  return { id, cwd: planLevel && plan.baseline && !plan.baseline.passed ? plan.repo : plan.worktree, task: task?.id ?? null, prompt: lines.join('\n') };
}
