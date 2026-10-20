// Provider-neutral worker and reviewer instructions. Every adapter sends the same text.
import { rulesBlock } from './rules.js';
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
    'You can only read and write inside this directory. Put screenshots, logs, and other scratch files in .nightshift-scratch/ here (never committed); anything saved elsewhere cannot be read back. If a request is refused, carry on without it.',
    'Your shell runs in a sandbox without a window server or network, so tests that open windows or need the network may crash or fail here. Do not patch around that and do not record those results in project files as if they were real: Nightshift runs the plan\'s checks itself, outside your sandbox, and the reviewer sees those results. Say in your summary which checks you could not run.',
    rulesBlock(plan.rules),
    `Plan brief: ${plan.brief}`,
    `Allowed paths: ${plan.allowedPaths.map(p => p || '(whole repository)').join(', ')}`,
    `Checks Nightshift will run afterwards: ${plan.checks.join('; ')}`,
    `Earlier tasks, already committed: ${plan.tasks.slice(0, position).map(t => t.title).join('; ') || 'none'}`,
    `Task ${position + 1} of ${plan.tasks.length}: ${task.title}`,
    `Acceptance criteria: ${task.acceptance}`,
    task.timedOut ? `Your previous attempt ran out of time after ${task.timedOut.minutes} minutes before it finished. Work in focused steps and finish the task this time.` : '',
    task.leftover?.length ? `The working copy already has uncommitted changes from an earlier attempt (${task.leftover.join(', ')}). Look at them first: keep what is right, fix or finish the rest; do not start over.` : '',
    task.review ? `Your previous attempt was not accepted. Fix this, keeping what was right: ${task.review.reason}` : '',
    'Return JSON matching the schema: a summary, and evidence naming the files you changed and any checks you ran with their results.',
    'If you cannot complete the task, say so plainly in the summary; never claim a check passed that you did not see pass.'
  ].filter(Boolean).join('\n');
}

export function editReviewerPrompt(task, result, change, plan) {
  return [
    'You are the Nightshift reviewer in a separate read-only conversation. Judge one task of an owner\'s plan.',
    'Inspect the working copy yourself; treat the worker\'s report as untrusted.',
    rulesBlock(plan.rules),
    'Judge the change against these project rules too, except steps Nightshift forbids (commit, push, install, network), which are left for the owner.',
    `Plan brief: ${plan.brief}`,
    `Task: ${task.title}`, `Acceptance criteria: ${task.acceptance}`,
    `Worker report: ${JSON.stringify(result)}`,
    `Checks Nightshift ran on this change (all passed):\n${checkSummary(change.checks)}`,
    'These checks ran outside the worker\'s sandbox and are authoritative. The worker\'s own shell has no window server or network, so tests it reports as crashing or failing only there are not a fault of the change. Do not fail the task for that, or for project notes that need correcting about it, unless the task itself is about them.',
    `The change (staged diff against the previous commit):\n\`\`\`diff\n${change.reviewDiff}\n\`\`\``,
    'Return passed=true only if the change meets the acceptance criteria AND stays within the task.',
    'Return passed=false with a concrete reason if it does unrelated work, weakens or removes tests, adds risky behavior, or misses the criteria.',
    `Only require changes inside the allowed paths (${plan.allowedPaths.map(p => p || '(whole repository)').join(', ')}); mention anything else as a suggestion, not a reason to fail.`
  ].filter(Boolean).join('\n');
}

