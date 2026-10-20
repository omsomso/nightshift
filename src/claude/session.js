import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { BlockedError, BillingGuardError, UsageLimitError, TurnTimeoutError } from '../supervisor.js';
import { deadline } from '../deadline.js';
import { parseUsageLimit, resetFromEvent } from '../limits.js';
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
// The git subcommands edit-mode workers may never run (also listed in editSettings below).
export const gitHistoryCommand = /^\s*git\s+(?:-C\s+\S+\s+)?(push|commit|remote|reset|rebase|merge|tag|worktree|config)\b/;

// Edit mode (docs/EDIT_MODE.md): file tools stay inside the worktree (--restricted), and
// shell commands run in the OS sandbox with writes limited to the worktree and temp, no
// network, no unsandboxed fallback, and credential directories unreadable. Git history
// commands are denied outright; Nightshift makes the commits.
export const editTools = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'];
export const editSettings = {
  sandbox: {
    enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true,
    network: { allowedDomains: [], strictAllowlist: true },
    filesystem: { denyRead: ['~/.ssh', '~/.aws', '~/.gnupg', '~/.config/gh', '~/.codex', '~/.claude', '~/Library/Keychains'] }
  },
  permissions: { deny: ['WebFetch', 'WebSearch', ...['push', 'commit', 'remote', 'reset', 'rebase', 'merge', 'tag', 'worktree', 'config']
    .map(sub => `Bash(git ${sub}:*)`)] }
};

export function claudeArgs({ sessionId, resume, outputSchema, model, maxBudgetUsd, edit = false, addDirs = [], effort }) {
  const tools = edit ? editTools : readOnlyTools;
  return ['-p', '--output-format', 'stream-json', '--verbose',
    resume ? '--resume' : '--session-id', sessionId,
    ...(outputSchema ? ['--json-schema', JSON.stringify(outputSchema)] : []),
    '--tools', tools.join(','), '--allowedTools', tools.join(','),
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--restricted', '--strict-mcp-config',
    ...(edit ? ['--settings', JSON.stringify(editSettings)] : []),
    ...addDirs.flatMap(dir => ['--add-dir', dir]),
    ...(effort ? ['--effort', effort] : []),
    ...(model ? ['--model', model] : []),
    ...(maxBudgetUsd ? ['--max-budget-usd', String(maxBudgetUsd)] : [])];
}

// What a tool call touches, for the live activity view: a path, pattern, or command.
export function toolTarget(input) {
  if (!input || typeof input !== 'object') return undefined;
  const value = input.file_path ?? input.path ?? input.notebook_path ?? input.pattern ?? input.command ?? input.url;
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').slice(0, 160) : undefined;
}

// One headless `claude -p` process per turn. The prompt goes over stdin, never argv.
export class ClaudeSession {
  constructor({ cwd, model, maxBudgetUsd, timeoutMs = 300_000, command = 'claude', baseArgs = [], maxLineBytes = 4_194_304, edit = false, addDirs = [] }) {
    if (!cwd) throw new Error('A project directory is required.');
    Object.assign(this, { cwd, model, maxBudgetUsd, timeoutMs, command, baseArgs, maxLineBytes, edit, addDirs });
  }

