import { execFileSync } from 'node:child_process';
import { planDir, listPlanIds } from './home.js';
import { Store } from './store.js';
import { readDraft } from './plans.js';

// Read-only views over a plan's record for the owner: the review before merging, what the
// agents are doing right now, and how much has been used.
const git = (cwd, args) => { try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };
const diffChars = 150_000;
const cut = (text, limit) => text.length > limit ? `${text.slice(0, limit)}\n[…diff truncated: ${text.length - limit} more characters; see the branch]` : text;
const checkSummary = detail => detail ? { passed: detail.passed, results: (detail.results ?? []).map(r => ({ command: r.command, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, output: r.exitCode === 0 ? '' : r.output })) } : null;

// Everything needed to judge a plan before approving it: per task the diff, the reviewer's
// verdict, and the checks; for the whole plan the combined diff, final checks, and review.
export function reviewData(id) {
  const state = Store.inspect(planDir(id));
  const plan = state.plan;
  if (!plan) throw new Error(`${id} has not started; there is nothing to review yet.`);
  const lastFor = (taskId, type) => [...state.events].reverse().find(e => e.taskId === taskId && e.type === type)?.detail;
  const tasks = state.tasks.map(task => ({
    id: task.id, title: task.title, acceptance: task.acceptance, status: task.status, attempts: task.attempts ?? 0,
    commit: task.commit ?? null, skipped: task.skipped === true, ownerFixed: task.ownerFixed === true,
    review: task.review ? { passed: task.review.passed, reason: task.review.reason } : null,
    summary: task.result?.summary ?? null,
    checks: checkSummary(lastFor(task.id, 'checks')),
    stat: task.commit ? git(plan.repo, ['show', '--stat', '--format=', task.commit]).trim() : '',
    diff: task.commit ? cut(git(plan.repo, ['show', '--format=', '--no-renames', task.commit]), diffChars) : ''
  }));
  const head = git(plan.repo, ['rev-parse', '--verify', '--quiet', plan.branch]).trim() || tasks.findLast(t => t.commit)?.commit;
  const final = head ? {
    stat: git(plan.repo, ['diff', '--shortstat', plan.baseCommit, head]).trim(),
    files: git(plan.repo, ['diff', '--stat', plan.baseCommit, head]).trim(),
    diff: cut(git(plan.repo, ['diff', '--no-renames', plan.baseCommit, head]), diffChars * 2),
    checks: checkSummary([...state.events].reverse().find(e => e.type === 'final-checks')?.detail),
    review: plan.final?.review ? { passed: plan.final.review.passed, reason: plan.final.review.reason } : null
  } : null;
  return { id, status: plan.status, repo: plan.repo, branch: plan.branch, base: plan.baseRef ?? plan.baseCommit, baseCommit: plan.baseCommit, tasks, final };
}

