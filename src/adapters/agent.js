import { BlockedError } from '../supervisor.js';
import { workerSchema, reviewSchema, workerPrompt, reviewerPrompt, editWorkerPrompt, editReviewerPrompt, finalReviewPrompt } from '../prompts.js';

// A provider session exposes run({prompt, session, outputSchema, onEvent, signal}) -> parsed JSON object.
// It must stop its turn promptly when `signal` aborts and reject with `signal.reason`.
function savedSession(task, role, provider) {
  const session = task.sessions?.[role];
  if (session?.provider && session.provider !== provider) {
    throw new BlockedError(`Saved ${role} session belongs to ${session.provider}; reconcile it before switching to ${provider}.`);
  }
  return session;
}

export class AgentWorker {
  constructor(provider, session) { this.provider = provider; this.session = session; }

  // With a plan (edit mode), the session must have been built with edit access.
  async execute(task, { onEvent, signal, plan } = {}) {
    if (plan && !this.session.edit) throw new BlockedError('Edit-mode plan, but the worker session is read-only.');
    return this.session.run({ session: savedSession(task, 'worker', this.provider), outputSchema: workerSchema,
      onEvent, signal, prompt: plan ? editWorkerPrompt(task, plan) : workerPrompt(task) });
  }
}

export class AgentReviewer {
  constructor(provider, session) { this.provider = provider; this.session = session; }

  // Reviewers are always read-only, also in edit mode.
  async review(task, result, { onEvent, signal, plan, change, final = false } = {}) {
    if (this.session.edit) throw new BlockedError('Reviewer sessions must be read-only.');
    const prompt = final ? finalReviewPrompt(plan, change.planChange, change.checks)
      : plan ? editReviewerPrompt(task, result, change, plan) : reviewerPrompt(task, result);
    return this.session.run({ session: savedSession(task, 'reviewer', this.provider), outputSchema: reviewSchema,
      onEvent, signal, prompt });
  }
}
