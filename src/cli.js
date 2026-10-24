import { resolve, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Store } from './store.js';
import { Supervisor } from './supervisor.js';
import { simulatedAdapter, simulatedReviewer } from './adapters/simulated.js';
import { buildAgents, checkProject } from './providers.js';
import { renderReport, renderDraft } from './report.js';
import { loadPlan, defaultLimits } from './plan.js';
import { Workspace } from './workspace.js';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { buildPlanner, providerNames, installedVersion, providerCommand, requireSubscription, requireChatgpt, isDisabled, defaultAgents, providerStatus, loginCommand } from './providers.js';
import { draftPlan } from './planner.js';
import { home, planDir, readConfig, writeConfig, freePlanId } from './home.js';
import { installIntegration } from './install.js';
import { chatTurn } from './chat.js';
import { resolveBase, snapshot, listBranches, describeBase } from './base.js';
import { checkReadiness, gitWarnings } from './readiness.js';
import { readDraft } from './plans.js';
import { listProjects, workspaceRoots } from './projects.js';
import { spawnSync } from 'node:child_process';
import { setTaskDifficulty } from './plans.js';
import { validateEffort, levels } from './effort.js';
import { createPlan, saveDraft, startPlan, stopRunner, mergePlan, discardPlan, summarize, listPlans, resumeRunners, editDraft, fixPrompt, syncMerges } from './plans.js';
import { readQueue, enqueuePlan, dequeuePlan, moveInQueue, advanceQueue, isActive } from './queue.js';
import { autostartStatus, setAutostart } from './autostart.js';
import { reviewData, activity, usage as usageReport } from './insight.js';
import { doctor } from './doctor.js';

const usage = `Usage: node src/cli.js <command> [options]

  setup                        Record the installed Claude/Codex versions and check sign-ins
  doctor                       Check what this Mac has and what is missing for Nightshift (changes nothing)
  run <doc> [--steps s]        Draft a plan from a document, ask once, then run it in the background
        [--repo path] [--agents spec] [--request text] [--base ref] [--yes]
                               --base: start from this branch or commit (default: the fetched main branch)
  branches --repo path         Branches to start from, and the default (fetches origin) [--json]
  check --repo path            Is the project ready? Where a plan would start, work it would leave out,
        [--base ref] [--check cmd]... [--no-run] [--json]
                               and whether the checks pass there (fresh worktree). Or: check --plan <draft-id>
  draft <doc> [same options]   Only draft the plan (review it, then \`start <id>\`)
  start <id> | stop <id>       Start or stop a plan's background runner
  providers [--json]           Installed versions, pins, sign-ins, and on/off for each provider
  login <provider>             Sign in with a subscription (claude.ai, ChatGPT); opens the browser
  chat --notes --message t     Interview from notes: Claude picks the project, asks questions, writes the roadmap
  chat --repo path --message t Plan chat about one repository [--session id --cwd dir] (JSON reply)
  projects [--json]            Projects found in the workspace roots
  workspaces [set|add|remove p] Where Nightshift looks for projects (default: the folder holding Nightshift)
  disable <provider>           Turn claude or codex off: Nightshift will not start it (enable to undo)
  enable <provider>            Turn it back on
  list [--json]                All plans in ~/.nightshift/plans with progress
  logs <id> [--lines n]        Print the last n lines (default 40) of a plan's runner log
  discard <id> --yes           Remove a plan: a draft; an unmerged plan's worktree, branch, and directory;
                               or a merged plan's record (its work stays merged)
  merge <id> [--pr | --local]  Approve: merge a finished plan into the branch it started from (nothing is pushed),
                               or with --pr push its branch and open a pull request (needs gh); mergeStyle sets the default
  queue [add|remove|up|down <id> | start | clear]
                               Plans that run one after another; the next starts when one stops for you
  autostart [on|off]           Start runners again after a restart (a login item); resume-runners does it now
  sync                         Notice plans merged outside Nightshift (fetches origin; asks GitHub about pull requests)
  settings [set <key> <value>] Run settings: onUsageLimit wait|stop, sandboxChecks, checkNetwork, mergeStyle local|pr,
                               claudeModel / codexModel <model|default>

  demo [state]                 Seed and run the simulated demo
  status [state]               Print saved state (works while a runner is active)
  plan <plan.json>             Start an edit-mode plan in a new worktree (see docs/EDIT_MODE.md)
  serve --agents <spec>        Keep running: dispatch ready tasks, then wait for more
        [--repo path] [--max-dispatches n] [--poll-seconds s]
        spec: simulated, codex, claude, codex:claude, claude:codex
  add --id <id> --title <t> --acceptance <a> [--after id,id] [--max-attempts n]
  pause | resume               Stop or restart dispatch at the next task boundary
  interrupt                    Stop the running turn now; its task blocks and the queue pauses
  retry <task-id|plan-id>      Requeue a blocked task (or reopen a blocked plan) after you have reconciled it
  skip <task-id>               Mark a blocked or waiting task done without changes (--plan id)
  accept <task-id>             Take the owner's own fix in the worktree for a blocked task: checks, then commit (--plan id)
  fix-prompt <id> [--json]     Where and what to tell an interactive Claude session that helps fix a stopped plan
  review <id> [--json]         Before approving: each task's diff, review verdict, and checks; the whole plan's diff
  activity <id> [--lines n]    What the agents did most recently (tools, files, checks, reviews) [--json]
  usage [days] [--json]        Tokens and turns per plan and per day (default 14 days)
  edit <draft> --file f.json   Change a draft before approving: brief, checks, allowedPaths, tasks (add, remove, reorder)
  limit <name> <value>         Change a plan limit, for example after one was reached
  difficulty <task> <level>    Rate a task low|medium|high (--plan id): sets the worker's starting effort
  effort [set <key> <level>]   Effort bounds and fixed levels: min, max, reviewer, planner (low…max)
  report [--since ISO]         Markdown summary of results, blockers, and usage
  report --plan <id> --json    One plan's summary as JSON (the same shape as an entry of \`list --json\`)

Plan commands take --plan <id> (state in ~/.nightshift/plans/<id>); others accept --state <dir> (default .nightshift).`;

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  state: { type: 'string' }, agents: { type: 'string' }, repo: { type: 'string' },
  'max-dispatches': { type: 'string', default: '20' }, 'poll-seconds': { type: 'string', default: '30' },
  id: { type: 'string' }, title: { type: 'string' }, acceptance: { type: 'string' }, after: { type: 'string' },
  'max-attempts': { type: 'string', default: '2' }, since: { type: 'string' }, help: { type: 'boolean' },
  plan: { type: 'string' }, 'no-fetch': { type: 'boolean' }, message: { type: 'string' }, session: { type: 'string' }, notes: { type: 'boolean' }, cwd: { type: 'string' }, 'with-rules': { type: 'boolean' }, steps: { type: 'string' }, request: { type: 'string' }, yes: { type: 'boolean' }, json: { type: 'boolean' },
  lines: { type: 'string', default: '40' }, base: { type: 'string' }, reason: { type: 'string' }, pr: { type: 'boolean' }, local: { type: 'boolean' }, file: { type: 'string' }, task: { type: 'string' }, check: { type: 'string', multiple: true }, 'no-run': { type: 'boolean' }
} });
const [command = 'status', argument] = positionals;
// demo and status also accept the state directory positionally, as in earlier versions.
const directory = resolve(values.state ?? (values.plan ? planDir(values.plan) : ((['demo', 'status'].includes(command) && argument) || '.nightshift')));
const positive = (text, name) => {
  const value = Number(text);
  if (!(value > 0)) throw new Error(`--${name} must be a positive number.`);
  return value;
};

