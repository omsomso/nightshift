import { readFileSync } from 'node:fs';
import { difficulties, validateEffort } from './effort.js';
import { resolve, dirname } from 'node:path';

// Defaults from docs/EDIT_MODE.md. A plan file may lower or raise any of them.
export const defaultLimits = {
  attemptsPerTask: 3,
  turnMinutes: 20,
  dispatches: null, // null: 3 × tasks + 2
  tokens: 5_000_000, // input (including cached) + output, all turns of the plan
  hours: 6,
  changedLinesPerTask: 800,
  checkMinutes: 10,
  fixupRounds: 1 // fix-up tasks Nightshift may add after a failed final review or final checks; 0 disables
};

// No task may change these, whatever the plan's allowed paths say.
export const protectedPaths = ['.git', '.github/', '.claude/', '.codex/', '.nightshift/', 'AGENTS.md', 'CLAUDE.md'];

// Checks run in the plan's worktree and must never change its history.
const historyCommand = /\bgit\s+(push|commit|reset|rebase)\b/;

const idPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

// An owner-approved plan: a brief, ordered tasks, the checks Nightshift runs, and limits.
export function loadPlan(file) {
  const path = resolve(file);
  return validatePlan(JSON.parse(readFileSync(path, 'utf8')), dirname(path), file);
}

// `repo` resolves against baseDir. Returns a normalized plan or throws with the reason.
export function validatePlan(plan, baseDir, label = 'plan') {
  const fail = message => { throw new Error(`Invalid plan ${label}: ${message}`); };
  if (!idPattern.test(plan.id ?? '')) fail('id must be lowercase letters, digits, and dashes.');
  if (typeof plan.repo !== 'string' || !plan.repo) fail('repo is required.');
  if (typeof plan.brief !== 'string' || !plan.brief.trim()) fail('brief is required.');
  if (!Array.isArray(plan.checks) || !plan.checks.length || plan.checks.some(c => typeof c !== 'string' || !c.trim())) {
    fail('checks must list at least one command; Nightshift runs them itself after every task.');
  }
  const historyCheck = plan.checks.find(c => historyCommand.test(c));
  if (historyCheck) fail(`check "${historyCheck}" changes Git history (git push, commit, reset, or rebase); checks must only inspect.`);
  if (!Array.isArray(plan.tasks) || !plan.tasks.length) fail('tasks must list at least one task.');
  const ids = new Set();
  for (const task of plan.tasks) {
    if (!idPattern.test(task.id ?? '')) fail('every task needs an id of lowercase letters, digits, and dashes.');
    if (ids.has(task.id)) fail(`duplicate task id ${task.id}.`);
    ids.add(task.id);
    if (!task.title?.trim() || !task.acceptance?.trim()) fail(`task ${task.id} needs a title and acceptance criteria.`);
    if (task.difficulty !== undefined && !difficulties.includes(task.difficulty)) fail(`task ${task.id} difficulty must be low, medium, or high.`);
  }
  const allowedPaths = plan.allowedPaths ?? [''];
  if (!Array.isArray(allowedPaths) || allowedPaths.some(p => typeof p !== 'string' || p.startsWith('/') || p.includes('..'))) {
    fail('allowedPaths must be repository-relative prefixes.');
  }
  const unknown = Object.keys(plan.limits ?? {}).filter(key => !(key in defaultLimits));
  if (unknown.length) fail(`unknown limits: ${unknown.join(', ')}.`);
  const limits = { ...defaultLimits, ...plan.limits };
  limits.dispatches ??= 3 * plan.tasks.length + 2;
  for (const [key, value] of Object.entries(limits)) {
    if (!(Number(value) > 0) && !(key === 'fixupRounds' && Number(value) === 0)) fail(`limit ${key} must be a positive number.`);
  }
  return {
    id: plan.id, repo: resolve(baseDir, plan.repo), base: plan.base ?? 'HEAD', brief: plan.brief.trim(),
    checks: plan.checks, allowedPaths, limits,
    ...(plan.effort ? { effort: (() => { try { return validateEffort(plan.effort); } catch (error) { return fail(error.message); } })() } : {}),
    tasks: plan.tasks.map(task => ({ id: task.id, title: task.title.trim(), acceptance: task.acceptance.trim(),
      ...(task.difficulty ? { difficulty: task.difficulty, ...(task.difficultyReason ? { difficultyReason: String(task.difficultyReason).trim() } : {}) } : {}) }))
  };
}
