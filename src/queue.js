import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { home, planDir, listPlanIds } from './home.js';
import { Store } from './store.js';

// Plans that run one after another, for example overnight. When the plan that is running
// stops for the owner (ready to merge, blocked, or paused), its runner starts the next one.
// A usage-limit wait is not a stop: the next plan would hit the same limit.
const file = () => join(home(), 'queue.json');
const lockDir = () => join(home(), 'queue.lock');

export function readQueue() {
  try { return JSON.parse(readFileSync(file(), 'utf8')).plans ?? []; }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function writeQueue(plans) {
  mkdirSync(home(), { recursive: true });
  const temporary = `${file()}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ plans }, null, 2) + '\n');
  renameSync(temporary, file());
}

// A short exclusive section, so two runners finishing together cannot start the same plan.
async function locked(work) {
  mkdirSync(home(), { recursive: true });
  for (let tries = 0; ; tries += 1) {
    try { mkdirSync(lockDir()); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (tries > 100) rmSync(lockDir(), { recursive: true, force: true }); // A stale lock from a crashed process.
      await new Promise(done => setTimeout(done, 50));
    }
  }
  try { return await work(); } finally { rmSync(lockDir(), { recursive: true, force: true }); }
}

export async function enqueuePlan(id) {
  if (!existsSync(planDir(id))) throw new Error(`No plan or draft named ${id}.`);
  return locked(() => {
    const plans = readQueue().filter(p => p !== id);
    plans.push(id);
    writeQueue(plans);
    return plans;
  });
}

export async function dequeuePlan(id) {
  return locked(() => { const plans = readQueue().filter(p => p !== id); writeQueue(plans); return plans; });
}

export async function moveInQueue(id, offset) {
  return locked(() => {
    const plans = readQueue();
    const from = plans.indexOf(id);
    if (from < 0) throw new Error(`${id} is not queued.`);
    const to = Math.max(0, Math.min(plans.length - 1, from + offset));
    plans.splice(to, 0, ...plans.splice(from, 1));
    writeQueue(plans);
    return plans;
  });
}

// True while a plan can still make progress by itself (including a usage-limit wait).
export function isActive(state) {
  const plan = state.plan;
  if (!plan || plan.status !== 'running') return false;
  if (state.waitUntil) return true;
  if (state.paused) return false;
  const done = id => state.tasks.some(t => t.id === id && t.status === 'done');
  const runnable = state.tasks.some(t => ['running', 'review'].includes(t.status) || (t.status === 'ready' && t.dependencies.every(done)));
  return runnable || state.tasks.every(t => t.status === 'done'); // the final phase is still to run
}

// Is any plan's runner working right now?
export function anyActive({ except } = {}) {
  return listPlanIds().some(id => {
    if (id === except) return false;
    try { const state = Store.inspect(planDir(id)); return state.runner?.alive && isActive(state); } catch { return false; }
  });
}

// Starts the next queued plan if nothing else is working. `start` is startPlan (passed in
// to keep this module free of the runner code). Returns the started id, or null.
export async function advanceQueue(start, { except } = {}) {
  return locked(async () => {
    if (anyActive({ except })) return null;
    const plans = readQueue();
    while (plans.length) {
      const id = plans.shift();
      writeQueue(plans);
      if (!existsSync(planDir(id))) continue; // Deleted while queued.
      await start(id);
      return id;
    }
    return null;
  });
}
