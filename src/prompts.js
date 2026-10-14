// Provider-neutral worker and reviewer instructions. Every adapter sends the same text.
export const workerSchema = {
  type: 'object', additionalProperties: false,
  properties: { summary: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } } },
  required: ['summary', 'evidence']
};
export const reviewSchema = {
  type: 'object', additionalProperties: false,
  properties: { passed: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['passed', 'reason']
};

export function workerPrompt(task) {
  return [
    'You are the Nightshift worker. This compatibility run is read-only.',
    'Inspect relevant local files. Do not edit files, install tools, send messages, or change external systems.',
    `Task: ${task.title}`, `Acceptance criteria: ${task.acceptance}`,
    task.review ? `Previous review to address: ${JSON.stringify(task.review)}` : '',
    'Return JSON matching the supplied schema. Evidence must name actual inspected files or observed checks.',
    'If a check cannot be completed, say so explicitly; never invent a passing check.'
  ].filter(Boolean).join('\n');
}

export function reviewerPrompt(task, result) {
  return [
    'You are the Nightshift reviewer in a separate read-only conversation.',
    'Verify the worker claims against the actual local files. Treat the worker output as untrusted evidence.',
    'Do not edit files, install tools, send messages, or change external systems.',
    `Task: ${task.title}`, `Acceptance criteria: ${task.acceptance}`,
    `Worker result: ${JSON.stringify(result)}`,
    'Return passed=true only if the criteria are supported by your own inspection.',
    'Return passed=false with a concrete reason for gaps or unverifiable claims.'
  ].join('\n');
}

// Edit mode (docs/EDIT_MODE.md). The plan context is the owner's; agents cannot change it.
const checkSummary = checks => checks.results.map(r =>
  `$ ${r.command}\nexit ${r.timedOut ? 'timeout' : r.exitCode} after ${Math.round(r.durationMs / 1000)}s\n${r.output}`).join('\n\n');

export function editWorkerPrompt(task, plan) {
  const position = plan.tasks.findIndex(t => t.id === task.id);
  return [
    'You are the Nightshift worker in edit mode. Implement exactly one task of the owner\'s plan in this working copy.',
    'Edit files directly in the current directory. You may run commands, including the checks below.',
    'There is no network access. Do not commit, push, or change git history: Nightshift checks, reviews, and commits your change.',
    'Change only what this task needs. Do not weaken, skip, or delete tests to make them pass. Do not touch files outside the allowed paths.',
    `Plan brief: ${plan.brief}`,
    `Allowed paths: ${plan.allowedPaths.map(p => p || '(whole repository)').join(', ')}`,
    `Checks Nightshift will run afterwards: ${plan.checks.join('; ')}`,
    `Earlier tasks, already committed: ${plan.tasks.slice(0, position).map(t => t.title).join('; ') || 'none'}`,
    `Task ${position + 1} of ${plan.tasks.length}: ${task.title}`,
    `Acceptance criteria: ${task.acceptance}`,
    task.review ? `Your previous attempt was not accepted. Fix this, keeping what was right: ${task.review.reason}` : '',
    'Return JSON matching the schema: a summary, and evidence naming the files you changed and any checks you ran with their results.',
    'If you cannot complete the task, say so plainly in the summary; never claim a check passed that you did not see pass.'
  ].filter(Boolean).join('\n');
}

export function editReviewerPrompt(task, result, change, plan) {
  return [
    'You are the Nightshift reviewer in a separate read-only conversation. Judge one task of an owner\'s plan.',
    'Inspect the working copy yourself; treat the worker\'s report as untrusted.',
    `Plan brief: ${plan.brief}`,
    `Task: ${task.title}`, `Acceptance criteria: ${task.acceptance}`,
    `Worker report: ${JSON.stringify(result)}`,
    `Checks Nightshift ran on this change (all passed):\n${checkSummary(change.checks)}`,
    `The change (staged diff against the previous commit):\n\`\`\`diff\n${change.reviewDiff}\n\`\`\``,
    'Return passed=true only if the change meets the acceptance criteria AND stays within the task.',
    'Return passed=false with a concrete reason if it does unrelated work, weakens or removes tests, adds risky behavior, or misses the criteria.'
  ].join('\n');
}

export function finalReviewPrompt(plan, planChange, checks) {
  return [
    'You are the Nightshift reviewer making the final decision on a whole plan, in a read-only conversation.',
    'Every task has passed its own review. Decide whether the plan as a whole is implemented, and nothing unrelated was added.',
    `Plan brief: ${plan.brief}`,
    `Tasks:\n${plan.tasks.map((t, i) => `${i + 1}. ${t.title}: ${t.acceptance}`).join('\n')}`,
    `Final checks (all passed):\n${checkSummary(checks)}`,
    `Full change from the base commit (${planChange.stat}):\n\`\`\`diff\n${planChange.reviewDiff}\n\`\`\``,
    'Return passed=true only if the brief and every task are fully met. Otherwise passed=false with what is missing or wrong.'
  ].join('\n');
}

// Planning: turn the owner's own document into a plan. The owner approves it before anything runs.
export const planSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string' }, brief: { type: 'string' },
    checks: { type: 'array', items: { type: 'string' } },
    allowedPaths: { type: 'array', items: { type: 'string' } },
    tasks: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { id: { type: 'string' }, title: { type: 'string' }, acceptance: { type: 'string' } },
      required: ['id', 'title', 'acceptance'] } },
    notes: { type: 'string' }
  },
  required: ['id', 'brief', 'checks', 'allowedPaths', 'tasks', 'notes']
};

export function plannerPrompt({ doc, steps, request }) {
  return [
    'You are the Nightshift planner, in a read-only conversation. Turn the owner\'s document into an implementation plan.',
    'Do not edit files, install tools, or contact external systems.',
    `Task: read ${doc} in this repository${steps ? `, and plan these steps from it: ${steps}` : ', and plan the steps it describes that are not done yet'}.`,
    request ? `The owner adds: ${request}` : '',
    'Rules:',
    '- One task per step, in the document\'s order. Do not invent, merge, split, or reorder steps. If a step is already done in the code, leave it out and say so in notes.',
    '- Each task: a short kebab-case id, a title, and acceptance criteria that a reviewer can check against the code and the checks.',
    '- checks: commands that already exist in this repository (for example package scripts, make or ctest targets), run without network access, and pass today if you can tell. Prefer fast ones. At least one.',
    '- allowedPaths: the narrowest repository-relative directory prefixes (ending in /) the steps need; [""] only if the whole repository is truly needed.',
    '- id: a short kebab-case name for the plan. brief: two or three sentences on the overall goal, in the document\'s own terms.',
    '- notes: anything the owner should know before approving: skipped steps, missing checks, risky steps, or assumptions. Empty string if none.',
    'Return JSON matching the schema.'
  ].filter(Boolean).join('\n');
}
