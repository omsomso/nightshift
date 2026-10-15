import { workerEffort, reviewerEffort } from './effort.js';

export class BlockedError extends Error {}
// Both of these block the task and pause the whole queue.
// A billing problem affects every task, not just this one.
export class BillingGuardError extends BlockedError {}
// The owner stopped the turn in flight and takes over from here.
export class InterruptedError extends BlockedError {}

const checkDigest = checks => checks.results.map(r =>
  `$ ${r.command} -> exit ${r.timedOut ? 'timeout' : r.exitCode}\n${r.output}`).join('\n\n');

export class Supervisor {
  // With a `workspace`, the supervisor runs a plan in edit mode (docs/EDIT_MODE.md):
  // gates and checks before review, Nightshift-made commits, and plan-level limits.
  constructor(store, adapter, reviewer, { workspace = null } = {}) {
    this.store = store;
    this.adapter = adapter;
    this.reviewer = reviewer;
    this.workspace = workspace;
    this.state = store.read();
    this.busy = false;
    this.current = null; // { task, abort } while a dispatch is in flight
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

  add({ id, title, acceptance, dependencies = [], maxAttempts = 2, difficulty }) {
    if (!id || !title || !acceptance) throw new Error('id, title, and acceptance are required.');
    if (this.state.tasks.some(task => task.id === id)) throw new Error('Duplicate task ID.');
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts must be a positive integer.');
    if (!Array.isArray(dependencies) || dependencies.some(dep => !this.state.tasks.some(task => task.id === dep))) {
      throw new Error('Dependencies must name existing tasks.');
    }
    this.state.tasks.push({ id, title, acceptance, dependencies: [...dependencies], maxAttempts, attempts: 0, status: 'ready', ...(difficulty ? { difficulty } : {}) });
    this.record(id, 'created', title);
    this.store.save(this.state);
  }

  pause(value = true) {
    this.state.paused = value;
    this.record(null, value ? 'paused' : 'resumed', 'Applies before the next dispatch.');
    this.store.save(this.state);
  }

  // Manual only: a person has reconciled the blocker and accepts any repeated effects.
  retry(id) {
    const plan = this.state.plan;
    if (plan && id === plan.id) {
      if (plan.status !== 'blocked') throw new Error(`Plan ${id} is ${plan.status}, not blocked.`);
      plan.status = 'running';
      this.record(null, 'manual-retry', `Plan reopened. Previous blocker: ${plan.reason}`);
      delete plan.reason;
      this.store.save(this.state);
      return;
    }
    const task = this.state.tasks.find(candidate => candidate.id === id);
    if (!task) throw new Error(`Unknown task ${id}.`);
    if (task.status !== 'blocked') throw new Error(`Task ${id} is ${task.status}, not blocked.`);
    task.status = 'ready';
    task.maxAttempts = Math.max(task.maxAttempts, task.attempts + 1);
    this.record(id, 'manual-retry', `Previous blocker: ${task.reason}`);
    delete task.reason;
    this.store.save(this.state);
  }

  // Stops the dispatch in flight. Adapters receive the abort signal; whatever they
  // return afterwards is discarded, never reviewed or marked done.
  interrupt() {
    if (!this.current) throw new Error('Nothing is running.');
    const { task, abort } = this.current;
    if (abort.signal.aborted) return;
    this.record(task.id, 'interrupt-requested', 'Stopping the current turn.');
    this.store.save(this.state);
    abort.abort(new InterruptedError('Interrupted by the owner; reconcile any partial effects, then retry or take over.'));
  }

  // Commands queued by other processes. `serve` also applies them during a turn, so
  // interrupt takes effect promptly; the rest only change what the next tick does.
  applyCommands() {
    if (!this.store.takeCommands) return;
    for (const command of this.store.takeCommands()) {
      try {
        if (command.type === 'pause') this.pause(true);
        else if (command.type === 'resume') this.pause(false);
        else if (command.type === 'add-task') this.add(command.payload);
        else if (command.type === 'retry') this.retry(command.payload?.id);
        else if (command.type === 'interrupt') this.interrupt();
        else if (command.type === 'limit') this.setLimit(command.payload?.name, command.payload?.value);
        else if (command.type === 'difficulty') this.setDifficulty(command.payload?.id, command.payload?.level);
        else throw new Error('Unknown command.');
      } catch (error) {
        this.record(command.payload?.id ?? null, 'command-rejected', `${command.type}: ${error.message}`);
        this.store.save(this.state);
      }
    }
  }

  // The owner's difficulty rating for a task; future attempts start from it.
  setDifficulty(id, level) {
    const task = this.state.tasks.find(candidate => candidate.id === id);
    if (!task) throw new Error(`Unknown task ${id}.`);
    if (!['low', 'medium', 'high'].includes(level)) throw new Error('Difficulty must be low, medium, or high.');
    task.difficulty = level;
    const planned = this.state.plan?.tasks?.find(candidate => candidate.id === id);
    if (planned) planned.difficulty = level;
    this.record(id, 'difficulty-changed', level);
    this.store.save(this.state);
  }

  // The owner may raise or lower a plan limit, for example after one was reached.
  setLimit(name, value) {
    const limits = this.state.plan?.limits;
    if (!limits) throw new Error('There is no plan.');
    if (!(name in limits)) throw new Error(`Unknown limit ${name}.`);
    if (!(Number(value) > 0)) throw new Error('A limit must be a positive number.');
    limits[name] = Number(value);
    if (this.workspace) this.workspace.limits = limits;
    this.record(null, 'limit-changed', `${name} = ${value}`);
    this.store.save(this.state);
  }

  // Plan-wide kill switches. Reaching one pauses the queue until the owner acts.
  planLimitReached() {
    const plan = this.state.plan;
    if (!plan || plan.status !== 'running') return false;
    const dispatches = this.state.events.filter(e => e.type === 'dispatched').length;
    const tokens = this.state.events.filter(e => e.type === 'provider:usage')
      .reduce((sum, e) => sum + (Number(e.detail?.tokens?.input) || 0) + (Number(e.detail?.tokens?.output) || 0), 0);
    const hours = (Date.now() - Date.parse(plan.startedAt)) / 3_600_000;
    const reached = dispatches >= plan.limits.dispatches ? `${dispatches} dispatches (limit ${plan.limits.dispatches})`
      : tokens >= plan.limits.tokens ? `${tokens.toLocaleString('en-US')} tokens (limit ${plan.limits.tokens.toLocaleString('en-US')})`
      : hours >= plan.limits.hours ? `${hours.toFixed(1)} hours (limit ${plan.limits.hours})` : null;
    if (!reached) return false;
    this.record(null, 'plan-limit', `Plan paused: ${reached}. Raise the limit with \`limit\`, then resume.`);
    this.pause(true);
    return true;
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
    if (this.busy) return false;
    this.applyCommands();
    if (this.state.paused) return false;
    if (this.planLimitReached()) return false;
    if (this.state.plan?.status !== undefined && this.state.plan.status !== 'running') return false;
    const task = this.state.tasks.find(candidate => candidate.status === 'ready' &&
      candidate.dependencies.every(id => this.state.tasks.some(other => other.id === id && other.status === 'done')));
    if (!task) {
      if (this.workspace && this.state.tasks.every(t => t.status === 'done')) return this.finishPlan();
      return false;
    }
    this.busy = true;
    const abort = new AbortController();
    this.current = { task, abort };
    // Effort applies in plan mode, where the plan carries the owner's effort settings.
    const effortFor = role => this.state.plan?.effort ? (role === 'worker' ? workerEffort(task, this.state.plan.effort) : reviewerEffort(this.state.plan.effort)) : undefined;
    const context = role => ({ onEvent: this.observer(task, role), signal: abort.signal, plan: this.state.plan, effort: effortFor(role) });
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
      const effort = effortFor('worker');
      if (effort) task.effort = effort;
      this.record(task.id, 'dispatched', `Attempt ${task.attempts}${effort ? ` at ${effort} effort` : ''}`);
      this.store.save(this.state);

      let result;
      try {
        result = await this.adapter.execute(structuredClone(task), context('worker'));
        if (abort.signal.aborted) throw abort.signal.reason;
        if (!result || typeof result.summary !== 'string' || !Array.isArray(result.evidence) ||
            !result.evidence.length || result.evidence.some(item => typeof item !== 'string' || !item.trim())) {
          throw new BlockedError('Worker did not provide a valid result with evidence.');
        }
      } catch (error) {
        this.block(task, error);
        return true;
      }
      task.result = structuredClone(result);

      let change = null;
      if (this.workspace) {
        try {
          change = await this.verifyChange(task, abort.signal);
          if (abort.signal.aborted) throw abort.signal.reason;
        } catch (error) {
          this.block(task, error);
          return true;
        }
        if (!change) return true; // Sent back for repair, or blocked, by the gates or checks.
      }
      task.status = 'review';
      this.record(task.id, 'review-requested', result.summary);
      this.store.save(this.state);

      let review;
      try {
        review = await this.reviewer.review(structuredClone(task), structuredClone(result), { ...context('reviewer'), change });
        if (abort.signal.aborted) throw abort.signal.reason;
        if (!review || typeof review.passed !== 'boolean' || typeof review.reason !== 'string' || !review.reason.trim()) {
          throw new BlockedError('Reviewer did not provide a valid decision and reason.');
        }
      } catch (error) {
        this.block(task, error);
        return true;
      }
      task.review = structuredClone(review);
      task.reason = review.reason;
      if (review.passed && this.workspace) {
        try {
          task.commit = this.workspace.commit(task, this.state.plan.id);
          this.record(task.id, 'committed', task.commit);
        } catch (error) {
          this.block(task, error);
          return true;
        }
      }
      task.status = review.passed ? 'done' : task.attempts < task.maxAttempts ? 'ready' : 'blocked';
      this.record(task.id, review.passed ? 'verified' : 'review-failed', review.reason);
      this.store.save(this.state);
      return true;
    } finally {
      this.busy = false;
      this.current = null;
    }
  }

