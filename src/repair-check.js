// Live check of the repair loop. The real reviewer runs, but its first decision is
// replaced by a labelled forced failure with one concrete extra requirement. Attempt 2
// must resume the saved worker and reviewer sessions and address that requirement.
// A verification harness, not part of normal supervision. Uses provider plan usage.
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from './store.js';
import { Supervisor } from './supervisor.js';
import { buildAgents, parsePairing } from './providers.js';

let store;
try {
  const [spec, repository, stateArg] = process.argv.slice(2);
  const pair = parsePairing(spec);
  if (!pair || !repository) throw new Error('Usage: node src/repair-check.js <codex|claude>[:<codex|claude>] /path/to/repository [state-directory]');
  const agents = buildAgents(spec, repository);
  const directory = resolve(stateArg ?? `.nightshift/repair-check-${pair.worker}-${pair.reviewer}`);
  rmSync(directory, { recursive: true, force: true }); // Always a fresh, disposable state.
  let reviews = 0;
  const reviewer = { async review(task, result, context) {
    const real = await agents.reviewer.review(task, result, context);
    if (++reviews > 1) return real;
    return { passed: false, reason: `[FORCED FAILURE FOR RESUME TEST; real verdict passed=${real.passed}] ` +
      'Also name the file that defines the supervisor state machine and quote the name of one method in it.' };
  } };
  store = new Store(directory);
  store.acquire();
  const supervisor = new Supervisor(store, agents.worker, reviewer);
  supervisor.state.project = { ...agents.project, harness: 'repair-check' };
  supervisor.add({ id: 'list-top-level', title: 'Describe the top-level layout of this repository',
    acceptance: 'Name each top-level file and directory and say in one line what it holds. Cite paths.', maxAttempts: 2 });
  console.log(`Nightshift repair check: ${agents.describe}`);
  await supervisor.run({ maxDispatches: 2 });
  const state = supervisor.snapshot();
  const task = state.tasks[0];
  const opened = role => state.events.filter(e => e.type === 'provider:session' && e.detail.role === role).map(e => e.detail.threadId);
  const resumed = role => opened(role).length === 2 && opened(role)[0] === opened(role)[1];
  const checks = { forcedFailureApplied: reviews >= 1, secondAttemptRan: task.attempts === 2,
    workerResumed: resumed('worker'), reviewerResumed: resumed('reviewer'), passed: task.status === 'done' };
  console.log(JSON.stringify({ checks, status: task.status, reason: task.reason, sessions: task.sessions }, null, 2));
  if (!Object.values(checks).every(Boolean)) process.exitCode = 2;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { store?.release(); }
