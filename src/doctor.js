import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from './home.js';
import { workspaceRoots } from './projects.js';
import { sandboxAvailable } from './sandbox.js';

// What a Mac needs for Nightshift, checked without changing anything: required pieces fail
// the check, optional ones explain what they add. For someone setting up their own copy.
const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 20_000 });
  return result.status === 0 ? (result.stdout || result.stderr).trim() : null;
};
const onPath = command => run('/bin/sh', ['-c', `command -v ${command}`]);

export function doctor() {
  const checks = [];
  const add = (level, name, detail, fix) => checks.push({ level, name, detail, ...(fix ? { fix } : {}) });

  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 13)) add('ok', 'Node.js', process.versions.node);
  else add('fail', 'Node.js', `${process.versions.node}; Nightshift needs 22.13 or newer`, 'Install a current Node.js, for example with Homebrew: brew install node');

  const git = run('git', ['--version']);
  if (git) add('ok', 'Git', git.replace(/^git version /, ''));
  else add('fail', 'Git', 'not found', 'Install the Xcode Command Line Tools: xcode-select --install');

  if (process.platform === 'darwin') add('ok', 'macOS', run('sw_vers', ['-productVersion']) ?? 'yes');
  else add('warn', 'Operating system', `${process.platform}: the CLI works, but the app, sandboxed checks, and autostart need macOS`);

  const claude = onPath('claude');
  const codex = onPath('codex');
  if (!claude && !codex) add('fail', 'Agents', 'neither the Claude Code CLI nor the Codex CLI is installed', 'Install Claude Code (https://claude.com/claude-code) and sign in with a Claude subscription.');
  if (claude) {
    const status = run(claude, ['auth', 'status', '--json']);
    let auth = null;
    try { auth = JSON.parse(status); } catch {}
    if (auth?.loggedIn && auth.authMethod === 'claude.ai') add('ok', 'Claude Code', `${run(claude, ['--version']) ?? ''}, signed in with ${auth.subscriptionType ?? 'a'} subscription`);
    else add('fail', 'Claude Code', 'installed but not signed in with a claude.ai subscription (API keys are refused by design)', 'Run: claude auth login');
  } else add('warn', 'Claude Code', 'not installed; Codex would do all the work', 'Install it from https://claude.com/claude-code');
  if (codex) {
    const login = spawnSync(codex, ['login', 'status'], { encoding: 'utf8', timeout: 20_000 });
    const text = `${login.stdout}${login.stderr}`;
    add(/ChatGPT/i.test(text) ? 'ok' : 'warn', 'Codex CLI', /ChatGPT/i.test(text) ? 'signed in with ChatGPT' : 'installed but not signed in with ChatGPT', /ChatGPT/i.test(text) ? null : 'Run: codex login');
  } else add('info', 'Codex CLI', 'not installed (optional: a second model as reviewer)');

  const config = readConfig();
  if (config.pins && Object.keys(config.pins).length) add('ok', 'Setup', `pinned ${Object.values(config.pins).map(v => v.replace(/\s*\(.*\)$/, '')).join(', ')}`);
  else add('fail', 'Setup', 'not run yet', 'From the Nightshift folder: node src/cli.js setup');
  const bin = join(homedir(), '.local', 'bin');
  if (existsSync(join(bin, 'nightshift'))) {
    add((process.env.PATH ?? '').split(':').includes(bin) ? 'ok' : 'warn', 'nightshift command', (process.env.PATH ?? '').split(':').includes(bin) ? join(bin, 'nightshift') : `${join(bin, 'nightshift')} exists, but ${bin} is not on your PATH`,
      (process.env.PATH ?? '').split(':').includes(bin) ? null : `Add to your shell profile: export PATH="$HOME/.local/bin:$PATH"`);
  } else add('warn', 'nightshift command', 'not installed', 'Run setup; until then use node src/cli.js');

  add('info', 'Workspaces', `projects are looked for in ${workspaceRoots().join(', ')}`, 'Change with: nightshift workspaces set <folder>');

  const swift = run('xcrun', ['swift', '--version']) ?? run('swift', ['--version']);
  add(swift ? 'ok' : 'warn', 'Swift (for the app)', swift ? swift.split('\n')[0].replace(/^.*Swift version /, 'Swift ') : 'not found; the CLI works without the app', swift ? null : 'Install Xcode (or the Command Line Tools), then: app/build.sh');
  add(sandboxAvailable() ? 'ok' : 'warn', 'Check sandbox', sandboxAvailable() ? 'sandbox-exec available' : 'not available; project checks run unsandboxed');
  const gh = onPath('gh');
  if (gh) add(run(gh, ['auth', 'status']) !== null ? 'ok' : 'warn', 'GitHub CLI', run(gh, ['auth', 'status']) !== null ? 'signed in (pull requests available)' : 'installed but not signed in', run(gh, ['auth', 'status']) !== null ? null : 'Run: gh auth login');
  else add('info', 'GitHub CLI', 'not installed (optional: approve plans as pull requests)');

  return { ok: !checks.some(c => c.level === 'fail'), checks };
}
