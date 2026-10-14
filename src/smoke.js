import { resolve } from 'node:path';
import { Store } from './store.js';
import { Supervisor } from './supervisor.js';
import { buildAgents, parsePairing, checkProject } from './providers.js';

const usage = 'Usage: node src/smoke.js <codex|claude>[:<codex|claude>] /absolute/path/to/repository [state-directory]';

let store;
try {
  const [spec, repository, stateArg] = process.argv.slice(2);
  const pair = parsePairing(spec);
  if (!pair || !repository) throw new Error(usage);
  const agents = buildAgents(spec, repository);
  const defaultState = pair.worker === pair.reviewer ? `${pair.worker}-smoke` : `${pair.worker}-${pair.reviewer}-smoke`;
  store = new Store(resolve(stateArg ?? `.nightshift/${defaultState}`));
  store.acquire();
  checkProject(store.read().project, agents.project);
  const supervisor = new Supervisor(store, agents.worker, agents.reviewer);
  supervisor.state.project = agents.project;
  store.save(supervisor.state);
  if (!supervisor.snapshot().tasks.length) {
    supervisor.add({ id: 'inspect-project', title: 'Describe this repository and its development workflow',
      acceptance: 'Identify the project purpose, key source directories, and documented build/test commands. Cite actual file paths. Clearly identify missing documentation or unavailable checks.', maxAttempts: 2 });
  }
  console.log(`Nightshift compatibility check: ${agents.describe}`);
  await supervisor.run({ maxDispatches: 2 });
  const state = supervisor.snapshot();
  console.log(JSON.stringify({ project: state.project, tasks: state.tasks }, null, 2));
  if (!state.tasks.every(task => task.status === 'done')) process.exitCode = 2;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { store?.release(); }
