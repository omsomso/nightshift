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
