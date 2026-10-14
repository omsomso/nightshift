// A subprocess protocol fixture, not a model or an alternative Codex runtime.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const mode = process.argv[2] ?? 'normal';
let initialized = false;
let threadId;
let currentTurn;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const response = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });
const rpcError = (id, message) => send({ id, error: { code: -32000, message } });

createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    if (mode === 'malformed') return process.stdout.write('this is not JSON\n');
    if (mode === 'rpc-error') return rpcError(m.id, 'Fixture initialization failed');
    if (mode === 'rpc-timeout') return;
    if (mode === 'oversize') return process.stdout.write('x'.repeat(5000));
    return response(m.id, { userAgent: 'nightshift-fixture' });
  }
  if (m.method === 'initialized') { initialized = true; return; }
  if (!initialized) return rpcError(m.id, 'Not initialized');
  if (['thread/start', 'thread/resume'].includes(m.method)) {
    if (m.params.sandbox !== 'readOnly' || m.params.approvalPolicy !== 'unlessTrusted') {
      return rpcError(m.id, 'Expected read-only policy');
    }
    threadId = m.params.threadId ?? `thread-${randomUUID()}`;
    return response(m.id, { thread: { id: threadId, status: { type: mode === 'active' ? 'active' : 'idle' } } });
  }
  if (m.method === 'turn/interrupt') return response(m.id, {});
  if (m.method !== 'turn/start') return rpcError(m.id, `Unexpected method ${m.method}`);
  if (m.params.sandboxPolicy?.type !== 'readOnly') return rpcError(m.id, 'Expected read-only turn');
  currentTurn = `turn-${randomUUID()}`;
  if (mode === 'disconnect') return process.exit(3);
  if (mode === 'start-stall') return;
  if (mode !== 'early') response(m.id, { turn: { id: currentTurn, status: 'inProgress' } });
  if (mode === 'stall') return;
  if (mode === 'approval') {
    return send({ id: 'approval-1', method: 'item/commandExecution/requestApproval',
      params: { threadId, turnId: currentTurn, reason: 'Fixture needs permission.' } });
  }
  const ids = { threadId, turnId: currentTurn };
  const isReview = m.params.outputSchema.required.includes('passed');
  const result = isReview ? { passed: true, reason: 'Fixture review only.' }
    : { summary: 'Fixture résumé 🦉', evidence: ['fixture:README.md'] };
  notify('turn/completed', { threadId: 'unrelated-thread', turn: { id: currentTurn, status: 'completed' } });
  notify('turn/completed', { threadId, turn: { id: 'unrelated-turn', status: 'failed' } });
  const delta = Buffer.from(JSON.stringify({ method: 'item/agentMessage/delta', params: { ...ids, delta: 'Résumé 🦉' } }) + '\n');
  // Deliberately split inside an UTF-8 code point and inside the JSONL framing.
  const split = delta.indexOf(Buffer.from('🦉')) + 1;
  process.stdout.write(delta.subarray(0, split));
  setTimeout(() => {
    process.stdout.write(delta.subarray(split));
    notify('item/completed', { ...ids, item: { id: 'message-1', type: 'agentMessage',
      text: mode === 'bad-output' ? 'not JSON' : JSON.stringify(result) } });
    notify('turn/completed', { threadId, turn: { id: currentTurn,
      status: mode === 'failed-turn' ? 'failed' : 'completed', error: mode === 'failed-turn' ? { message: 'Fixture failure' } : null } });
    if (mode === 'early') response(m.id, { turn: { id: currentTurn, status: 'inProgress' } });
  }, 5);
});
