import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { CodexAdapter, CodexReviewer } from './adapters/codex.js';
import { ClaudeAdapter, ClaudeReviewer } from './adapters/claude.js';
import { simulatedAdapter, simulatedReviewer } from './adapters/simulated.js';
import { createAppServer, chatgptEnv } from './codex/session.js';
import { subscriptionEnv } from './claude/session.js';
import { readConfig } from './home.js';
import { ClaudeSession } from './claude/session.js';
import { CodexSession } from './codex/session.js';

const providers = {
  codex: {
    env: 'CODEX', command: 'codex',
    options: (cwd, command, extra) => ({ cwd, model: process.env.NIGHTSHIFT_CODEX_MODEL || undefined,
      createClient: () => createAppServer({ command, cwd }), ...extra }),
    worker: options => new CodexAdapter(options), reviewer: options => new CodexReviewer(options)
  },
  claude: {
    env: 'CLAUDE', command: 'claude',
    options: (cwd, command, extra) => ({ cwd, command, model: process.env.NIGHTSHIFT_CLAUDE_MODEL || undefined,
      maxBudgetUsd: process.env.NIGHTSHIFT_CLAUDE_MAX_BUDGET_USD || (extra.edit ? '10' : '2'), ...extra }),
    worker: options => new ClaudeAdapter(options), reviewer: options => new ClaudeReviewer(options)
  }
};

export function parsePairing(spec) {
  const [worker, reviewer = worker] = (spec ?? '').split(':');
  if (!providers[worker] || !providers[reviewer]) return null;
  return { worker, reviewer, pairing: `${worker}:${reviewer}` };
}

export const providerNames = Object.keys(providers);
export const providerCommand = name => process.env[`NIGHTSHIFT_${providers[name].env}_BIN`] || readConfig().commands?.[name] || providers[name].command;
export const installedVersion = name => execFileSync(providerCommand(name), ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();

// Each provider binary must match the exact version pinned by `setup` (or the environment).
// A CLI update therefore stops Nightshift until someone re-runs setup and accepts it.
export const isDisabled = name => (readConfig().disabledProviders ?? []).includes(name);

// The pairing used when none is given: Claude and Codex together unless one is turned off.
export function defaultAgents() {
  const configured = readConfig().defaultAgents;
  if (configured && !configured.split(':').some(isDisabled)) return configured;
  const enabled = providerNames.filter(name => !isDisabled(name));
  if (!enabled.length) throw new Error('Every provider is turned off. Run `node src/cli.js enable claude` (or codex).');
  return enabled.includes('claude') && enabled.includes('codex') ? 'claude:codex' : enabled[0];
}

function checkedRuntime(name) {
  if (isDisabled(name)) throw new Error(`${name} is turned off in Nightshift. Run \`node src/cli.js enable ${name}\` to use it again.`);
  const { env } = providers[name];
  const command = providerCommand(name);
  const expected = process.env[`NIGHTSHIFT_${env}_VERSION`] || readConfig().pins?.[name];
  if (!expected) throw new Error(`No pinned ${name} version. Run \`node src/cli.js setup\` (or set NIGHTSHIFT_${env}_VERSION).`);
  const actual = execFileSync(command, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
  if (actual !== expected) throw new Error(`${name} version mismatch. Expected ${expected}; found ${actual}. Run \`node src/cli.js setup\` to accept the new version.`);
  return { command, version: actual };
}

// Subscription-only billing: refuse to start unless the CLI, seeing the same stripped
// environment its turns will get, reports a claude.ai sign-in. Records only method and plan.
export function requireSubscription(command) {
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
export function requireChatgpt(command) {
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
// With `edit` ({ worktree, turnMinutes }), both run in the worktree: the worker with
// sandboxed write access, the reviewer read-only.
export function buildAgents(spec, repository, { edit = null } = {}) {
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
  const build = (name, role) => providers[name][role](providers[name].options(edit ? edit.worktree : cwd, runtimes[name].command,
    edit ? { edit: role === 'worker', timeoutMs: edit.turnMinutes * 60_000 } : {}));
  const auth = { ...(runtimes.claude ? { claudeAuth: requireSubscription(runtimes.claude.command) } : {}),
    ...(runtimes.codex ? { codexAuth: requireChatgpt(runtimes.codex.command) } : {}) };
  const label = name => `${name} ${runtimes[name].version} [${auth[`${name}Auth`]}]`;
  return { worker: build(pair.worker, 'worker'), reviewer: build(pair.reviewer, 'reviewer'),
    project: { cwd, pairing: pair.pairing, ...versions, ...auth },
    describe: `worker ${label(pair.worker)}, reviewer ${label(pair.reviewer)}. ` +
      (edit ? `Edit mode in ${edit.worktree}: sandboxed writes, no network.` : 'Read-only policy; model usage may be billed.') };
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

// A read-only session for drafting a plan, with the same version and billing checks.
export function buildPlanner(name, repository) {
  if (!providers[name]) throw new Error(`Unknown provider ${name}. Use claude or codex.`);
  const cwd = gitRoot(repository);
  const runtime = checkedRuntime(name);
  const auth = name === 'claude' ? requireSubscription(runtime.command) : requireChatgpt(runtime.command);
  const options = providers[name].options(cwd, runtime.command, { timeoutMs: 600_000 });
  return { session: name === 'claude' ? new ClaudeSession(options) : new CodexSession(options),
    describe: `${name} ${runtime.version} [${auth}]` };
}