  // Gates, then checks, both deterministic. Returns the change for review, or null after
  // sending the task back for repair (or blocking it). Throws only on unexpected failures.
  async verifyChange(task, signal) {
    const change = this.workspace.inspect();
    const gate = this.workspace.gate(change);
    this.record(task.id, 'change-inspected', { files: change.files.map(f => f.path), changedLines: change.changedLines, gate: gate.verdict });
    this.store.save(this.state);
    if (gate.verdict === 'block') {
      this.block(task, new BlockedError(gate.reason));
      return null;
    }
    const checks = gate.verdict === 'ok' ? await this.workspace.runChecks({ signal }) : { passed: false, results: [] };
    if (signal.aborted) throw signal.reason;
    if (gate.verdict === 'ok') {
      this.record(task.id, 'checks', { passed: checks.passed, results: checks.results });
      this.store.save(this.state);
    }
    if (gate.verdict === 'ok' && checks.passed) return { ...change, checks };
    const reason = gate.verdict === 'repair' ? gate.reason : `The plan's checks failed:\n${checkDigest(checks)}`;
    const fingerprint = this.workspace.constructor.fingerprint(change, checks);
    if (task.lastFailure === fingerprint) {
      this.block(task, new BlockedError(`Stagnation: the same change failed the same way twice. Last failure: ${reason.slice(0, 2000)}`));
      return null;
    }
    task.lastFailure = fingerprint;
    task.review = { passed: false, reason };
    task.reason = reason;
    task.status = task.attempts < task.maxAttempts ? 'ready' : 'blocked';
    this.record(task.id, 'checks-failed', reason.slice(0, 4000));
    this.store.save(this.state);
    return null;
  }

