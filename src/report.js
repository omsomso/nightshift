import { planTokens } from './tokens.js';
// Renders a plain-Markdown summary for the owner. Labels simulated and unverified results.
const simulated = task => [task.result?.summary, task.review?.reason].some(text => text?.includes('[SIMULATED]'));
const line = text => String(text ?? '').replace(/\s+/g, ' ').trim().replace(/\.$/, '');

export function renderReport(state, { since, now = new Date() } = {}) {
  const sinceTime = since ? Date.parse(since) : null;
  if (since && Number.isNaN(sinceTime)) throw new Error('--since must be an ISO date or time.');
  const events = state.events.filter(event => sinceTime === null || Date.parse(event.at) >= sinceTime);
  const touched = new Set(events.map(event => event.taskId).filter(Boolean));
  const tasks = state.tasks.filter(task => sinceTime === null || touched.has(task.id) || task.status !== 'done');
  const byStatus = status => tasks.filter(task => task.status === status);
  const providers = task => Object.entries(task.sessions ?? {}).map(([role, s]) => `${role}: ${s.provider}`).join(', ');
  const out = [`# Nightshift report`, '', `Generated ${now.toISOString()}${since ? `; activity since ${since}` : ''}.`];
  if (state.project) out.push(`Project: \`${state.project.cwd ?? 'no repository'}\` (${state.project.pairing ?? 'codex:codex'}${state.project.claudeAuth ? `; Claude sign-in: ${state.project.claudeAuth}` : ''}${state.project.codexAuth ? `; Codex sign-in: ${state.project.codexAuth}` : ''}).`);
  if (state.paused) out.push('', '**The queue is paused.** Run `node src/cli.js resume` to continue.');
  if (state.pendingCommands) out.push('', `${state.pendingCommands} queued command(s) are waiting for a running \`serve\`.`);

  if (state.plan) out.push(...planSection(state));

  const counts = ['done', 'blocked', 'ready', 'running', 'review'].map(s => `${byStatus(s).length} ${s}`).join(' · ');
  out.push('', `**${counts}**`);

  const section = (title, list, describe) => {
    if (!list.length) return;
    out.push('', `## ${title}`, '');
    for (const task of list) out.push(`- **${task.title}** (\`${task.id}\`) — ${describe(task)}`);
  };
  section('Verified', byStatus('done'), task => [simulated(task) ? 'SIMULATED, not real verification' : 'review passed',
    line(task.review?.reason), `${task.attempts} attempt(s)`, providers(task)].filter(Boolean).join('; '));
  section('Blocked — needs you', byStatus('blocked'), task => `${line(task.reason)}. After reconciling, run \`node src/cli.js retry ${task.id}\`.`);
  section('In progress or interrupted', [...byStatus('running'), ...byStatus('review')], task => `${task.status}; not yet verified`);
  section('Waiting', byStatus('ready'), task => {
    const pending = task.dependencies.filter(id => !state.tasks.some(other => other.id === id && other.status === 'done'));
    return pending.length ? `waiting on ${pending.join(', ')}` : task.attempts ? `ready for attempt ${task.attempts + 1}` : 'ready';
  });

  const approvals = events.filter(event => event.type === 'provider:approval-required');
  if (approvals.length) {
    out.push('', '## Requests that were refused', '', 'Nothing is approved automatically. These were recorded and blocked their task:', '');
    for (const { taskId, detail } of approvals) out.push(`- \`${taskId}\` ${detail.provider}: ${detail.tool ?? detail.method ?? 'request'} — ${line(detail.reason)}`);
  }

  const rejected = events.filter(event => event.type === 'command-rejected');
  if (rejected.length) {
    out.push('', '## Rejected commands', '');
    for (const event of rejected) out.push(`- ${line(event.detail)}`);
  }

  const usage = {};
  for (const { detail } of events.filter(event => event.type === 'provider:usage')) {
    const entry = usage[detail.provider] ??= { turns: 0, costUsd: null, input: 0, cachedInput: 0, output: 0 };
    entry.turns += 1;
    if (Number.isFinite(Number(detail.costUsd))) entry.costUsd = (entry.costUsd ?? 0) + Number(detail.costUsd);
    for (const key of ['input', 'cachedInput', 'output']) entry[key] += Number(detail.tokens?.[key]) || 0;
  }
  const count = value => value.toLocaleString('en-US');
  const dispatches = events.filter(event => event.type === 'dispatched').length;
  out.push('', '## Usage', '', `- ${dispatches} dispatch(es).`);
  for (const [provider, { turns, costUsd, input, cachedInput, output }] of Object.entries(usage)) {
    const cost = costUsd === null ? 'no cost reported (plan usage)' : `list-price cost $${costUsd.toFixed(4)}, counted against the plan`;
    out.push(`- ${provider}: ${turns} turn(s); ${count(input)} input tokens (${count(cachedInput)} cached), ${count(output)} output; ${cost}.`);
  }
  if (!Object.keys(usage).length) out.push('- No provider usage was reported.');
  return out.join('\n') + '\n';
}

