// How much reasoning effort each agent turn gets. Nightshift decides, deterministically:
// - the planner rates each task's difficulty; that sets the worker's starting effort;
// - every retry of a task goes one level higher (a failure means it was harder than rated);
// - reviewers and the planner run at fixed levels, so a low rating never weakens a check;
// - everything stays within the owner's bounds (min/max).
export const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
export const difficulties = ['low', 'medium', 'high'];
export const defaultEffort = { min: 'medium', max: 'xhigh', reviewer: 'high', planner: 'high' };

const index = level => levels.indexOf(level);

export function validateEffort(effort = {}, label = 'effort') {
  const merged = { ...defaultEffort, ...effort };
  for (const [key, value] of Object.entries(merged)) {
    if (!(key in defaultEffort)) throw new Error(`Unknown ${label} setting ${key}; use min, max, reviewer, or planner.`);
    if (!levels.includes(value)) throw new Error(`${label} ${key} must be one of ${levels.join(', ')}.`);
  }
  if (index(merged.min) > index(merged.max)) throw new Error(`${label} min (${merged.min}) is above max (${merged.max}).`);
  return merged;
}

export const clamp = (level, { min, max }) => levels[Math.min(Math.max(index(level), index(min)), index(max))];

// Attempt 1 at the rated difficulty, one level higher per retry, within bounds.
export function workerEffort(task, settings) {
  const base = index(task.difficulty && difficulties.includes(task.difficulty) ? task.difficulty : 'medium');
  const raised = Math.min(base + Math.max(0, (task.attempts ?? 1) - 1), levels.length - 1);
  return clamp(levels[raised], settings);
}

export const reviewerEffort = settings => clamp(settings.reviewer, settings);
export const plannerEffort = settings => settings.planner;

// Codex accepts model-specific effort names; low/medium/high are the common ones.
export const codexEffort = level => ({ low: 'low', medium: 'medium' })[level] ?? 'high';
