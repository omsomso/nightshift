import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { BlockedError, BillingGuardError } from '../supervisor.js';
import { JsonlDecoder } from '../jsonl.js';

// Subscription-only billing. Every ANTHROPIC_* variable (API key, auth token, base URL,
// profile, federation) and every cloud-provider switch can outrank a claude.ai sign-in,
// so none of them reach the CLI. There is deliberately no opt-out setting.
export function subscriptionEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) =>
    !name.startsWith('ANTHROPIC_') && !name.startsWith('CLAUDE_CODE_USE_')));
}

// Read-only surface for this milestone: only file-reading tools exist, nothing can prompt,
// MCP servers and settings-file hooks are not loaded, and file tools stay inside cwd.
export const readOnlyTools = ['Read', 'Grep', 'Glob'];

export function claudeArgs({ sessionId, resume, outputSchema, model, maxBudgetUsd }) {
  return ['-p', '--output-format', 'stream-json', '--verbose',
    resume ? '--resume' : '--session-id', sessionId,
    '--json-schema', JSON.stringify(outputSchema),
    '--tools', readOnlyTools.join(','), '--allowedTools', readOnlyTools.join(','),
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--restricted', '--strict-mcp-config',
    ...(model ? ['--model', model] : []),
    ...(maxBudgetUsd ? ['--max-budget-usd', String(maxBudgetUsd)] : [])];
}

// One headless `claude -p` process per turn. The prompt goes over stdin, never argv.
export class ClaudeSession {
  constructor({ cwd, model, maxBudgetUsd, timeoutMs = 300_000, command = 'claude', baseArgs = [], maxLineBytes = 4_194_304 }) {
    if (!cwd) throw new Error('A project directory is required.');
    Object.assign(this, { cwd, model, maxBudgetUsd, timeoutMs, command, baseArgs, maxLineBytes });
  }

  async run({ prompt, session, outputSchema, onEvent = () => {} }) {
    const emit = event => onEvent({ provider: 'claude', ...event });
    const resume = Boolean(session?.threadId);
    // The session ID is chosen here, so it is persisted before any process starts.
    const sessionId = session?.threadId ?? randomUUID();
    emit({ type: 'session', threadId: sessionId });
    emit({ type: 'dispatch-intent', threadId: sessionId });

    const child = spawn(this.command, [...this.baseArgs,
      ...claudeArgs({ sessionId, resume, outputSchema, model: this.model, maxBudgetUsd: this.maxBudgetUsd })],
      { cwd: this.cwd, env: subscriptionEnv(), stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    const closed = new Promise(resolve => child.once('close', resolve));
    const lines = new JsonlDecoder({ label: 'Claude stream', maxLineBytes: this.maxLineBytes });
    const turn = { sessionId, emit, turnId: null, finished: false };
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        const finish = (error, value) => {
          if (turn.finished) return;
          turn.finished = true;
          if (error) reject(error); else resolve(value);
        };
        timer = setTimeout(() => finish(new Error('Claude turn timed out; reconcile its external effects before retrying.')), this.timeoutMs);
        child.on('error', error => finish(new Error(`Claude process could not start: ${error.message}`)));
        child.on('close', (code, signal) => finish(new Error(`Claude process disconnected (${signal ?? code}); reconcile its last turn before retrying.`)));
        child.stdin.on('error', error => finish(error));
        // Drain stderr without copying possible credentials into the project event log.
        child.stderr.resume();
        child.stdout.on('data', chunk => {
          if (turn.finished) return;
          try {
            for (const message of lines.push(chunk)) {
              const result = this.consume(turn, message);
              if (result) return finish(null, result);
            }
          } catch (error) { finish(error); }
        });
        if (child.pid) child.stdin.end(prompt); // Otherwise the spawn error event reports the failure.
      });
    } finally {
      clearTimeout(timer);
      // Best effort only. Terminating the process never rolls back earlier effects.
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        child.kill('SIGTERM');
        const kill = setTimeout(() => child.kill('SIGKILL'), 1000);
        try { await closed; } finally { clearTimeout(kill); }
      } else await closed;
    }
  }

  // Returns the parsed final object once the turn succeeds; throws on any failure.
  consume(turn, message) {
    const { sessionId, emit } = turn;
    if (message.type === 'system' && message.subtype === 'init') {
      if (message.session_id !== sessionId) throw new Error('Claude returned a different session ID; reconcile before retrying.');
      // "none" is what a claude.ai sign-in reports. Anything else (or a missing field)
      // means an API key or helper would pay; the process is killed as soon as this throws.
      if (message.apiKeySource !== 'none') {
        throw new BillingGuardError(`Claude reported API-key billing (${message.apiKeySource ?? 'unknown source'}); ` +
          'Nightshift only runs on a claude.ai subscription sign-in.');
      }
      turn.turnId = message.uuid ?? null;
      emit({ type: 'turn-started', threadId: sessionId, turnId: turn.turnId, model: message.model,
        permissionMode: message.permissionMode, authSource: message.apiKeySource });
      return null;
    }
    if (message.session_id !== sessionId) return null;
    if (!turn.turnId && message.type === 'result') throw new Error('Claude finished before reporting its session; outcome is uncertain.');
    if (message.type === 'assistant') {
      for (const block of message.message?.content ?? []) {
        if (block.type === 'text') emit({ type: 'output', threadId: sessionId, turnId: turn.turnId, text: block.text ?? '' });
        if (block.type === 'tool_use') emit({ type: 'tool-activity', threadId: sessionId, turnId: turn.turnId, tool: block.name, toolUseId: block.id });
      }
      return null;
    }
    if (message.type !== 'result') return null;
    // Observed with 2.1.296: sign-in and API failures report subtype "success" with is_error=true.
    const status = message.is_error ? (message.subtype === 'success' ? 'error' : message.subtype)
      : message.subtype === 'success' ? 'completed' : message.subtype;
    emit({ type: 'usage', threadId: sessionId, turnId: turn.turnId, costUsd: message.total_cost_usd,
      numTurns: message.num_turns, durationMs: message.duration_ms, usage: message.usage });
    emit({ type: 'turn-completed', threadId: sessionId, turnId: turn.turnId, status, terminalReason: message.terminal_reason });
    const denials = message.permission_denials ?? [];
    for (const denial of denials) {
      emit({ type: 'approval-required', threadId: sessionId, turnId: turn.turnId, tool: denial.tool_name,
        toolUseId: denial.tool_use_id, reason: 'Denied automatically: this adapter never approves tool requests.' });
    }
    if (denials.length) {
      throw new BlockedError(`Provider request requires human handling: denied ${denials.map(d => d.tool_name).join(', ')}`);
    }
    if (status !== 'completed') throw new Error(`Claude turn ${status}: ${message.errors?.join('; ') || message.result || 'no result'}`);
    let result = message.structured_output;
    if (result === undefined) {
      try { result = JSON.parse(message.result); }
      catch { throw new Error('Final output is not JSON.'); }
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Final output is not a JSON object.');
    return result;
  }
}
