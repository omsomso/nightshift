import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// One home for everything Nightshift keeps outside repositories: the recorded CLI
// versions and one state directory per plan. The app reads the same place.
export const home = () => process.env.NIGHTSHIFT_HOME || join(homedir(), '.nightshift');
export const plansDir = () => join(home(), 'plans');
export const planDir = id => join(plansDir(), id);
const configFile = () => join(home(), 'config.json');

export function readConfig() {
  try { return JSON.parse(readFileSync(configFile(), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

export function writeConfig(config) {
  mkdirSync(home(), { recursive: true });
  const temporary = `${configFile()}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, configFile());
}

export function listPlanIds() {
  if (!existsSync(plansDir())) return [];
  return readdirSync(plansDir(), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
}

// A free plan id based on the suggested one: math, math-2, math-3, ...
export function freePlanId(suggested) {
  const taken = new Set(listPlanIds());
  if (!taken.has(suggested)) return suggested;
  for (let n = 2; ; n += 1) if (!taken.has(`${suggested}-${n}`)) return `${suggested}-${n}`;
}