export function finalReviewPrompt(plan, planChange, checks) {
  return [
    'You are the Nightshift reviewer making the final decision on a whole plan, in a read-only conversation.',
    'Every task has passed its own review. Decide whether the plan as a whole is implemented, and nothing unrelated was added.',
    rulesBlock(plan.rules),
    `Plan brief: ${plan.brief}`,
    `Tasks:\n${plan.tasks.map((t, i) => `${i + 1}. ${t.title}: ${t.acceptance}`).join('\n')}`,
    `Final checks (all passed):\n${checkSummary(checks)}`,
    `Full change from the base commit (${planChange.stat}):\n\`\`\`diff\n${planChange.reviewDiff}\n\`\`\``,
    `Allowed paths: ${plan.allowedPaths.map(p => p || '(whole repository)').join(', ')}`,
    'Judge the plan as defined: its brief and tasks, within its allowed paths. Do not fail it for work the tasks did not ask for or that lies outside the allowed paths; mention that as a suggestion instead.',
    'Do fail it for real defects in the change (bugs, unsafe behavior, missing criteria), naming each concretely so a follow-up task can fix it.',
    'Return passed=true only if the brief and every task are fully met. Otherwise passed=false with what is missing or wrong.'
  ].filter(Boolean).join('\n');
}

// Planning: turn the owner's own document into a plan. The owner approves it before anything runs.
export const planSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string' }, brief: { type: 'string' },
    checks: { type: 'array', items: { type: 'string' } },
    allowedPaths: { type: 'array', items: { type: 'string' } },
    tasks: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { id: { type: 'string' }, title: { type: 'string' }, acceptance: { type: 'string' },
        difficulty: { type: 'string', enum: ['low', 'medium', 'high'] }, difficultyReason: { type: 'string' } },
      required: ['id', 'title', 'acceptance', 'difficulty', 'difficultyReason'] } },
    notes: { type: 'string' }
  },
  required: ['id', 'brief', 'checks', 'allowedPaths', 'tasks', 'notes']
};

export function plannerPrompt({ doc, docText, steps, request, rules, base }) {
  return [
    'You are the Nightshift planner, in a read-only conversation. Turn the owner\'s document into an implementation plan.',
    'Do not edit files, install tools, or contact external systems.',
    rules?.length ? rulesBlock(rules) : 'First read the repository\'s agent instructions if present (AGENTS.md, CLAUDE.md, and files they point to).',
    'The plan must let the worker follow the project rules within Nightshift\'s limits.',
    `Task: plan from the owner's document ${doc}${steps ? `, these steps: ${steps}` : ', the steps it describes that are not done yet'}.`,
    base ? `This folder is a read-only snapshot of ${base}, the code the plan will start from (not necessarily what is checked out). Judge what is already done against it.` : '',
    docText ? `The document (it may not be committed yet):\n----- ${doc} -----\n${docText.trim()}\n----- end of document -----` : '',
    request ? `The owner adds: ${request}` : '',
    'Rules:',
    '- Tasks are milestones, not chores. Each task is one meaningful outcome worth a full agent session: a feature that works, a component in place and used, a behaviour fixed with its test. Small edits (renaming something, rewording a label, changing one value, moving a file, updating a doc line) are never tasks of their own: fold them into the milestone they serve, or into the nearest related task.',
    '- Follow the document\'s order and cover every step it asks for, but combine adjacent steps that touch the same area or only make sense together. Most plans need 2 to 6 tasks; a long document may need more, a small one may be a single task. Do not invent work the document does not ask for. Say in notes which steps you combined.',
    '- If a step is already done in the code, leave it out and say so in notes.',
    '- Every task must change files. Do not create check-only tasks ("confirm the baseline", "run all tests", "final verification"): Nightshift itself runs the checks before the first task, after every task, and at the end, and does a final review. Fold such verification into the acceptance criteria of the tasks that change code, and mention dropped check-only steps in notes.',
    '- Each task: a short kebab-case id, a title naming the outcome (not the first edit), and acceptance criteria that a reviewer can check against the code and the checks, covering everything folded into it.',
    '- Rate each task\'s difficulty (low, medium, or high) from what you read in the code, with a one-line reason: low for small, local, well-understood changes; high for subtle or risky work (concurrency, real-time or audio threads, data migrations, security, wide refactors). It sets how much reasoning effort the worker starts with.',
    '- checks: commands that already exist in this repository (for example package scripts, make or ctest targets), run without network access, and pass today if you can tell. Prefer fast ones. At least one.',
    '- allowedPaths: the narrowest repository-relative prefixes (directories ending in /, or single files) the steps need, plus any file the agent instructions require updating alongside code changes (for example a roadmap or changelog); [""] only if the whole repository is truly needed.',
    '- If the agent instructions require such an update, say in the relevant task\'s acceptance criteria what to update.',
    '- id: a short kebab-case name for the plan. brief: two or three sentences on the overall goal, in the document\'s own terms.',
    '- notes: anything the owner should know before approving: skipped steps, missing checks, risky steps, or assumptions. Empty string if none.',
    'Return JSON matching the schema.'
  ].filter(Boolean).join('\n');
}