  // `timeoutMs` (number or function) overrides the session's; a function lets the plan's time
  // per turn change while the turn runs.
  async run({ prompt, session, outputSchema, onEvent = () => {}, signal, effort, timeoutMs }) {
    signal?.throwIfAborted();
    const emit = event => onEvent({ provider: 'claude', ...event });
    const resume = Boolean(session?.threadId);
    // The session ID is chosen here, so it is persisted before any process starts.
    const sessionId = session?.threadId ?? randomUUID();
    emit({ type: 'session', threadId: sessionId });
    emit({ type: 'dispatch-intent', threadId: sessionId });

    const child = spawn(this.command, [...this.baseArgs,
      ...claudeArgs({ sessionId, resume, outputSchema, model: this.model, maxBudgetUsd: this.maxBudgetUsd, edit: this.edit, addDirs: this.addDirs, effort })],
      { cwd: this.cwd, env: subscriptionEnv(), stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    const closed = new Promise(resolve => child.once('close', resolve));
    const lines = new JsonlDecoder({ label: 'Claude stream', maxLineBytes: this.maxLineBytes });
    const turn = { sessionId, emit, turnId: null, finished: false, structured: Boolean(outputSchema) };
    let timer;
    let onAbort;
    try {
      return await new Promise((resolve, reject) => {
        const finish = (error, value) => {
          if (turn.finished) return;
          turn.finished = true;
          if (error) reject(error); else resolve(value);
        };
        timer = deadline(timeoutMs ?? this.timeoutMs, ms => finish(new TurnTimeoutError('Claude', ms / 60_000)));
        // Interrupt: settle now; the finally block terminates the process.
        onAbort = () => finish(signal.reason);
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
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
              if (result) return finish(null, result.value);
            }
          } catch (error) { finish(error); }
        });
        if (child.pid) child.stdin.end(prompt); // Otherwise the spawn error event reports the failure.
      });
    } finally {
      timer?.();
      if (onAbort) signal?.removeEventListener('abort', onAbort);
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
    // Newer CLIs announce limits as their own message; the result that follows is the failure.
    if (message.type === 'rate_limit_event') {
      const info = message.rate_limit_info ?? {};
      if (info.status === 'rejected') turn.limit = resetFromEvent(info.resetsAt) ?? parseUsageLimit('usage limit reached');
      return null;
    }
    if (message.session_id !== sessionId) return null;
    if (!turn.turnId && message.type === 'result') throw new Error('Claude finished before reporting its session; outcome is uncertain.');
    if (message.type === 'assistant') {
      for (const block of message.message?.content ?? []) {
        if (block.type === 'text') emit({ type: 'output', threadId: sessionId, turnId: turn.turnId, text: block.text ?? '' });
        if (block.type === 'tool_use') emit({ type: 'tool-activity', threadId: sessionId, turnId: turn.turnId, tool: block.name, toolUseId: block.id, target: toolTarget(block.input) });
      }
      return null;
    }
    if (message.type !== 'result') return null;
    // Observed with 2.1.296: sign-in and API failures report subtype "success" with is_error=true.
    const status = message.is_error ? (message.subtype === 'success' ? 'error' : message.subtype)
      : message.subtype === 'success' ? 'completed' : message.subtype;
    const u = message.usage ?? {};
    // Normalized like Codex: input includes cached reads and cache writes.
    const tokens = { input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      cachedInput: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0 };
    emit({ type: 'usage', threadId: sessionId, turnId: turn.turnId, costUsd: message.total_cost_usd,
      numTurns: message.num_turns, durationMs: message.duration_ms, tokens, usage: message.usage });
    emit({ type: 'turn-completed', threadId: sessionId, turnId: turn.turnId, status, terminalReason: message.terminal_reason });
    // A denied request (git history, a file outside the working copy, the network) is the
    // fence working, not a reason to stop: the agent was told no and carried on, and its
    // change still goes through the gates, checks, and review. Each denial is recorded.
    const denials = message.permission_denials ?? [];
    const gitHistory = denial => denial.tool_name === 'Bash' && gitHistoryCommand.test(String(denial.tool_input?.command ?? ''));
    for (const denial of denials) {
      emit({ type: 'policy-denied', threadId: sessionId, turnId: turn.turnId, tool: denial.tool_name, toolUseId: denial.tool_use_id,
        target: toolTarget(denial.tool_input), command: denial.tool_name === 'Bash' ? String(denial.tool_input?.command ?? '').slice(0, 200) : undefined,
        reason: gitHistory(denial) ? 'Git history is Nightshift\'s job; left for the owner.' : 'Outside what this agent may do; the agent was told no and continued.' });
    }
    if (status !== 'completed') {
      const text = `${message.errors?.join('; ') ?? ''} ${message.result ?? ''}`;
      const limit = turn.limit ?? parseUsageLimit(text);
      if (limit) throw new UsageLimitError(`Claude reached its usage limit${limit.known ? '' : ' (reset time not reported)'}.`, limit.resetsAt);
      throw new Error(`Claude turn ${status}: ${message.errors?.join('; ') || message.result || 'no result'}`);
    }
    if (!turn.structured) return { value: String(message.result ?? '') };
    let result = message.structured_output;
    if (result === undefined) {
      try { result = JSON.parse(message.result); }
      catch { throw new Error('Final output is not JSON.'); }
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Final output is not a JSON object.');
    return { value: result };
  }
}
