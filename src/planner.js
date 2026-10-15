import { relative, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { planSchema, plannerPrompt } from './prompts.js';
import { validatePlan } from './plan.js';
import { collectRules } from './rules.js';
import { validateEffort, plannerEffort } from './effort.js';
import { readConfig } from './home.js';

// Drafts a plan from a document in the repository with a read-only agent session.
// The draft is only a proposal: nothing runs until the owner approves it.
export async function draftPlan({ session, repo, doc, steps, request, onEvent }) {
  const docPath = relative(repo, resolve(repo, doc));
  if (docPath.startsWith('..') || !existsSync(resolve(repo, docPath))) throw new Error(`${doc} is not a file inside ${repo}.`);
  const rules = collectRules(repo);
  const raw = await session.run({ prompt: plannerPrompt({ doc: docPath, steps, request, rules }), outputSchema: planSchema, onEvent,
    effort: plannerEffort(validateEffort(readConfig().effort)) });
  const id = String(raw.id ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'plan';
  const tasks = (raw.tasks ?? []).map((task, index) => ({ ...task,
    id: String(task.id ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || `step-${index + 1}` }));
  const plan = validatePlan({ ...raw, id, tasks, repo }, repo, `drafted from ${docPath}`);
  return { plan, notes: raw.notes ?? '', rules: rules.map(r => [r.path, ...r.also].join(' = ')),
    source: { doc: docPath, steps: steps ?? null, request: request ?? null } };
}