// Edit mode: where the work is, how far it got, how close it is to its limits, and how to approve it.
function planSection(state) {
  const plan = state.plan;
  const label = { running: 'running', blocked: 'blocked — needs you', 'awaiting-approval': 'ready for your review and merge' }[plan.status] ?? plan.status;
  const dispatches = state.events.filter(e => e.type === 'dispatched').length;
  const tokens = planTokens(state.events);
  const hours = ((plan.finishedAt ? Date.parse(plan.finishedAt) : Date.now()) - Date.parse(plan.startedAt)) / 3_600_000;
  const out = ['', `## Plan \`${plan.id}\`: ${label}`, '',
    `Branch \`${plan.branch}\` from ${plan.baseRef ? `\`${plan.baseRef}\` @ ` : ''}\`${plan.baseCommit.slice(0, 12)}\` in \`${plan.repo}\`; worktree \`${plan.worktree}\`.`,
    `Limits used: ${dispatches}/${plan.limits.dispatches} dispatches, ${tokens.toLocaleString('en-US')}/${plan.limits.tokens.toLocaleString('en-US')} tokens, ` +
      `${hours.toFixed(1)}/${plan.limits.hours} hours.`];
  out.push(`Project rules: ${plan.rules?.length ? plan.rules.map(r => [r.path, ...(r.also ?? [])].join(' = ')).join(', ') : 'none found'}.`);
  if (plan.reason) out.push('', `Blocker: ${line(plan.reason)}. After fixing it, run \`node src/cli.js retry ${plan.id}\` and \`resume\`.`);
  const checks = task => {
    const last = state.events.findLast(e => e.taskId === task.id && e.type === 'checks');
    return !last ? 'no checks yet' : last.detail?.passed ? 'checks passed' : 'checks failed';
  };
  out.push('', 'Tasks:', ...state.tasks.map(t => `- **${t.title}** (\`${t.id}\`) — ${t.status}; ${t.attempts} attempt(s)` +
    `${t.difficulty ? `; rated ${t.difficulty}` : ''}${t.effort ? `; last run at ${t.effort} effort` : ''}; ${checks(t)}`));
  if (plan.effort) out.push(`Effort: workers ${plan.effort.min}…${plan.effort.max} by difficulty, +1 per retry; reviewers ${plan.effort.reviewer}.`);
  const commits = state.tasks.filter(t => t.commit).map(t => `- \`${t.commit.slice(0, 12)}\` ${t.title}`);
  if (commits.length) out.push('', 'Commits:', ...commits);
  if (plan.status === 'awaiting-approval') {
    out.push('', `Final review: ${line(plan.final?.review?.reason)}.`, '', `To approve, look at the branch, then merge it into ${plan.baseBranch ?? 'the current branch'} (nothing is pushed):`, '',
      '```sh', `git -C ${plan.repo} log --stat ${plan.baseCommit.slice(0, 12)}..${plan.branch}`, `nightshift merge ${plan.id}`, '```');
  }
  return out;
}