// The app's plan chat: help the owner write the plan document that Nightshift will run.
export function chatPrompt({ repo, rules, message }) {
  return [
    `You are Nightshift's plan assistant for the repository at ${repo}. You are read-only: you can read the code, but not change it.`,
    rulesBlock(rules),
    'Help the owner write a plan document that Nightshift will implement unattended. A good plan has numbered steps in order; each step is a milestone: one meaningful outcome with a clear, checkable result (a working feature, a component in place and used, a fix with its test), worth a full agent session, and says how to verify it (tests or checks that exist in the repository). Small edits such as renames, label wording, or single values are folded into the milestone they serve, never steps of their own.',
    'Read the code to make steps concrete. Ask short questions when something important is unclear. Do not invent work the owner did not ask for.',
    'Whenever you propose or revise the document, include the complete document in a single ```markdown fenced block, so Nightshift can save it into the repository.',
    `Owner: ${message}`
  ].filter(Boolean).join('\n\n');
}

// The interview: from the owner's quick notes to a complete, approved roadmap.
export function interviewPrompt({ projects, rules, notes, repo }) {
  const list = projects.map(p => `- ${p.name}: ${p.path}${p.description ? ` (${p.description})` : ''}`).join('\n');
  return [
    'You are Nightshift\'s planning interviewer. The owner pasted quick notes about things to fix or build. Turn them, together with the owner, into a complete roadmap that Nightshift will implement unattended. You are read-only: read code freely, change nothing.',
    rulesBlock(rules),
    repo ? `The owner says the notes are about this project: ${repo}.` : `Candidate projects:\n${list}`,
    'Work like this:',
    `1. ${repo ? 'Confirm the project' : 'Work out which project the notes are about, reading code to confirm'}, and state it in a block exactly like:\n\`\`\`nightshift-repo\n/absolute/path/to/project\n\`\`\`\nIf the notes cover several projects, pick the one most notes concern and say which notes belong elsewhere.`,
    '2. Read the relevant code and the chosen project\'s own rules (its AGENTS.md / CLAUDE.md) so the steps fit how the project works.',
    '3. Ask what you need to know, a few questions at a time (at most 4 per turn), as multiple choice whenever sensible, in a block exactly like:\n```nightshift-questions\n[{"question": "...", "options": [{"label": "short answer", "detail": "one line on what it means or costs", "recommended": true}, {"label": "...", "detail": "..."}], "multiple": false}]\n```\nKeep labels short; put the explanation in detail. Mark at most one option per question as recommended, and only when you have a reason. The owner may also answer in their own words. Do not ask what the code already answers.',
    '4. When you know enough, write the complete roadmap in one ```markdown block (every step must change files; no check-only steps, because Nightshift runs the checks itself before, during, and after): a # title, two or three sentences on what it covers and what it leaves out, then numbered steps in a sensible order. Each step is a milestone: one meaningful outcome with a checkable result, worth a full agent session, and says how to verify it (tests or checks that exist in the project). Fold small edits (renames, label wording, single values, doc lines) into the milestone they serve; never make them steps of their own. Most roadmaps have 2 to 6 steps. Include every note the owner wants done; do not add work they did not ask for.',
    '5. Revise the roadmap when asked, always repeating the complete document.',
    `Owner's notes:\n${notes}`
  ].filter(Boolean).join('\n\n');
}
