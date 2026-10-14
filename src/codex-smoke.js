import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from './store.js';
import { Supervisor } from './supervisor.js';
import { CodexAdapter, CodexReviewer } from './adapters/codex.js';
import { RpcClient } from './codex/rpc-client.js';

let store;
try {
  if (!process.argv[2]) throw new Error('Usage: npm run codex:smoke -- /absolute/path/to/repository [state-directory]');
  const cwd = realpathSync(resolve(process.argv[2]));
  execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const command = process.env.NIGHTSHIFT_CODEX_BIN || 'codex';
  const expectedVersion = process.env.NIGHTSHIFT_CODEX_VERSION;
  if (!expectedVersion) throw new Error('Set NIGHTSHIFT_CODEX_VERSION to the exact output of your installed codex --version.');
  const actualVersion = execFileSync(command, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
  if (actualVersion !== expectedVersion) throw new Error(`Codex version mismatch. Expected ${expectedVersion}; found ${actualVersion}.`);
  const options = { cwd, model: process.env.NIGHTSHIFT_CODEX_MODEL || undefined,
    createClient: () => new RpcClient({ command, cwd }) };
  store = new Store(resolve(process.argv[3] ?? '.nightshift/codex-smoke'));
  store.acquire();
  const existing = store.read();
  if (existing.project && existing.project.cwd !== cwd) {
    throw new Error('This state directory belongs to a different repository. Choose a new state directory.');
  }
  if (existing.project && existing.project.codexVersion !== actualVersion) {
    throw new Error('This state was created with a different Codex version. Reconcile it before migrating.');
  }
  const supervisor = new Supervisor(store, new CodexAdapter(options), new CodexReviewer(options));
  supervisor.state.project = { cwd, codexVersion: actualVersion };
  store.save(supervisor.state);
  if (!supervisor.snapshot().tasks.length) {
    supervisor.add({ id: 'inspect-project', title: 'Describe this repository and its development workflow',
      acceptance: 'Identify the project purpose, key source directories, and documented build/test commands. Cite actual file paths. Clearly identify missing documentation or unavailable checks.', maxAttempts: 2 });
  }
  console.log(`Nightshift compatibility check: ${actualVersion}. Read-only filesystem policy; model usage may be billed.`);
  await supervisor.run({ maxDispatches: 2 });
  const state = supervisor.snapshot();
  console.log(JSON.stringify({ project: state.project, tasks: state.tasks }, null, 2));
  if (!state.tasks.every(task => task.status === 'done')) process.exitCode = 2;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { store?.release(); }
