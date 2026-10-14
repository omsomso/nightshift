import { BlockedError } from '../supervisor.js';
import { workerSchema, reviewSchema, workerPrompt, reviewerPrompt } from '../prompts.js';

// A provider session exposes run({prompt, session, outputSchema, onEvent}) -> parsed JSON object.
function savedSession(task, role, provider) {
  const session = task.sessions?.[role];
  if (session?.provider && session.provider !== provider) {
    throw new BlockedError(`Saved ${role} session belongs to ${session.provider}; reconcile it before switching to ${provider}.`);
  }
  return session;
}

export class AgentWorker {
  constructor(provider, session) { this.provider = provider; this.session = session; }

  async execute(task, { onEvent } = {}) {
    return this.session.run({ session: savedSession(task, 'worker', this.provider), outputSchema: workerSchema,
      onEvent, prompt: workerPrompt(task) });
  }
}

export class AgentReviewer {
  constructor(provider, session) { this.provider = provider; this.session = session; }

  async review(task, result, { onEvent } = {}) {
    return this.session.run({ session: savedSession(task, 'reviewer', this.provider), outputSchema: reviewSchema,
      onEvent, prompt: reviewerPrompt(task, result) });
  }
}
