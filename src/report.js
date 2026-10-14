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
  if (state.project) out.push(`Project: \`${state.project.cwd ?? 'no repository'}\` (${state.project.pairing ?? 'codex:codex'}${state.project.claudeAuth ? `; Claude sign-in: ${state.project.claudeAuth}` : ''}).`);
  if (state.paused) out.push('', '**The queue is paused.** Run `node src/cli.js resume` to continue.');
  if (state.pendingCommands) out.push('', `${state.pendingCommands} queued command(s) are waiting for a running \`serve\`.`);

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
    const entry = usage[detail.provider] ??= { turns: 0, costUsd: 0 };
    entry.turns += 1;
    entry.costUsd += Number(detail.costUsd) || 0;
  }
  const dispatches = events.filter(event => event.type === 'dispatched').length;
  out.push('', '## Usage', '', `- ${dispatches} dispatch(es).`);
  for (const [provider, { turns, costUsd }] of Object.entries(usage)) {
    out.push(`- ${provider}: ${turns} turn(s), reported cost $${costUsd.toFixed(4)} (subscription sign-ins may report notional cost).`);
  }
  if (!Object.keys(usage).length) out.push('- No provider usage was reported.');
  return out.join('\n') + '\n';
}
