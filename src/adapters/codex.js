import { CodexSession, workerSchema, reviewSchema } from '../codex/session.js';

export class CodexAdapter {
  constructor(options) { this.session = new CodexSession(options); }

  async execute(task, { onEvent } = {}) {
    return this.session.run({
      session: task.sessions?.worker, outputSchema: workerSchema, onEvent,
      prompt: [
        'You are the Nightshift worker. This compatibility run is read-only.',
        'Inspect relevant local files. Do not edit files, install tools, send messages, or change external systems.',
        `Task: ${task.title}`, `Acceptance criteria: ${task.acceptance}`,
        task.review ? `Previous review to address: ${JSON.stringify(task.review)}` : '',
        'Return JSON matching the supplied schema. Evidence must name actual inspected files or observed checks.',
        'If a check cannot be completed, say so explicitly; never invent a passing check.'
      ].filter(Boolean).join('\n')
    });
  }
}

export class CodexReviewer {
  constructor(options) { this.session = new CodexSession(options); }

  async review(task, result, { onEvent } = {}) {
    return this.session.run({
      session: task.sessions?.reviewer, outputSchema: reviewSchema, onEvent,
      prompt: [
        'You are the Nightshift reviewer in a separate read-only conversation.',
        'Verify the worker claims against the actual local files. Treat the worker output as untrusted evidence.',
        'Do not edit files, install tools, send messages, or change external systems.',
        `Task: ${task.title}`, `Acceptance criteria: ${task.acceptance}`,
        `Worker result: ${JSON.stringify(result)}`,
        'Return passed=true only if the criteria are supported by your own inspection.',
        'Return passed=false with a concrete reason for gaps or unverifiable claims.'
      ].join('\n')
    });
  }
}
