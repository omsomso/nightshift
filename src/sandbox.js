import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readConfig } from './home.js';

// Project checks (tests, builds) run under macOS's sandbox: they may write only inside the
// plan's worktree, its git metadata, a private temp folder, and the usual tool caches, and
// by default may not reach the network. A build step that writes elsewhere (for example into
// the owner's checkout) fails instead of changing it. Settings: `sandboxChecks` (default on),
// `checkNetwork` (default off), `checkWritablePaths` (extra folders).
const sandboxExec = '/usr/bin/sandbox-exec';
export const sandboxAvailable = () => process.platform === 'darwin' && existsSync(sandboxExec);

const real = path => { try { return realpathSync(path); } catch { return resolve(path); } };
const quote = path => `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const userDir = name => { try { return execFileSync('/usr/bin/getconf', [name], { encoding: 'utf8' }).trim(); } catch { return null; } };

export function checkSettings(config = readConfig()) {
  return { sandbox: config.sandboxChecks !== false && sandboxAvailable(), network: config.checkNetwork === true,
    extra: Array.isArray(config.checkWritablePaths) ? config.checkWritablePaths : [] };
}

export function profile({ worktree, tmp, network = false, extra = [] }) {
  const home = homedir();
  let gitDir = null;
  try { gitDir = execFileSync('git', ['-C', worktree, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  const writable = [worktree, gitDir, tmp, '/private/tmp', userDir('DARWIN_USER_CACHE_DIR'),
    join(home, 'Library/Caches'), join(home, '.cache'), join(home, '.npm'), ...extra]
    .filter(Boolean).map(path => real(path.replace(/^~(?=\/|$)/, home)));
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${[...new Set(writable)].map(path => `(subpath ${quote(path)})`).join(' ')}`,
    '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/") (regex #"^/dev/tty"))',
    ...(network ? [] : ['(deny network-outbound (remote ip))'])
  ].join('\n');
}

// The command line for one check: sandboxed when enabled, with TMPDIR pointed at a private
// folder inside the allowed set.
export function checkCommand(command, { worktree, tmpRoot }) {
  const settings = checkSettings();
  if (!settings.sandbox) return { file: '/bin/sh', args: ['-c', command], env: process.env, sandboxed: false };
  const tmp = join(tmpRoot, 'tmp');
  mkdirSync(tmp, { recursive: true });
  return { file: sandboxExec, args: ['-p', profile({ worktree, tmp, network: settings.network, extra: settings.extra }), '/bin/sh', '-c', command],
    env: { ...process.env, TMPDIR: `${real(tmp)}/` }, sandboxed: true };
}

// Explains a failure the sandbox probably caused.
export const sandboxHint = output => /Operation not permitted|sandbox|deny\(\d+\)|Could not resolve host|getaddrinfo|ENOTFOUND|EPERM/i.test(output)
  ? '\n[Nightshift: this check runs in a sandbox: it may write only inside the worktree and has no network. If the project really needs more, change "Run checks in a sandbox" in Settings › Runs.]'
  : '';
