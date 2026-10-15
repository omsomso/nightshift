import { relative, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { planSchema, plannerPrompt } from './prompts.js';
import { validatePlan } from './plan.js';
import { collectRules } from './rules.js';
import { validateEffort, plannerEffort } from './effort.js';
import { readConfig } from './home.js';
import { describeBase } from './base.js';

// Drafts a plan from a document with a read-only agent session working in a snapshot of the
// base commit (`root`; defaults to the repository). The document may be uncommitted, so its
// text comes from the owner's checkout. The draft is only a proposal: nothing runs until the
// owner approves it.
export async function draftPlan({ session, repo, root = repo, doc, steps, request, onEvent, base }) {
  const docPath = relative(repo, resolve(repo, doc));
  const absolute = resolve(repo, docPath);
  if (docPath.startsWith('..') || !existsSync(absolute)) throw new Error(`${doc} is not a file inside ${repo}.`);
  const rules = collectRules(repo, { root });
  const raw = await session.run({ prompt: plannerPrompt({ doc: docPath, docText: readFileSync(absolute, 'utf8'), steps, request, rules,
    base: base ? describeBase(base) : null }), outputSchema: planSchema, onEvent, effort: plannerEffort(validateEffort(readConfig().effort)) });
  const id = String(raw.id ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'plan';
  const tasks = (raw.tasks ?? []).map((task, index) => ({ ...task,
    id: String(task.id ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || `step-${index + 1}` }));
  const plan = validatePlan({ ...raw, id, tasks, repo,
    ...(base ? { base: base.commit, baseRef: base.ref, baseBranch: base.branch } : {}) }, repo, `drafted from ${docPath}`);
  return { plan, notes: raw.notes ?? '', rules: rules.map(r => [r.path, ...r.also].join(' = ')),
    ...(base ? { baseInfo: { ref: base.ref, commit: base.commit, branch: base.branch, subject: base.subject, date: base.date, notes: base.notes } } : {}),
    source: { doc: docPath, steps: steps ?? null, request: request ?? null } };
}
