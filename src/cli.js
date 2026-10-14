import { resolve, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Store } from './store.js';
import { Supervisor } from './supervisor.js';
import { simulatedAdapter, simulatedReviewer } from './adapters/simulated.js';
import { buildAgents, checkProject } from './providers.js';
import { renderReport } from './report.js';
import { loadPlan } from './plan.js';
import { Workspace } from './workspace.js';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { buildPlanner, providerNames, installedVersion, providerCommand, requireSubscription, requireChatgpt } from './providers.js';
import { draftPlan } from './planner.js';
import { home, planDir, readConfig, writeConfig, freePlanId } from './home.js';
import { createPlan, saveDraft, startPlan, stopRunner, mergePlan, discardPlan, summarize, listPlans } from './plans.js';

const usage = `Usage: node src/cli.js <command> [options]

  setup                        Record the installed Claude/Codex versions and check sign-ins
  run <doc> [--steps s]        Draft a plan from a document, ask once, then run it in the background
        [--repo path] [--agents claude:codex] [--request text] [--yes]
  draft <doc> [same options]   Only draft the plan (review it, then \`start <id>\`)
  start <id> | stop <id>       Start or stop a plan's background runner
  list [--json]                All plans in ~/.nightshift/plans with progress
  logs <id> [--lines n]        Print the last n lines (default 40) of a plan's runner log
  discard <id> --yes           Remove an unmerged plan: its draft, or its worktree, branch, and directory
  merge <id>                   Approve: merge a finished plan's branch into the repository's current branch

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
  limit <name> <value>         Change a plan limit, for example after one was reached
  report [--since ISO]         Markdown summary of results, blockers, and usage

Plan commands take --plan <id> (state in ~/.nightshift/plans/<id>); others accept --state <dir> (default .nightshift).`;

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  state: { type: 'string' }, agents: { type: 'string' }, repo: { type: 'string' },
  'max-dispatches': { type: 'string', default: '20' }, 'poll-seconds': { type: 'string', default: '30' },
  id: { type: 'string' }, title: { type: 'string' }, acceptance: { type: 'string' }, after: { type: 'string' },
  'max-attempts': { type: 'string', default: '2' }, since: { type: 'string' }, help: { type: 'boolean' },
  plan: { type: 'string' }, steps: { type: 'string' }, request: { type: 'string' }, yes: { type: 'boolean' }, json: { type: 'boolean' },
  lines: { type: 'string', default: '40' }
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
}

function printDraft(id, { plan: draft, notes, agents }) {
  console.log(`\nPlan ${id} for ${draft.repo} (${agents}):\n${draft.brief}\n`);
  draft.tasks.forEach((task, i) => console.log(`  ${i + 1}. ${task.title}\n     done when: ${task.acceptance}`));
  console.log(`\nChecks: ${draft.checks.join('; ')}\nAllowed paths: ${draft.allowedPaths.map(p => p || '(whole repository)').join(', ')}`);
  console.log(`Limits: ${draft.limits.attemptsPerTask} attempts per task, ${draft.limits.dispatches} dispatches, ` +
    `${draft.limits.tokens.toLocaleString('en-US')} tokens, ${draft.limits.hours} hours`);
  if (notes) console.log(`Planner notes: ${notes}`);
}

// Drafts a plan from a document with a read-only agent. Nothing runs until it is started.
async function draft() {
  if (!argument) throw new Error('Give the document to plan from, for example: draft docs/ROADMAP.md');
  const doc = resolve(argument);
  const repo = execFileSync('git', ['-C', values.repo ? resolve(values.repo) : resolve(doc, '..'), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const agents = values.agents ?? readConfig().defaultAgents ?? 'claude:codex';
  const plannerName = agents.split(':')[0];
  const planner = buildPlanner(plannerName, repo);
  console.error(`Drafting with ${planner.describe}…`);
  const drafted = await draftPlan({ session: planner.session, repo, doc, steps: values.steps, request: values.request });
  const id = freePlanId(drafted.plan.id);
  const record = { ...drafted, plan: { ...drafted.plan, id }, agents, draftedAt: new Date().toISOString() };
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

function list() {
  const plans = listPlans();
  if (values.json) return console.log(JSON.stringify({ home: home(), plans }));
  if (!plans.length) return console.log('No plans yet. Draft one with: node src/cli.js run docs/PLAN.md');
  for (const p of plans) {
    const done = p.tasks.filter(t => t.status === 'done').length;
    console.log(`${p.id.padEnd(28)} ${(p.status + (p.paused ? ' (paused)' : '')).padEnd(26)} ${done}/${p.tasks.length} tasks  ` +
      `${p.runner ? 'runner on ' : 'runner off'}  ${p.repo}`);
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
  const { removed, removes } = discardPlan(argument, { confirm: values.yes });
  if (!removed) throw new Error(`discard ${argument} would remove:\n${removes.map(r => `  ${r}`).join('\n')}\nRun again with --yes to remove them.`);
  console.log(`Discarded plan ${argument}:\n${removes.map(r => `  removed ${r}`).join('\n')}`);
}

const commands = {
  demo, serve, add, plan, setup, draft, run, list, logs, discard,
  start: () => start(),
  stop: async () => { if (!argument) throw new Error('stop requires a plan id.'); console.log(await stopRunner(argument) ? 'Stopped.' : 'Not running.'); },
  merge: async () => {
    if (!argument) throw new Error('merge requires a plan id.');
    const merged = await mergePlan(argument);
    console.log(`Merged ${merged.branch} into ${merged.target} as ${merged.merged.slice(0, 12)}. The worktree was removed; the branch is kept.`);
  },
  status: () => console.log(JSON.stringify(Store.inspect(directory), null, 2)),
  report: () => process.stdout.write(renderReport(Store.inspect(directory), { since: values.since })),
  pause: () => enqueue('pause'),
  resume: () => enqueue('resume'),
  interrupt: () => enqueue('interrupt'),
  retry: () => { if (!argument) throw new Error('retry requires a task ID.'); enqueue('retry', { id: argument }); },
  limit: () => {
    const value = positionals[2];
    if (!argument || !value) throw new Error('limit requires a name and a value, for example: limit tokens 8000000');
    enqueue('limit', { name: argument, value: Number(value) });
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