  // After the last task: clean tree, full checks, then a final review of the whole plan.
  async finishPlan() {
    const plan = this.state.plan;
    plan.final ??= { id: `${plan.id}:final` };
    const abort = new AbortController();
    this.busy = true;
    this.current = { task: plan.final, abort };
    const stop = (reason, status = 'blocked') => {
      plan.status = status;
      plan.reason = reason;
      this.record(null, 'plan-blocked', reason);
      this.state.paused = true;
      this.store.save(this.state);
      return true;
    };
    try {
      if (!this.workspace.clean()) return stop('Uncommitted changes remain after the last task.');
      this.record(null, 'final-checks-started', plan.checks.join('; '));
      this.store.save(this.state);
      const checks = await this.workspace.runChecks({ signal: abort.signal });
      if (abort.signal.aborted) throw abort.signal.reason;
      this.record(null, 'final-checks', { passed: checks.passed, results: checks.results });
      if (!checks.passed) return this.fixupOrStop(`Final checks failed:\n${checkDigest(checks).slice(0, 4000)}`, stop);
      const planChange = this.workspace.planDiff();
      const commits = this.state.tasks.map(t => `${t.commit?.slice(0, 12)} ${t.title}`);
      const review = await this.reviewer.review({ id: plan.final.id, title: `Whole plan: ${plan.id}`, acceptance: plan.brief },
        { summary: `All ${plan.tasks.length} tasks committed`, evidence: commits },
        { onEvent: this.observer(plan.final, 'reviewer'), signal: abort.signal, plan, change: { planChange, checks }, final: true,
          effort: plan.effort ? reviewerEffort(plan.effort) : undefined });
      if (abort.signal.aborted) throw abort.signal.reason;
      if (!review || typeof review.passed !== 'boolean' || typeof review.reason !== 'string' || !review.reason.trim()) {
        return stop('Final reviewer did not provide a valid decision and reason.');
      }
      plan.final.review = review;
      if (!review.passed) return this.fixupOrStop(`Final review failed: ${review.reason}`, stop);
      plan.status = 'awaiting-approval';
      plan.finishedAt = new Date().toISOString();
      this.record(null, 'plan-ready', `Branch ${this.workspace.branch} awaits the owner's merge (${planChange.stat}).`);
      this.store.save(this.state);
      return true;
    } catch (error) {
      // An interrupt leaves the plan running but paused; anything else blocks it.
      if (error instanceof InterruptedError) return stop(error.message, 'running');
      return stop(`Final phase failed: ${error.message ?? String(error)}`);
    } finally {
      this.busy = false;
      this.current = null;
    }
  }

