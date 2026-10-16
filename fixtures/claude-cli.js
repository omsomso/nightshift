// A `claude -p` stream fixture, not a model or an alternative Claude runtime.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const [mode = 'normal', ...flags] = process.argv.slice(2);
const value = name => { const index = flags.indexOf(name); return index >= 0 ? flags[index + 1] : undefined; };
const has = name => flags.includes(name);
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const sessionId = value('--resume') ?? value('--session-id');
const fail = (message, code = 1) => {
  send({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, errors: [message] });
  process.exit(code);
};

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const base = has('-p') && value('--output-format') === 'stream-json' &&
    value('--permission-mode') === 'dontAsk' && value('--permission-prompts') === 'none' &&
    has('--restricted') && has('--strict-mcp-config');
  const settings = value('--settings') ? JSON.parse(value('--settings')) : null;
  const sandbox = settings?.sandbox;
  const editMode = value('--tools') === 'Read,Grep,Glob,Edit,Write,Bash' && sandbox?.enabled === true &&
    sandbox.failIfUnavailable === true && sandbox.allowUnsandboxedCommands === false &&
    sandbox.network?.allowedDomains?.length === 0 && sandbox.network.strictAllowlist === true &&
    settings.permissions?.deny?.includes('Bash(git push:*)');
  const readOnly = value('--tools') === 'Read,Grep,Glob' && !settings;
  if (!base || !(readOnly || editMode)) return fail('Expected read-only policy or the sandboxed edit policy');
  const leaked = Object.keys(process.env).filter(name => name.startsWith('ANTHROPIC_') || name.startsWith('CLAUDE_CODE_USE_'));
  if (leaked.length) return fail(`Billing variables leaked: ${leaked.join(', ')}`);
  if (!sessionId) return fail('Expected a session ID');
  if (!input.trim()) return fail('Expected the prompt on stdin');
  if (mode === 'malformed') return process.stdout.write('this is not JSON\n');
  if (mode === 'oversize') return process.stdout.write('x'.repeat(5000));
  if (mode === 'disconnect') return process.exit(3);

  const ids = { session_id: sessionId };
  send({ type: 'system', subtype: 'init', session_id: mode === 'wrong-session' ? randomUUID() : sessionId, uuid: randomUUID(),
    model: 'fixture-model', permissionMode: 'dontAsk', apiKeySource: mode === 'api-key' ? 'ANTHROPIC_API_KEY' : 'none', tools: ['Read', 'Grep', 'Glob'],
    resumed: has('--resume') });
  if (mode === 'stall' || mode === 'api-key') return setInterval(() => {}, 1000); // api-key: must be killed, not awaited
  if (!value('--json-schema') && input.includes('take your time')) return setInterval(() => {}, 1000); // a turn that only ends when stopped
  if (!value('--json-schema') && input.includes('pasted quick notes')) {
    const reply = 'These notes are about the repo project.\n```nightshift-repo\n' + process.cwd() + '/repo\n```\nA question first:\n```nightshift-questions\n[{"question": "Keep notes short?", "options": ["Yes", "No"], "multiple": false}]\n```';
    return send({ type: 'result', subtype: 'success', is_error: false, ...ids, result: reply, usage: { input_tokens: 5, output_tokens: 5 }, permission_denials: [] });
  }
  if (!value('--json-schema')) {
    const reply = has('--resume') ? 'Revised:\n```markdown\n# Plan\n\n1. Write note one.\n2. Write note two.\n```'
      : 'A first draft:\n```markdown\n# Plan\n\n1. Write note one.\n```\nShall I add more?';
    return send({ type: 'result', subtype: 'success', is_error: false, ...ids, result: reply, usage: { input_tokens: 5, output_tokens: 5 }, permission_denials: [] });
  }
  const isReview = JSON.parse(value('--json-schema')).required.includes('passed');
  // An edit-mode worker changes one file per task, as a real agent would.
  if (editMode && !isReview) {
    const n = /Task (\d+) of/.exec(input)?.[1] ?? 'x';
    mkdirSync('notes', { recursive: true });
    writeFileSync(`notes/task-${n}.txt`, `${process.env.FIXTURE_EDIT_CONTENT ?? 'done'} by claude fixture\n`);
  }
  const isPlanner = JSON.parse(value('--json-schema')).required.includes('tasks');
  const result = isPlanner ? { id: 'Fixture Notes!', brief: 'Write two notes.', checks: ['node check.js'], allowedPaths: ['notes/'], notes: '',
      tasks: [{ id: 'note-one', title: 'Write note one', acceptance: 'A first note exists.', difficulty: 'low', difficultyReason: 'One small file.' }, { id: 'note-two', title: 'Write note two', acceptance: 'A second note exists.', difficulty: 'high', difficultyReason: 'Pretend this is subtle.' }] }
    : isReview ? { passed: true, reason: 'Fixture review only.' }
    : { summary: 'Fixture résumé 🦉', evidence: ['fixture:README.md'] };
  // An unrelated session's result must not complete this turn.
  send({ type: 'result', subtype: 'success', is_error: false, session_id: 'unrelated-session', structured_output: { summary: 'wrong', evidence: ['x'] } });
  send({ type: 'assistant', ...ids, message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'README.md' } }] } });
  const text = Buffer.from(JSON.stringify({ type: 'assistant', ...ids, message: { content: [{ type: 'text', text: 'Résumé 🦉' }] } }) + '\n');
  // Deliberately split inside an UTF-8 code point and inside the JSONL framing.
  const split = text.indexOf(Buffer.from('🦉')) + 1;
  process.stdout.write(text.subarray(0, split));
  setTimeout(() => {
    process.stdout.write(text.subarray(split));
    const final = { type: 'result', subtype: 'success', is_error: false, ...ids, num_turns: 2, duration_ms: 12,
      total_cost_usd: 0.0123, usage: { input_tokens: 10, output_tokens: 5 }, permission_denials: [],
      result: JSON.stringify(result), structured_output: result };
    if (mode === 'denial') final.permission_denials = [{ tool_name: 'Bash', tool_use_id: 'toolu_2', tool_input: { command: 'rm -rf build' } }];
    if (mode === 'git-denial') final.permission_denials = [{ tool_name: 'Bash', tool_use_id: 'toolu_3', tool_input: { command: 'git commit -am "step done"' } }];
    // Shapes of a subscription limit: an older text form with an epoch, and a newer event.
    if (mode === 'usage-limit') Object.assign(final, { is_error: true, result: 'Claude AI usage limit reached|' + (Math.floor(Date.now() / 1000) + 3600), structured_output: undefined });
    if (mode === 'limit-event') {
      send({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 7200, rateLimitType: 'five_hour' } });
      Object.assign(final, { is_error: true, result: "You've hit your limit", structured_output: undefined });
    }
    if (mode === 'error-result') Object.assign(final, { subtype: 'error_max_turns', is_error: true, result: undefined, structured_output: undefined });
    if (mode === 'bad-output') Object.assign(final, { result: 'not JSON', structured_output: undefined });
    if (mode === 'text-result') final.structured_output = undefined;
    // Shape observed from claude 2.1.296 when no account is signed in.
    if (mode === 'not-logged-in') Object.assign(final, { is_error: true, terminal_reason: 'api_error',
      result: 'Not logged in · Please run /login', structured_output: undefined });
    send(final);
  }, 5);
});
