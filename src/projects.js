import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from './home.js';

// Where the owner's projects live. Defaults to the folder that contains Nightshift itself
// (for example ~/CodexProjects); \`nightshift workspaces add <path>\` adds more.
export function workspaceRoots() {
  const configured = readConfig().workspaces;
  if (configured?.length) return configured;
  return [dirname(resolve(fileURLToPath(new URL('..', import.meta.url))))];
}

const isRepo = dir => existsSync(join(dir, '.git'));

// One line describing a project: the first prose line of its README.
function describe(dir) {
  try {
    const line = readFileSync(join(dir, 'README.md'), 'utf8').split('\n')
      .map(l => l.trim()).find(l => l && !l.startsWith('#') && !l.startsWith('<!--') && !l.startsWith('!['));
    return line ? line.slice(0, 160) : '';
  } catch { return ''; }
}

// Git repositories directly inside each workspace root (and the root itself if it is one).
export function listProjects(roots = workspaceRoots()) {
  const projects = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    if (isRepo(root)) projects.push({ name: root.split('/').pop(), path: root, description: describe(root) });
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = join(root, entry.name);
      if (isRepo(dir)) projects.push({ name: entry.name, path: dir, description: describe(dir),
        rules: ['AGENTS.md', 'CLAUDE.md'].some(f => existsSync(join(dir, f))) });
    }
  }
  return projects;
}
