import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

// Project instruction files Nightshift passes to every agent. Agents in Nightshift's
// sandbox do not load them on their own (Claude's restricted mode skips CLAUDE.md, and
// only Codex reads AGENTS.md), so Nightshift collects and injects them itself.
const ruleFiles = ['AGENTS.md', 'CLAUDE.md'];
const localFiles = ['CLAUDE.local.md', 'AGENTS.local.md']; // usually untracked: read from the owner's checkout
const maxChars = 60_000;

const digest = text => createHash('sha256').update(text.replace(/<!--[\s\S]*?-->/g, '').trim()).digest('hex');

// Rules for a repository: its instruction files (from `root`, which may be a worktree of it; one the
// repository keeps untracked is read from the owner's checkout instead), its local files, then instruction
// files in parent folders up to the home folder. Identical texts (for example a generated AGENTS.md and
// CLAUDE.md) are included once.
export function collectRules(repo, { root = repo } = {}) {
  const found = [];
  const add = (path, label) => {
    if (!existsSync(path)) return;
    const text = readFileSync(path, 'utf8');
    if (!text.trim()) return;
    found.push({ path: label, sha256: digest(text), text });
  };
  for (const name of ruleFiles) add(existsSync(join(root, name)) ? join(root, name) : join(repo, name), name);
  for (const name of localFiles) add(join(repo, name), name);
  const home = homedir();
  for (let dir = dirname(resolve(repo)); dir.startsWith(home) && dir !== home; dir = dirname(dir)) {
    for (const name of ruleFiles) add(join(dir, name), join(relative(repo, dir) || '.', name).split(sep).join('/'));
  }
  const seen = new Set();
  const unique = found.filter(rule => !seen.has(rule.sha256) && seen.add(rule.sha256));
  let budget = maxChars;
  return unique.map(rule => {
    const text = rule.text.length > budget ? `${rule.text.slice(0, Math.max(budget, 0))}\n[…truncated by Nightshift]` : rule.text;
    budget -= rule.text.length;
    return { ...rule, text, also: found.filter(other => other.sha256 === rule.sha256 && other.path !== rule.path).map(o => o.path) };
  }).filter(rule => rule.text.trim() !== '[…truncated by Nightshift]');
}

// The block every prompt carries. Nightshift's limits win where they conflict.
export function rulesBlock(rules) {
  if (!rules?.length) return '';
  const files = rules.map(r => [r.path, ...(r.also ?? [])].join(' = ')).join(', ');
  return [
    `Project rules (${files}) apply to your work. They are reproduced below.`,
    'Where they conflict with Nightshift, Nightshift wins: you cannot commit, push, merge, publish, install anything outside this working copy, or use the network.',
    'Do not attempt those steps. If the rules require them (for example "commit and push" or "install the build"), list them under "Left for the owner" in your summary instead.',
    ...rules.map(r => `----- ${r.path} -----\n${r.text.trim()}`),
    '----- end of project rules -----'
  ].join('\n');
}
