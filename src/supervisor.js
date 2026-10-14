export class BlockedError extends Error {}

export class Supervisor {
  constructor(store, adapter, reviewer) {
    this.store = store;
    this.adapter = adapter;
    this.reviewer = reviewer;
    this.state = store.read();
    this.busy = false;
    for (const task of this.state.tasks) {
      if (['running', 'review'].includes(task.status)) {
        task.status = 'blocked';
        task.reason = 'Interrupted run: reconcile external effects before retrying.';
        this.record(task.id, 'recovery-blocked', task.reason);
      }
    }
    store.save(this.state);
  }

  record(taskId, type, detail) {
    this.state.events.push({ taskId, type, detail, at: new Date().toISOString() });
  }

  add({ id, title, acceptance, dependencies = [], maxAttempts = 2 }) {
    if (!id || !title || !acceptance) throw new Error('id, title, and acceptance are required.');
    if (this.state.tasks.some(task => task.id === id)) throw new Error('Duplicate task ID.');
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts must be a positive integer.');
    if (!Array.isArray(dependencies) || dependencies.some(dep => !this.state.tasks.some(task => task.id === dep))) {
      throw new Error('Dependencies must name existing tasks.');
    }
    this.state.tasks.push({ id, title, acceptance, dependencies: [...dependencies], maxAttempts, attempts: 0, status: 'ready' });
    this.record(id, 'created', title);
    this.store.save(this.state);
  }

  pause(value = true) {
    this.state.paused = value;
    this.record(null, value ? 'paused' : 'resumed', 'Applies before the next dispatch.');
    this.store.save(this.state);
  }

  snapshot() { return structuredClone(this.state); }

  observer(task, role) {
    return event => {
      if (!event || typeof event.type !== 'string') throw new Error('Invalid adapter event.');
      if (event.type === 'session' || event.type === 'turn-started') {
        task.sessions ??= {};
        task.sessions[role] = { ...task.sessions[role], provider: event.provider, threadId: event.threadId,
          ...(event.turnId ? { turnId: event.turnId } : {}) };
      }
      if (event.type === 'dispatch-intent') {
        const session = task.sessions?.[role];
        if (!session) throw new Error('Dispatch requires a persisted provider session.');
        session.previousTurnId = session.turnId ?? null;
        session.turnId = null;
        session.status = 'dispatching';
      }
      if (event.type === 'turn-started') task.sessions[role].status = 'running';
      if (event.type === 'turn-completed' && task.sessions?.[role]) task.sessions[role].status = event.status;
      this.record(task.id, `provider:${event.type}`, { role, ...event });
      this.store.save(this.state);
    };
  }

  async tick() {
    if (this.busy || this.state.paused) return false;
    const task = this.state.tasks.find(candidate => candidate.status === 'ready' &&
      candidate.dependencies.every(id => this.state.tasks.some(other => other.id === id && other.status === 'done')));
    if (!task) return false;
    this.busy = true;
    try {
      if (task.attempts >= task.maxAttempts) {
        task.status = 'blocked';
        task.reason = 'Attempt limit reached.';
        this.record(task.id, 'blocked', task.reason);
        this.store.save(this.state);
        return true;
      }
      task.status = 'running';
      task.attempts += 1;
      this.record(task.id, 'dispatched', `Attempt ${task.attempts}`);
      this.store.save(this.state);

      let result;
      try {
        result = await this.adapter.execute(structuredClone(task), { onEvent: this.observer(task, 'worker') });
        if (!result || typeof result.summary !== 'string' || !Array.isArray(result.evidence) ||
            !result.evidence.length || result.evidence.some(item => typeof item !== 'string' || !item.trim())) {
          throw new BlockedError('Worker did not provide a valid result with evidence.');
        }
      } catch (error) {
        this.block(task, error);
        return true;
      }
      task.result = structuredClone(result);
      task.status = 'review';
      this.record(task.id, 'review-requested', result.summary);
      this.store.save(this.state);

      let review;
      try {
        review = await this.reviewer.review(structuredClone(task), structuredClone(result), { onEvent: this.observer(task, 'reviewer') });
        if (!review || typeof review.passed !== 'boolean' || typeof review.reason !== 'string' || !review.reason.trim()) {
          throw new BlockedError('Reviewer did not provide a valid decision and reason.');
        }
      } catch (error) {
        this.block(task, error);
        return true;
      }
      task.review = structuredClone(review);
      task.reason = review.reason;
      task.status = review.passed ? 'done' : task.attempts < task.maxAttempts ? 'ready' : 'blocked';
      this.record(task.id, review.passed ? 'verified' : 'review-failed', review.reason);
      this.store.save(this.state);
      return true;
    } finally { this.busy = false; }
  }

  block(task, error) {
    task.status = 'blocked';
    task.reason = error instanceof BlockedError ? error.message : `Execution uncertain: ${error.message ?? String(error)}`;
    this.record(task.id, 'blocked', task.reason);
    this.store.save(this.state);
  }

  async run({ maxDispatches = 20 } = {}) {
    if (!Number.isInteger(maxDispatches) || maxDispatches < 1) throw new Error('maxDispatches must be a positive integer.');
    let dispatched = 0;
    while (dispatched < maxDispatches && await this.tick()) dispatched += 1;
    return { dispatched, state: this.snapshot() };
  }
}
