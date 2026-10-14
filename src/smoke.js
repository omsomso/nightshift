import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from './store.js';
import { Supervisor } from './supervisor.js';
import { CodexAdapter, CodexReviewer } from './adapters/codex.js';
import { ClaudeAdapter, ClaudeReviewer } from './adapters/claude.js';
import { RpcClient } from './codex/rpc-client.js';

const usage = 'Usage: node src/smoke.js <codex|claude>[:<codex|claude>] /absolute/path/to/repository [state-directory]';
const providers = {
  codex: {
    env: 'CODEX', command: 'codex',
    options: (cwd, command) => ({ cwd, model: process.env.NIGHTSHIFT_CODEX_MODEL || undefined,
      createClient: () => new RpcClient({ command, cwd }) }),
    worker: options => new CodexAdapter(options), reviewer: options => new CodexReviewer(options)
  },
  claude: {
    env: 'CLAUDE', command: 'claude',
    options: (cwd, command) => ({ cwd, command, model: process.env.NIGHTSHIFT_CLAUDE_MODEL || undefined,
      maxBudgetUsd: process.env.NIGHTSHIFT_CLAUDE_MAX_BUDGET_USD || '2' }),
    worker: options => new ClaudeAdapter(options), reviewer: options => new ClaudeReviewer(options)
  }
};

// Each provider binary must match the operator's exact pinned version string.
function checkedRuntime(name) {
  const { env, command: fallback } = providers[name];
  const command = process.env[`NIGHTSHIFT_${env}_BIN`] || fallback;
  const expected = process.env[`NIGHTSHIFT_${env}_VERSION`];
  if (!expected) throw new Error(`Set NIGHTSHIFT_${env}_VERSION to the exact output of your installed ${fallback} --version.`);
  const actual = execFileSync(command, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
  if (actual !== expected) throw new Error(`${name} version mismatch. Expected ${expected}; found ${actual}.`);
  return { command, version: actual };
}

let store;
try {
  const [pairArg, repository, stateArg] = process.argv.slice(2);
  const [workerName, reviewerName = workerName] = (pairArg ?? '').split(':');
  if (!providers[workerName] || !providers[reviewerName] || !repository) throw new Error(usage);
  const pairing = `${workerName}:${reviewerName}`;
  const cwd = realpathSync(resolve(repository));
  execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const runtimes = Object.fromEntries([...new Set([workerName, reviewerName])].map(name => [name, checkedRuntime(name)]));
  const versions = Object.fromEntries(Object.entries(runtimes).map(([name, { version }]) => [`${name}Version`, version]));
  const build = (name, role) => providers[name][role](providers[name].options(cwd, runtimes[name].command));

  const defaultState = workerName === reviewerName ? `${workerName}-smoke` : `${workerName}-${reviewerName}-smoke`;
  store = new Store(resolve(stateArg ?? `.nightshift/${defaultState}`));
  store.acquire();
  const existing = store.read();
  if (existing.project) {
    if (existing.project.cwd !== cwd) throw new Error('This state directory belongs to a different repository. Choose a new state directory.');
    // State from before provider pairing existed was always Codex-only.
    if ((existing.project.pairing ?? 'codex:codex') !== pairing) {
      throw new Error(`This state was created for ${existing.project.pairing ?? 'codex:codex'}. Choose a new state directory.`);
    }
    for (const [key, version] of Object.entries(versions)) {
      if (existing.project[key] !== version) throw new Error(`This state was created with a different ${key.replace('Version', '')} version. Reconcile it before migrating.`);
    }
  }
  const supervisor = new Supervisor(store, build(workerName, 'worker'), build(reviewerName, 'reviewer'));
  supervisor.state.project = { cwd, pairing, ...versions };
  store.save(supervisor.state);
  if (!supervisor.snapshot().tasks.length) {
    supervisor.add({ id: 'inspect-project', title: 'Describe this repository and its development workflow',
      acceptance: 'Identify the project purpose, key source directories, and documented build/test commands. Cite actual file paths. Clearly identify missing documentation or unavailable checks.', maxAttempts: 2 });
  }
  const describe = name => `${name} ${runtimes[name].version}`;
  console.log(`Nightshift compatibility check: worker ${describe(workerName)}, reviewer ${describe(reviewerName)}. ` +
    'Read-only policy; model usage may be billed.');
  await supervisor.run({ maxDispatches: 2 });
  const state = supervisor.snapshot();
  console.log(JSON.stringify({ project: state.project, tasks: state.tasks }, null, 2));
  if (!state.tasks.every(task => task.status === 'done')) process.exitCode = 2;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { store?.release(); }