async function demo() {
  const store = new Store(directory);
  store.acquire();
  try {
    const supervisor = new Supervisor(store, simulatedAdapter, simulatedReviewer);
    if (!supervisor.snapshot().tasks.length) {
      supervisor.add({ id: 'brief', title: 'Prepare project brief', acceptance: 'Requirements and constraints recorded.' });
      supervisor.add({ id: 'prototype', title: 'Build a first prototype', acceptance: 'Prototype passes defined checks.', dependencies: ['brief'] });
    }
    await supervisor.run();
    console.log(JSON.stringify(store.read(), null, 2));
  } finally { store.release(); }
}

async function serve() {
  const plan = Store.inspect(directory).plan;
  values.agents ??= plan?.agents;
  if (!values.agents) throw new Error('serve requires --agents.');
  const maxDispatches = Math.floor(positive(values['max-dispatches'], 'max-dispatches'));
  const pollMs = positive(values['poll-seconds'], 'poll-seconds') * 1000;
  if (plan && values.agents === 'simulated') throw new Error('Simulated agents cannot run an edit-mode plan.');
  if (plan && values.repo && resolve(values.repo) !== plan.repo) throw new Error(`This plan belongs to ${plan.repo}.`);
  const agents = buildAgents(values.agents, plan ? plan.repo : values.repo,
    plan ? { edit: { worktree: plan.worktree, turnMinutes: plan.limits.turnMinutes } } : {});
  const store = new Store(directory);
  store.acquire();
  let stopping = false;
  let failure = null;
  let wake = () => {};
  const stop = () => {
    if (stopping) process.exit(130); // Second signal: leave the lease to expire; restart recovery blocks in-flight work.
    stopping = true;
    console.error('Stopping after the current step. Press Ctrl-C again to exit immediately.');
    wake();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const beat = setInterval(() => {
    try { store.heartbeat(); } catch (error) { failure = error; stopping = true; wake(); }
  }, store.leaseMs / 3);
  let control;
  try {
    checkProject(store.read().project, agents.project);
    const workspace = plan ? new Workspace(plan) : null;
    const supervisor = new Supervisor(store, agents.worker, agents.reviewer, { workspace });
    supervisor.state.project = agents.project;
    store.save(supervisor.state);
    console.error(`Nightshift serving ${directory}: ${agents.describe}`);
    // While a turn runs, poll for commands so `interrupt` takes effect within a second.
    control = setInterval(() => {
      if (!supervisor.busy) return;
      try { supervisor.applyCommands(); } catch (error) { failure = error; stopping = true; wake(); }
    }, 1000);
    let dispatched = 0;
    let advanced = false;
    while (!stopping) {
      if (await supervisor.tick()) {
        dispatched += 1;
        if (dispatched >= maxDispatches) {
          // A persisted pause, so an OS restart cannot reset the cap.
          supervisor.record(null, 'dispatch-cap-reached', `${dispatched} dispatches in this run; resume to continue.`);
          supervisor.pause(true);
          dispatched = 0;
        }
        continue;
      }
      // The plan stopped for the owner: let the next queued plan run (once per stop).
      if (plan) {
        const active = isActive(supervisor.state);
        if (!active && !advanced) {
          advanced = true;
          try {
            const next = await advanceQueue(startPlan, { except: plan.id });
            if (next) supervisor.record(null, 'queue-advanced', `Started the next queued plan: ${next}`), store.save(supervisor.state);
          } catch (error) { console.error(`Could not start the next queued plan: ${error.message}`); }
        }
        if (active) advanced = false;
      }
      // Idle wait; a stop signal or a lost lease ends it at once.
      await new Promise(done => {
        const timer = setTimeout(done, pollMs);
        wake = () => { clearTimeout(timer); done(); };
      });
    }
    if (failure) throw failure;
  } finally {
    clearInterval(beat);
    clearInterval(control);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    store.release();
  }
}

function add() {
  if (!values.id || !values.title || !values.acceptance) throw new Error('add requires --id, --title, and --acceptance.');
  const maxAttempts = positive(values['max-attempts'], 'max-attempts');
  if (!Number.isInteger(maxAttempts)) throw new Error('--max-attempts must be a whole number.');
  Store.enqueue(directory, 'add-task', { id: values.id, title: values.title, acceptance: values.acceptance,
    dependencies: values.after ? values.after.split(',').map(id => id.trim()).filter(Boolean) : [], maxAttempts });
  console.log(`Queued task ${values.id}. A running \`serve\` applies it at the next task boundary.`);
}

function enqueue(type, payload) {
  Store.enqueue(directory, type, payload);
  console.log(type === 'interrupt'
    ? 'Queued interrupt. A running `serve` stops the current turn within about a second.'
    : `Queued ${type}. A running \`serve\` applies it at the next task boundary.`);
}

// Creates the plan's worktree and queues its tasks from a hand-written plan file.
function plan() {
  if (!argument) throw new Error('plan requires a plan file.');
  const created = createPlan(loadPlan(argument), directory, { agents: values.agents });
  console.log(`Plan ${created.id}: ${created.tasks.length} tasks queued on branch ${created.branch}\nWorktree: ${created.worktree}\n` +
    `Start it with: node src/cli.js serve --agents <spec> --state ${directory}`);
}

// Records exact CLI versions (the pins every run checks) and confirms subscription sign-ins.
function setup() {
  const config = readConfig();
  config.pins ??= {};
  config.commands ??= {};
  for (const name of providerNames) {
    if (isDisabled(name)) { console.log(`${name}: turned off; skipped (enable it with \`enable ${name}\`).`); continue; }
    let command;
    try { command = execFileSync('/bin/sh', ['-c', `command -v ${providerCommand(name)}`], { encoding: 'utf8' }).trim(); }
    catch { console.log(`${name}: not installed; skipped.`); continue; }
    const version = installedVersion(name);
    let auth;
    try { auth = name === 'claude' ? requireSubscription(command) : requireChatgpt(command); }
    catch (error) { console.log(`${name} ${version}: ${error.message}`); continue; }
    const previous = config.pins[name];
    config.pins[name] = version;
    config.commands[name] = command;
    console.log(`${name}: ${version} [${auth}]${previous && previous !== version ? ` (was ${previous})` : ''}`);
  }
  // The PATH entry (for example /opt/homebrew/bin/node) survives upgrades; the resolved path may not.
  try { config.node = execFileSync('/bin/sh', ['-c', 'command -v node'], { encoding: 'utf8' }).trim() || process.execPath; }
  catch { config.node = process.execPath; }
  config.cli = fileURLToPath(import.meta.url);
  config.updatedAt = new Date().toISOString();
  writeConfig(config);
  console.log(`Saved to ${home()}/config.json. Re-run setup after updating a CLI.`);
  for (const [path, result] of installIntegration(config)) console.log(`${result}: ${path}`);
}

function printDraft(id, { plan: draft, notes, agents, warnings }) {
  console.log(`\nPlan ${id} for ${draft.repo} (${agents}), starting from ${draft.baseRef ?? draft.base}${draft.base ? ` @ ${draft.base.slice(0, 7)}` : ''}:\n${draft.brief}\n`);
  draft.tasks.forEach((task, i) => console.log(`  ${i + 1}. ${task.title}${task.difficulty ? `  [${task.difficulty}: ${task.difficultyReason ?? ''}]` : ''}\n     done when: ${task.acceptance}`));
  console.log(`\nChecks: ${draft.checks.join('; ')}\nAllowed paths: ${draft.allowedPaths.map(p => p || '(whole repository)').join(', ')}`);
  console.log(`Limits: ${draft.limits.attemptsPerTask} attempts per task, ${draft.limits.dispatches} dispatches, ` +
    `${draft.limits.tokens.toLocaleString('en-US')} tokens, ${draft.limits.hours} hours`);
  if (notes) console.log(`Planner notes: ${notes}`);
  printWarnings(warnings);
  console.log(`\nBefore starting, \`nightshift check --plan ${id}\` runs these checks at the starting commit.`);
}

function printWarnings(warnings = []) {
  if (warnings.length) console.log(`\nLeft out of this plan:\n${warnings.map(w => `  ! ${w.message}`).join('\n')}`);
}

// Drafts a plan from a document with a read-only agent. Nothing runs until it is started.
async function draft() {
  if (!argument) throw new Error('Give the document to plan from, for example: draft docs/ROADMAP.md');
  const doc = resolve(argument);
  const repo = execFileSync('git', ['-C', values.repo ? resolve(values.repo) : resolve(doc, '..'), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  // Start from a known-good branch (by default the fetched main branch), not the checkout,
  // and let the planner read exactly that commit.
  const base = resolveBase(repo, { base: values.base });
  const root = snapshot(repo, base.commit);
  const agents = values.agents ?? defaultAgents();
  const plannerName = agents.split(':')[0];
  const planner = buildPlanner(plannerName, root);
  console.error(`Drafting with ${planner.describe}, from ${describeBase(base)}…`);
  const drafted = await draftPlan({ session: planner.session, repo, root, doc, steps: values.steps, request: values.request, base });
  const id = freePlanId(drafted.plan.id);
  const warnings = gitWarnings(repo, base);
  const record = { ...drafted, plan: { ...drafted.plan, id }, agents, warnings, draftedAt: new Date().toISOString() };
  const dir = saveDraft(id, record);
  if (values.json) console.log(JSON.stringify({ id, dir, draft: record }));
  else printDraft(id, record);
  return { id, record };
}

async function run() {
  const { id } = await draft();
  if (!values.yes) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question('\nStart this plan now? It runs in the background until done or blocked. [y/N] ');
    prompt.close();
    if (!/^y(es)?$/i.test(answer.trim())) return console.log(`Not started. Start it later with: node src/cli.js start ${id}`);
  }
  await start(id);
}

async function start(id = argument) {
  if (!id) throw new Error('start requires a plan id (see `list`).');
  const started = await startPlan(id, { agents: values.agents });
  const s = summarize(id);
  console.log(`${started.already ? 'Already running' : 'Started'}: plan ${id} on ${s.branch} (runner pid ${started.pid}).\n` +
    `Follow it with: node src/cli.js report --plan ${id}   (log: ${started.dir}/serve.log)`);
}

// Also notices plans merged outside Nightshift (local refs only; `sync` asks GitHub too).
async function list() {
  await syncMerges({ network: false });
  const plans = listPlans();
  if (values.json) return console.log(JSON.stringify({ home: home(), plans, queue: readQueue(), autostart: autostartStatus().enabled, settings: runSettings() }));
  if (!plans.length) return console.log('No plans yet. Draft one with: node src/cli.js run docs/PLAN.md');
  for (const p of plans) {
    const done = p.tasks.filter(t => t.status === 'done').length;
    console.log(`${p.id.padEnd(28)} ${(p.status + (p.paused ? ' (paused)' : '')).padEnd(26)} ${done}/${p.tasks.length} tasks  ` +
      `${p.runner ? 'runner on ' : 'runner off'}  ${p.repo}`);
    if (p.current) console.log(`  now: ${p.current.title}`);
    if (p.blocker) console.log(`  blocker: ${p.blocker.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
}

function logs() {
  if (!argument) throw new Error('logs requires a plan id (see `list`).');
  if (!summarize(argument)) throw new Error(`No plan or draft named ${argument}.`);
  const lines = positive(values.lines, 'lines');
  if (!Number.isInteger(lines)) throw new Error('--lines must be a whole number.');
  const file = join(planDir(argument), 'serve.log');
  if (!existsSync(file)) return console.log(`Plan ${argument} has no runner log yet.`);
  const text = readFileSync(file, 'utf8').replace(/\n$/, '');
  if (text) console.log(text.split('\n').slice(-lines).join('\n'));
}

function discard() {
  if (!argument) throw new Error('discard requires a plan id (see `list`).');
  const { removed, removes, problems } = discardPlan(argument, { confirm: values.yes });
  if (!removed) throw new Error(`discard ${argument} would remove:\n${removes.map(r => `  ${r}`).join('\n')}\nRun again with --yes to remove them.`);
  console.log(`Discarded plan ${argument}:\n${removes.map(r => r.startsWith('(') ? `  ${r}` : `  removed ${r}`).join('\n')}`);
  if (problems?.length) console.log(`Some steps did not complete (the plan record is gone either way):\n${problems.map(p => `  ${p}`).join('\n')}`);
}

// Turning a provider off is local configuration only: nothing is uninstalled or signed out.
function toggleProvider(enabled) {
  const name = argument;
  if (!providerNames.includes(name)) throw new Error(`Give a provider: ${providerNames.join(' or ')}.`);
  const config = readConfig();
  const disabled = new Set(config.disabledProviders ?? []);
  if (enabled) disabled.delete(name); else disabled.add(name);
  config.disabledProviders = [...disabled].sort();
  writeConfig(config);
  console.log(`${name} is now ${enabled ? 'on' : 'off'}. New plans default to: ${defaultAgents()}.` +
    (enabled ? '' : ` Plans already set up to use ${name} will refuse to run until you enable it.`));
}

function providers() {
  const statuses = providerNames.map(providerStatus);
  if (values.json) return console.log(JSON.stringify({ providers: statuses, defaultAgents: (() => { try { return defaultAgents(); } catch { return null; } })() }));
  for (const s of statuses) {
    console.log(`${s.name.padEnd(7)} ${s.enabled ? 'on ' : 'off'}  ${s.version ?? 'not installed'}  ${s.signedIn ? s.auth : 'not signed in'}${s.problem ? `  (${s.problem})` : ''}`);
  }
}

function login() {
  if (!providerNames.includes(argument)) throw new Error(`Give a provider: ${providerNames.join(' or ')}.`);
  const { command, args, env } = loginCommand(argument);
  const result = spawnSync(command, args, { stdio: 'inherit', env });
  if (result.status !== 0) throw new Error(`${argument} sign-in did not complete (exit ${result.status}).`);
  console.log(`${argument} signed in. Run setup to record it.`);
}

async function chat() {
  if (!values.repo && !values.notes && !values.session) throw new Error('chat requires --notes (interview from notes) or --repo <path>.');
  // The app's Stop button sends SIGTERM: stop the Claude turn (killing its process), then exit.
  const abort = new AbortController();
  const stop = () => abort.abort(new Error('Stopped by the owner.'));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    console.log(JSON.stringify(await chatTurn({ repo: values.repo, session: values.session, message: values.message,
      notes: values.notes, cwd: values.cwd, withRules: values['with-rules'], signal: abort.signal })));
  } finally { process.off('SIGTERM', stop); process.off('SIGINT', stop); }
}

function effort() {
  const [, action, key, level] = positionals;
  const config = readConfig();
  if (action === 'set') {
    if (!key || !level) throw new Error(`Use: effort set <min|max|reviewer|planner> <${levels.join('|')}>`);
    config.effort = validateEffort({ ...config.effort, [key]: level });
    writeConfig(config);
  } else if (action) throw new Error('Use: effort [set <key> <level>]');
  const settings = validateEffort(config.effort);
  if (values.json) return console.log(JSON.stringify(settings));
  console.log(`Workers start at the task's difficulty (low, medium, high), one level higher per retry, within ${settings.min}…${settings.max}.\n` +
    `Reviewers: ${settings.reviewer}. Planner and interviewer: ${settings.planner}. New plans take these settings when they start.`);
}

function branches() {
  if (!values.repo) throw new Error('branches requires --repo <path>.');
  const repo = execFileSync('git', ['-C', resolve(values.repo), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const base = resolveBase(repo, { fetch: !values['no-fetch'] });
  const list = listBranches(repo);
  const warnings = gitWarnings(repo, base);
  if (values.json) return console.log(JSON.stringify({ repo, default: base, branches: list, warnings }));
  console.log(`Default start: ${describeBase(base)}`);
  printWarnings(warnings);
  for (const b of list) console.log(`  ${b.ref.padEnd(40)} ${b.date.slice(0, 16).replace('T', ' ')}  ${b.subject.slice(0, 60)}`);
}

// Readiness: where a plan would start, what it would leave out, and whether the checks pass
// there. With --plan, a draft's own start commit and checks.
async function check() {
  let repo, base = values.base, checks = values.check, ref, branch, checkSource;
  if (values.plan) {
    const draft = readDraft(planDir(values.plan));
    const plan = draft?.plan ?? Store.inspect(planDir(values.plan)).plan;
    if (!plan) throw new Error(`No plan or draft named ${values.plan}.`);
    repo = plan.repo;
    if (!checks) { checks = plan.checks; checkSource = `plan ${values.plan}`; }
    if (!base) { base = plan.base; ref = plan.baseRef; branch = plan.baseBranch; }
  } else {
    if (!values.repo) throw new Error('check requires --repo <path> or --plan <id>.');
    repo = execFileSync('git', ['-C', resolve(values.repo), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  }
  const abort = new AbortController();
  const stop = () => abort.abort(new Error('Stopped by the owner.'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const report = await checkReadiness(repo, { base, ref, branch, checks, checkSource, fetch: !values['no-fetch'], run: !values['no-run'], signal: abort.signal,
    onCheck: ({ index, total, command }) => console.error(`Running check ${index + 1} of ${total}: ${command}`) });
  if (abort.signal.aborted) throw abort.signal.reason;
  if (values.json) return console.log(JSON.stringify(report));
  console.log(`${repo}\nStarts from: ${describeBase(report.base)}${report.base.notes.length ? ` (${report.base.notes.join('; ')})` : ''}`);
  printWarnings(report.warnings);
  const { checks: c } = report;
  if (!c.commands.length) console.log('\nNo checks known. Pass them with --check "<command>" (repeatable).');
  else if (!c.ran) console.log(`\nChecks (${c.source}), not run: ${c.commands.join('; ')}`);
  else {
    console.log(`\nChecks (${c.source}):`);
    for (const r of c.results) {
      console.log(`  ${r.exitCode === 0 ? 'ok  ' : 'FAIL'} ${r.command} (${r.timedOut ? 'timed out' : `exit ${r.exitCode}`}, ${Math.round(r.durationMs / 1000)}s)`);
      if (r.exitCode !== 0) console.log(r.output.trim().split('\n').slice(-20).map(line => `       ${line}`).join('\n'));
    }
  }
  if (report.ready === true) console.log(`\nReady: the checks pass at ${report.base.ref} @ ${report.base.commit.slice(0, 7)}.${report.warnings.length ? ' Look at what is left out above.' : ''}`);
  if (report.ready === false) {
    console.log(`\nNot ready: the checks fail at ${report.base.ref} @ ${report.base.commit.slice(0, 7)}, so every task would fail them. Fix that branch (and push), or start from another with --base.`);
    process.exitCode = 2;
  }
}

// Run settings shared by the CLI and the app (stored in ~/.nightshift/config.json).
// Model settings take a model name (as the provider's CLI accepts it) or "default" for the account's default.
const modelName = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,80}$/;
const settingKeys = {
  onUsageLimit: ['wait', 'stop'], sandboxChecks: ['true', 'false'], checkNetwork: ['true', 'false'], mergeStyle: ['local', 'pr'],
  claudeModel: modelName, codexModel: modelName
};
function runSettings(config = readConfig()) {
  return { onUsageLimit: config.onUsageLimit ?? 'wait', sandboxChecks: config.sandboxChecks !== false, checkNetwork: config.checkNetwork === true,
    mergeStyle: config.mergeStyle ?? 'local', autostart: autostartStatus().enabled,
    claudeModel: config.claudeModel ?? null, codexModel: config.codexModel ?? null };
}
function settings() {
  const [, action, key, value] = positionals;
  if (action === 'set') {
    if (!settingKeys[key]) throw new Error(`Unknown setting ${key}. Settings: ${Object.keys(settingKeys).join(', ')}.`);
    const allowed = settingKeys[key];
    if (Array.isArray(allowed) ? !allowed.includes(value) : !allowed.test(value ?? '')) {
      throw new Error(Array.isArray(allowed) ? `${key} must be one of: ${allowed.join(', ')}.` : `${key} must be a model name, such as claude-opus-5-5, or "default".`);
    }
    const config = readConfig();
    if (!Array.isArray(allowed) && value === 'default') delete config[key];
    else config[key] = value === 'true' ? true : value === 'false' ? false : value;
    writeConfig(config);
  } else if (action) throw new Error('Use: settings [set <key> <value>]');
  const current = runSettings();
  if (values.json) return console.log(JSON.stringify(current));
  for (const [k, v] of Object.entries(current)) console.log(`${k.padEnd(14)} ${v}`);
}

async function queue() {
  const [, action, id] = positionals;
  if (['add', 'remove', 'up', 'down'].includes(action) && !id) throw new Error(`queue ${action} requires a plan id.`);
  if (action === 'add') await enqueuePlan(id);
  else if (action === 'remove') await dequeuePlan(id);
  else if (action === 'up' || action === 'down') await moveInQueue(id, action === 'up' ? -1 : 1);
  else if (action === 'clear') for (const queued of readQueue()) await dequeuePlan(queued);
  else if (action === 'start') {
    const next = await advanceQueue(startPlan);
    if (!values.json) console.log(next ? `Started ${next}.` : readQueue().length ? 'A plan is still working; the queue continues when it stops.' : 'The queue is empty.');
  } else if (action) throw new Error('Use: queue [add|remove|up|down <id> | start | clear]');
  const plans = readQueue();
  if (values.json) return console.log(JSON.stringify({ queue: plans }));
  if (action !== 'start') console.log(plans.length ? plans.map((p, i) => `${i + 1}. ${p}`).join('\n') : 'The queue is empty.');
}

function autostart() {
  const [, action] = positionals;
  if (action && !['on', 'off'].includes(action)) throw new Error('Use: autostart [on|off]');
  const status = action ? setAutostart(action === 'on') : autostartStatus();
  if (values.json) return console.log(JSON.stringify(status));
  console.log(status.enabled ? `On: runners that were on start again at login (${status.plist}).` : 'Off: after a restart, start runners yourself (or turn this on).');
}

function projects() {
  const list = listProjects();
  if (values.json) return console.log(JSON.stringify({ workspaces: workspaceRoots(), projects: list }));
  for (const p of list) console.log(`${p.name.padEnd(22)} ${p.description}`);
}

// Workspace roots: where the interviewer looks for projects.
function workspaces() {
  const [, action, path] = positionals;
  const config = readConfig();
  const roots = new Set(config.workspaces ?? workspaceRoots());
  if (action === 'set' && path) { roots.clear(); roots.add(resolve(path)); }
  else if (action === 'add' && path) roots.add(resolve(path));
  else if (action === 'remove' && path) roots.delete(resolve(path));
  else if (action) throw new Error('Use: workspaces [set <path> | add <path> | remove <path>]');
  if (action) { config.workspaces = [...roots]; writeConfig(config); }
  console.log([...roots].join('\n'));
}

const commands = {
  demo, serve, add, plan, setup, draft, run, list, providers, login, chat, projects, workspaces, effort, branches, check, settings, queue, autostart,
  // Notices plans merged outside Nightshift: fetches origin and asks GitHub about open pull requests.
  doctor: () => {
    const report = doctor();
    if (values.json) return console.log(JSON.stringify(report));
    const mark = { ok: '✓', warn: '!', fail: '✗', info: '·' };
    for (const c of report.checks) console.log(`${mark[c.level]} ${c.name.padEnd(22)} ${c.detail}${c.fix ? `\n  ${''.padEnd(22)} → ${c.fix}` : ''}`);
    console.log(report.ok ? '\nReady to use.' : '\nFix the items marked ✗ first.');
    if (!report.ok) process.exitCode = 1;
  },
  sync: async () => {
    const marked = await syncMerges({ network: !values['no-fetch'] });
    if (values.json) return console.log(JSON.stringify({ merged: marked }));
    console.log(marked.length ? marked.map(m => `${m.id}: merged (${m.how})`).join('\n') : 'No plan was merged outside Nightshift.');
  },
  'resume-runners': async () => { const started = await resumeRunners(); console.log(started.length ? `Started: ${started.join(', ')}` : 'Nothing to start.'); },
  difficulty: () => {
    if (!values.plan || !argument || !positionals[2]) throw new Error('Use: difficulty <task-id> <low|medium|high> --plan <id>');
    console.log(setTaskDifficulty(values.plan, argument, positionals[2]) === 'queued' ? 'Queued: applies from the task\'s next attempt.' : 'Draft updated.');
  },
  disable: () => toggleProvider(false),
  enable: () => toggleProvider(true), logs, discard,
  start: () => start(),
  stop: async () => { if (!argument) throw new Error('stop requires a plan id.'); console.log(await stopRunner(argument) ? 'Stopped.' : 'Not running.'); },
  merge: async () => {
    if (!argument) throw new Error('merge requires a plan id.');
    if (values.pr || readConfig().mergeStyle === 'pr' && !values.local) {
      const opened = await mergePlan(argument, { style: 'pr' });
      return console.log(`Pushed ${opened.branch} and opened a pull request into ${opened.base}: ${opened.url}`);
    }
    const merged = await mergePlan(argument, { style: 'local' });
    console.log(`Merged ${merged.branch} into ${merged.target} as ${merged.merged.slice(0, 12)}. The worktree was removed; the branch is kept.`);
  },
  status: () => console.log(JSON.stringify(Store.inspect(directory), null, 2)),
  report: () => {
    const draft = values.plan && !Store.inspect(directory).plan ? readDraft(directory) : null;
    if (!values.json && draft) return process.stdout.write(renderDraft(values.plan, draft));
    if (!values.json) return process.stdout.write(renderReport(Store.inspect(directory), { since: values.since }));
    if (!values.plan) throw new Error('report --json requires --plan <id>.');
    const summary = summarize(values.plan);
    if (!summary) throw new Error(`No plan or draft named ${values.plan}.`);
    console.log(JSON.stringify(summary));
  },
  pause: () => enqueue('pause', { reason: values.reason ?? 'Paused with `nightshift pause`' }),
  resume: () => enqueue('resume', { reason: values.reason ?? 'Resumed with `nightshift resume`' }),
  interrupt: () => enqueue('interrupt'),
  retry: () => { if (!argument) throw new Error('retry requires a task ID.'); enqueue('retry', { id: argument }); },
  skip: () => { if (!argument) throw new Error('skip requires a task ID.'); enqueue('skip', { id: argument }); },
  accept: () => { if (!argument) throw new Error('accept requires the blocked task\'s ID.'); enqueue('accept', { id: argument }); },
  edit: () => {
    if (!argument || !values.file) throw new Error('Use: edit <draft-id> --file changes.json (brief, checks, allowedPaths, tasks)');
    const plan = editDraft(argument, JSON.parse(readFileSync(resolve(values.file), 'utf8')));
    if (values.json) return console.log(JSON.stringify(plan));
    console.log(`Draft ${argument} updated: ${plan.tasks.length} tasks, checks: ${plan.checks.join('; ')}`);
  },
  review: () => {
    if (!argument) throw new Error('review requires a plan id.');
    const data = reviewData(argument);
    if (values.json) return console.log(JSON.stringify(data));
    console.log(`${data.id}: ${data.branch} from ${data.base}${data.final ? ` (${data.final.stat})` : ''}`);
    for (const task of data.tasks) {
      console.log(`\n${task.status === 'done' ? '✓' : '·'} ${task.title}${task.commit ? ` [${task.commit.slice(0, 8)}]` : ''}${task.ownerFixed ? ' (fixed by you)' : task.skipped ? ' (skipped)' : ''}`);
      if (task.review) console.log(`  review: ${task.review.reason.replace(/\s+/g, ' ').slice(0, 300)}`);
      if (task.stat) console.log(task.stat.split('\n').map(l => `  ${l}`).join('\n'));
    }
    if (data.final?.review) console.log(`\nFinal review: ${data.final.review.reason}`);
    console.log(`\nFull diffs: nightshift review ${data.id} --json, or git diff ${data.baseCommit.slice(0, 12)} ${data.branch}`);
  },
  activity: () => {
    if (!argument) throw new Error('activity requires a plan id.');
    const data = activity(argument, { limit: Number(values.lines) || 40 });
    if (values.json) return console.log(JSON.stringify(data));
    for (const line of data.lines) console.log(`${line.at.slice(11, 19)}  ${line.text}`);
    if (data.waitUntil) console.log(`Waiting for the usage limit to reset (until ${data.waitUntil}).`);
  },
  usage: () => {
    const data = usageReport({ days: Number(positionals[1]) || 14 });
    if (values.json) return console.log(JSON.stringify(data));
    const k = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
    for (const day of data.days) console.log(`${day.day}  ${k(day.input + day.output).padStart(6)} tokens  ${String(day.turns).padStart(4)} turns  ${day.plans.join(', ')}`);
    for (const plan of data.plans) console.log(`${plan.id.padEnd(28)} ${k(plan.input + plan.output).padStart(6)} tokens  ${plan.turns} turns  ${plan.dispatches} attempts${plan.hours !== undefined ? `  ${plan.hours} h` : ''}`);
    console.log(`Total: ${k(data.total.input + data.total.output)} tokens in ${data.total.turns} turns (on your subscription; Claude reports about US$${data.total.costUsd.toFixed(2)} at API prices, which you are not charged)`);
  },
  'fix-prompt': () => {
    if (!argument) throw new Error('fix-prompt requires a plan id.');
    const fix = fixPrompt(argument);
    if (values.json) return console.log(JSON.stringify(fix));
    console.log(`cd ${fix.cwd}\n\n${fix.prompt}`);
  },
  // A running plan applies a limit within a second, including the time per turn of the turn in
  // progress; a plan without a runner takes it at once; a draft keeps it for when it starts.
  limit: () => {
    const value = positionals[2];
    if (!argument || !value) throw new Error('limit requires a name and a value, for example: limit tokens 8000000');
    if (!(argument in defaultLimits)) throw new Error(`Unknown limit ${argument}. Valid limits: ${Object.keys(defaultLimits).join(', ')}.`);
    if (values.plan && !Store.inspect(directory).plan && readDraft(directory)) {
      editDraft(values.plan, { limits: { [argument]: Number(value) } });
      return console.log(`Draft ${values.plan}: ${argument} = ${value}.`);
    }
    if (!Store.inspect(directory).runner?.alive) {
      const store = new Store(directory);
      store.acquire();
      try { new Supervisor(store, null, null).setLimit(argument, Number(value)); }
      finally { store.release(); }
      return console.log(`Set ${argument} = ${value}.`);
    }
    Store.enqueue(directory, 'limit', { name: argument, value: Number(value) });
    console.log(`Queued: ${argument} = ${value}. The running plan applies it within a second, including to the turn in progress.`);
  }
};

if (values.help || !commands[command]) {
  console.error(usage);
  process.exitCode = values.help ? 0 : 1;
} else {
  try { await commands[command](); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
