import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { CodexAdapter, CodexReviewer } from './adapters/codex.js';
import { ClaudeAdapter, ClaudeReviewer } from './adapters/claude.js';
import { simulatedAdapter, simulatedReviewer } from './adapters/simulated.js';
import { createAppServer, chatgptEnv } from './codex/session.js';
import { subscriptionEnv } from './claude/session.js';

const providers = {
  codex: {
    env: 'CODEX', command: 'codex',
    options: (cwd, command) => ({ cwd, model: process.env.NIGHTSHIFT_CODEX_MODEL || undefined,
      createClient: () => createAppServer({ command, cwd }) }),
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

// Subscription-only billing: refuse to start unless the CLI, seeing the same stripped
// environment its turns will get, reports a claude.ai sign-in. Records only method and plan.
function requireSubscription(command) {
  let text;
  try {
    text = execFileSync(command, ['auth', 'status'], { encoding: 'utf8', timeout: 10_000,
      env: subscriptionEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) { text = error.stdout; } // A signed-out CLI may exit non-zero but still print status.
  let status;
  try { status = JSON.parse(text); }
  catch { throw new Error('Could not read `claude auth status`; refusing to run without a confirmed subscription sign-in.'); }
  if (!status.loggedIn) throw new Error('The Claude CLI is not signed in. Run `claude auth login` with your claude.ai account.');
  if (status.authMethod !== 'claude.ai') {
    throw new Error(`The Claude CLI is signed in with ${status.authMethod ?? 'an unknown method'}, not a claude.ai subscription. ` +
      'Nightshift refuses pay-per-token billing; run `claude auth login` with your claude.ai account.');
  }
  return [status.authMethod, status.subscriptionType].filter(Boolean).join(' ');
}

// ChatGPT-plan-only billing for Codex, checked with the same stripped environment its
// sessions get. The status line is never echoed: an API-key line includes part of the key.
function requireChatgpt(command) {
  const result = spawnSync(command, ['login', 'status'], { encoding: 'utf8', timeout: 10_000, env: chatgptEnv() });
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (/Logged in using ChatGPT/.test(text)) return 'chatgpt';
  if (/Not logged in/i.test(text)) throw new Error('Codex is not signed in. Run `codex login` with your ChatGPT account.');
  throw new Error('Codex is not signed in with ChatGPT. Nightshift refuses API-key billing; run `codex login` with your ChatGPT account.');
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
  const auth = { ...(runtimes.claude ? { claudeAuth: requireSubscription(runtimes.claude.command) } : {}),
    ...(runtimes.codex ? { codexAuth: requireChatgpt(runtimes.codex.command) } : {}) };
  const label = name => `${name} ${runtimes[name].version} [${auth[`${name}Auth`]}]`;
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
