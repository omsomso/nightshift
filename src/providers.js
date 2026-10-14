import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { CodexAdapter, CodexReviewer } from './adapters/codex.js';
import { ClaudeAdapter, ClaudeReviewer } from './adapters/claude.js';
import { simulatedAdapter, simulatedReviewer } from './adapters/simulated.js';
import { RpcClient } from './codex/rpc-client.js';

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

export function parsePairing(spec) {
  const [worker, reviewer = worker] = (spec ?? '').split(':');
  if (!providers[worker] || !providers[reviewer]) return null;
  return { worker, reviewer, pairing: `${worker}:${reviewer}` };
}

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

// Which account pays, for the record. Keeps only the method and plan; never email or org.
// The stream's apiKeySource reports "none" for subscription sign-ins (observed with 2.1.296).
function claudeAuth(command) {
  try {
    const status = JSON.parse(execFileSync(command, ['auth', 'status'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }));
    if (!status.loggedIn) return 'not signed in';
    return [status.authMethod, status.subscriptionType].filter(Boolean).join(' ') || 'unknown';
  } catch { return 'unknown'; }
}

export function gitRoot(repository) {
  const cwd = realpathSync(resolve(repository));
  execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'pipe'] });
  return cwd;
}

// Builds a version-checked worker/reviewer pair. `project` describes what state must match.
export function buildAgents(spec, repository) {
  if (spec === 'simulated') {
    return { worker: simulatedAdapter, reviewer: simulatedReviewer,
      project: { pairing: 'simulated', ...(repository ? { cwd: gitRoot(repository) } : {}) },
      describe: 'SIMULATED worker and reviewer; no model is called.' };
  }
  const pair = parsePairing(spec);
  if (!pair) throw new Error(`Unknown agents "${spec}". Use simulated, codex, claude, or worker:reviewer.`);
  if (!repository) throw new Error('A repository path is required for live agents.');
  const cwd = gitRoot(repository);
  const runtimes = Object.fromEntries([...new Set([pair.worker, pair.reviewer])].map(name => [name, checkedRuntime(name)]));
  const versions = Object.fromEntries(Object.entries(runtimes).map(([name, { version }]) => [`${name}Version`, version]));
  const build = (name, role) => providers[name][role](providers[name].options(cwd, runtimes[name].command));
  const auth = runtimes.claude ? { claudeAuth: claudeAuth(runtimes.claude.command) } : {};
  const label = name => `${name} ${runtimes[name].version}${name === 'claude' ? ` [${auth.claudeAuth}]` : ''}`;
  return { worker: build(pair.worker, 'worker'), reviewer: build(pair.reviewer, 'reviewer'),
    project: { cwd, pairing: pair.pairing, ...versions, ...auth },
    describe: `worker ${label(pair.worker)}, reviewer ${label(pair.reviewer)}. Read-only policy; model usage may be billed.` };
}

// State is tied to one repository, pairing, and set of pinned versions.
export function checkProject(existing, project) {
  if (!existing) return;
  if (existing.cwd !== project.cwd) throw new Error('This state directory belongs to a different repository. Choose a new state directory.');
  // State from before provider pairing existed was always Codex-only.
  const pairing = existing.pairing ?? 'codex:codex';
  if (pairing !== project.pairing) throw new Error(`This state was created for ${pairing}. Choose a new state directory.`);
  for (const [key, version] of Object.entries(project)) {
    if (key.endsWith('Version') && existing[key] !== version) {
      throw new Error(`This state was created with a different ${key.replace('Version', '')} version. Reconcile it before migrating.`);
    }
  }
}