  // A failed final phase turns its findings into one more task, run like any other (sandbox,
  // gates, checks, review, commit), then the final phase repeats. Bounded by fixupRounds.
  fixupOrStop(reason, stop) {
    const plan = this.state.plan;
    plan.fixups ??= 0;
    if (plan.fixups >= (plan.limits.fixupRounds ?? 1)) return stop(reason);
    plan.fixups += 1;
    const id = `final-fixup-${plan.fixups}`;
    const task = { id, title: `Fix the final review's findings (round ${plan.fixups})`,
      acceptance: `Fix these findings, staying within the allowed paths, with tests where they apply. ${reason}`, fixup: true };
    plan.tasks.push(task);
    const last = this.state.tasks.at(-1);
    this.add({ ...task, maxAttempts: plan.limits.attemptsPerTask, dependencies: last ? [last.id] : [] });
    this.record(id, 'final-fixup-added', reason.slice(0, 4000));
    this.store.save(this.state);
    return true;
  }

  block(task, error) {
    // An abort can surface as a provider error (for example a killed process); the
    // owner's interrupt is the real cause.
    if (this.current?.abort.signal.aborted && !(error instanceof InterruptedError)) error = this.current.abort.signal.reason;
    task.status = 'blocked';
    task.reason = error instanceof BlockedError ? error.message : `Execution uncertain: ${error.message ?? String(error)}`;
    this.record(task.id, 'blocked', task.reason);
    if (error instanceof InterruptedError) {
      // The provider may never report completion for a stopped turn.
      for (const session of Object.values(task.sessions ?? {})) {
        if (['dispatching', 'running'].includes(session.status)) session.status = 'interrupted';
      }
      this.record(task.id, 'interrupted', 'Queue paused: the owner has taken over. Retry the task and resume when ready.');
      this.state.paused = true;
    }
    if (error instanceof BillingGuardError) {
      this.record(null, 'billing-guard', 'Queue paused: fix the sign-in, then retry the task and resume.');
      this.state.paused = true;
    }
    this.store.save(this.state);
  }

  async run({ maxDispatches = 20 } = {}) {
    if (!Number.isInteger(maxDispatches) || maxDispatches < 1) throw new Error('maxDispatches must be a positive integer.');
    let dispatched = 0;
    while (dispatched < maxDispatches && await this.tick()) dispatched += 1;
    return { dispatched, state: this.snapshot() };
  }
}