// The latest events as short lines a person can follow.
export function activity(id, { limit = 40 } = {}) {
  const state = Store.inspect(planDir(id));
  const title = Object.fromEntries(state.tasks.map(t => [t.id, t.title]));
  const lines = [];
  for (const event of state.events) {
    const d = event.detail ?? {};
    const role = d.role === 'reviewer' ? 'Reviewer' : 'Worker';
    let kind = null, text = null;
    switch (event.type) {
      case 'dispatched': kind = 'start'; text = `${title[event.taskId] ?? event.taskId}: ${d}`; break;
      case 'provider:tool-activity': kind = 'tool'; text = `${role} · ${d.tool}${d.target ? ` ${d.target}` : ''}`; break;
      case 'provider:item-completed':
        if (d.item?.type === 'commandExecution') { kind = 'tool'; text = `${role} · ran ${String(d.item.command ?? '').slice(0, 160)}`; }
        else if (d.item?.type === 'fileChange') { kind = 'tool'; text = `${role} · edited ${(d.item.changes ?? []).map(c => c.path).join(', ').slice(0, 160)}`; }
        break;
      case 'provider:policy-denied': kind = 'note'; text = `${role} · refused: ${d.tool}${d.target ? ` ${d.target}` : ''} (carried on)`; break;
      case 'provider:output': if (String(d.text ?? '').trim()) { kind = 'say'; text = `${role}: ${String(d.text).trim().replace(/\s+/g, ' ').slice(0, 220)}`; } break;
      case 'change-inspected': kind = 'gate'; text = `Changed ${d.files?.length ?? 0} file${d.files?.length === 1 ? '' : 's'} (${d.changedLines ?? 0} lines)${d.gate && d.gate !== 'ok' ? `: ${d.gate}` : ''}`; break;
      case 'checks': case 'baseline-checks': case 'final-checks':
        kind = d.passed ? 'pass' : 'fail';
        text = `${event.type === 'baseline-checks' ? 'Baseline checks' : event.type === 'final-checks' ? 'Final checks' : 'Checks'} ${d.passed ? 'passed' : 'failed'} (${(d.results ?? []).map(r => r.exitCode === 0 ? '✓' : '✗').join('')})`;
        break;
      case 'review-requested': kind = 'review'; text = 'Sent to review'; break;
      case 'verified': kind = 'pass'; text = `Accepted: ${String(d).slice(0, 200)}`; break;
      case 'review-failed': kind = 'fail'; text = `Review asked for changes: ${String(d).slice(0, 200)}`; break;
      case 'committed': kind = 'commit'; text = `Committed ${String(d).slice(0, 8)}`; break;
      case 'blocked': case 'plan-blocked': kind = 'fail'; text = `Stopped: ${String(d).replace(/\s+/g, ' ').slice(0, 200)}`; break;
      case 'turn-timeout': case 'merge-detected': case 'limit-changed':
      case 'usage-limit': case 'usage-limit-resumed': case 'plan-limit': case 'paused': case 'resumed': case 'plan-ready':
      case 'queue-advanced': case 'pull-request-opened': case 'owner-fix-submitted': case 'skipped':
        kind = 'note'; text = String(typeof d === 'string' ? d : event.type).slice(0, 220); break;
    }
    // Times inside messages in local time, as the owner reads them.
    if (kind) lines.push({ at: event.at, kind, task: event.taskId ?? null,
      text: text.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, iso => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) });
  }
  return { id, waitUntil: state.waitUntil ?? null, lines: lines.slice(-limit) };
}

// Usage across plans: tokens (and Claude's reported equivalent cost, which a subscription
// does not charge), turns, and run time, per plan and per day.
export function usage({ days = 14 } = {}) {
  const since = Date.now() - days * 86_400_000;
  const perPlan = [];
  const perDay = new Map();
  const dayKey = at => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  for (const id of listPlanIds()) {
    let state;
    try { state = Store.inspect(planDir(id)); } catch { continue; }
    if (!state.plan && readDraft(planDir(id))) continue;
    const entry = { id, status: state.plan?.status ?? null, repo: state.plan?.repo ?? null, input: 0, output: 0, turns: 0, costUsd: 0, dispatches: 0, providers: {} };
    for (const event of state.events) {
      if (event.type === 'dispatched') entry.dispatches += 1;
      if (event.type !== 'provider:usage') continue;
      const d = event.detail ?? {};
      // input here means new input: cache re-reads are counted separately (src/tokens.js).
      const cachedInput = Number(d.tokens?.cachedInput) || 0;
      const input = Math.max(0, (Number(d.tokens?.input) || 0) - cachedInput), output = Number(d.tokens?.output) || 0;
      entry.cachedInput = (entry.cachedInput ?? 0) + cachedInput;
      entry.input += input; entry.output += output; entry.turns += 1; entry.costUsd += Number(d.costUsd) || 0;
      const provider = d.provider ?? 'unknown';
      entry.providers[provider] = (entry.providers[provider] ?? 0) + input + output;
      if (Date.parse(event.at) >= since) {
        const day = perDay.get(dayKey(event.at)) ?? { day: dayKey(event.at), input: 0, output: 0, turns: 0, plans: new Set() };
        day.input += input; day.output += output; day.turns += 1; day.plans.add(id);
        perDay.set(day.day, day);
      }
    }
    entry.costUsd = Number(entry.costUsd.toFixed(4));
    if (state.plan?.startedAt) entry.hours = Number((((state.plan.finishedAt ? Date.parse(state.plan.finishedAt) : Date.now()) - Date.parse(state.plan.startedAt)) / 3_600_000).toFixed(2));
    perPlan.push(entry);
  }
  const days_ = [...perDay.values()].sort((a, b) => a.day.localeCompare(b.day)).map(d => ({ ...d, plans: [...d.plans] }));
  const total = perPlan.reduce((sum, p) => ({ input: sum.input + p.input, output: sum.output + p.output, turns: sum.turns + p.turns, costUsd: sum.costUsd + p.costUsd }), { input: 0, output: 0, turns: 0, costUsd: 0 });
  total.costUsd = Number(total.costUsd.toFixed(4));
  return { days: days_, plans: perPlan, total };
}
