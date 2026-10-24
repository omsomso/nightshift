import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Installs the `nightshift` command and the Nightshift skill for the current user, so any
// terminal or agent session can find them. Only files Nightshift wrote are ever replaced.
const marker = 'Installed by Nightshift setup';
const skillSource = fileURLToPath(new URL('../skill/SKILL.md', import.meta.url));
const root = () => process.env.NIGHTSHIFT_INSTALL_ROOT || homedir();

function place(path, content, mode) {
  if (existsSync(path)) {
    const current = readFileSync(path, 'utf8');
    if (current === content) return 'unchanged';
    if (!current.includes(marker)) return 'skipped (a file Nightshift did not write is already there)';
  }
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, { mode });
  if (mode) chmodSync(path, mode);
  return 'installed';
}

const real = path => { try { return realpathSync(path); } catch { return resolve(path); } };

// The command and the skill are shared by every terminal and agent session, so a test or demo
// home, or a temporary copy of Nightshift, must never take them over: that once pointed the
// command at a copy that was deleted soon after. An explicit NIGHTSHIFT_INSTALL_ROOT wins.
export function installBlocked(cli) {
  if (process.env.NIGHTSHIFT_INSTALL_ROOT) return null;
  if (process.env.NIGHTSHIFT_HOME && real(process.env.NIGHTSHIFT_HOME) !== real(join(homedir(), '.nightshift'))) {
    return 'NIGHTSHIFT_HOME points to a separate home, such as a test or demo';
  }
  const where = real(cli);
  if ([tmpdir(), '/tmp', '/var/folders'].map(real).some(dir => where.startsWith(`${dir}/`))) return 'this copy of Nightshift is in a temporary folder';
  return null;
}

export function installIntegration({ node, cli }) {
  const blocked = installBlocked(cli);
  if (blocked) {
    return [[join(root(), '.local', 'bin', 'nightshift'), `skipped (${blocked}; the installed command and skill are left as they are)`]];
  }
  const results = [];
  const command = `#!/bin/sh\n# ${marker}. Re-run \`nightshift setup\` after moving Nightshift.\nexec "${node}" "${cli}" "$@"\n`;
  const bin = join(root(), '.local', 'bin', 'nightshift');
  results.push([bin, place(bin, command, 0o755)]);
  // The marker goes after the front matter, which must stay first.
  const skill = readFileSync(skillSource, 'utf8').replace(/^(---\n[\s\S]*?\n---\n)/, `$1<!-- ${marker}; edit skill/SKILL.md in the Nightshift repository. -->\n`);
  for (const tool of ['.claude', '.codex']) {
    if (!existsSync(join(root(), tool))) continue;
    const path = join(root(), tool, 'skills', 'nightshift', 'SKILL.md');
    results.push([path, place(path, skill)]);
  }
  return results;
}
