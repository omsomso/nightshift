import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Store } from './store.js';
import { Supervisor } from './supervisor.js';
import { simulatedAdapter, simulatedReviewer } from './adapters/simulated.js';
import { buildAgents, checkProject } from './providers.js';
import { renderReport } from './report.js';

const usage = `Usage: node src/cli.js <command> [options]

  demo [state]                 Seed and run the simulated demo
  status [state]               Print saved state (works while a runner is active)
  serve --agents <spec>        Keep running: dispatch ready tasks, then wait for more
        [--repo path] [--max-dispatches n] [--poll-seconds s]
        spec: simulated, codex, claude, codex:claude, claude:codex
  add --id <id> --title <t> --acceptance <a> [--after id,id] [--max-attempts n]
  pause | resume               Stop or restart dispatch at the next task boundary
  interrupt                    Stop the running turn now; its task blocks and the queue pauses
  retry <task-id>              Requeue a blocked task after you have reconciled it
  report [--since ISO]         Markdown summary of results, blockers, and usage

All commands accept --state <dir> (default .nightshift).`;

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  state: { type: 'string' }, agents: { type: 'string' }, repo: { type: 'string' },
  'max-dispatches': { type: 'string', default: '20' }, 'poll-seconds': { type: 'string', default: '30' },
  id: { type: 'string' }, title: { type: 'string' }, acceptance: { type: 'string' }, after: { type: 'string' },
  'max-attempts': { type: 'string', default: '2' }, since: { type: 'string' }, help: { type: 'boolean' }
} });
const [command = 'status', argument] = positionals;
// demo and status also accept the state directory positionally, as in earlier versions.
const directory = resolve(values.state ?? ((['demo', 'status'].includes(command) && argument) || '.nightshift'));
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
  if (!values.agents) throw new Error('serve requires --agents.');
  const maxDispatches = Math.floor(positive(values['max-dispatches'], 'max-dispatches'));
  const pollMs = positive(values['poll-seconds'], 'poll-seconds') * 1000;
  const agents = buildAgents(values.agents, values.repo);
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
    const supervisor = new Supervisor(store, agents.worker, agents.reviewer);
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
      await new Promise(done => { wake = done; setTimeout(done, pollMs); });
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

const commands = {
  demo, serve, add,
  status: () => console.log(JSON.stringify(Store.inspect(directory), null, 2)),
  report: () => process.stdout.write(renderReport(Store.inspect(directory), { since: values.since })),
  pause: () => enqueue('pause'),
  resume: () => enqueue('resume'),
  interrupt: () => enqueue('interrupt'),
  retry: () => { if (!argument) throw new Error('retry requires a task ID.'); enqueue('retry', { id: argument }); }
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
