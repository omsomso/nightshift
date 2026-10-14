import { BlockedError, BillingGuardError } from '../supervisor.js';
import { RpcClient } from './rpc-client.js';

// ChatGPT-plan-only billing. These variables can supply or redirect an API key, so none
// reach Codex, and Codex itself is told to refuse API-key login. There is no opt-out.
export function chatgptEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) =>
    !name.startsWith('OPENAI_') && !name.startsWith('AZURE_OPENAI_') && name !== 'CODEX_API_KEY'));
}
export const appServerArgs = ['app-server', '-c', 'forced_login_method="chatgpt"'];
export function createAppServer({ command = 'codex', baseArgs = [], cwd, ...options } = {}) {
  return new RpcClient({ command, args: [...baseArgs, ...appServerArgs], cwd, env: chatgptEnv(), ...options });
}

export class CodexSession {
  constructor({ cwd, model, timeoutMs = 300_000, createClient = () => createAppServer({ cwd }) }) {
    if (!cwd) throw new Error('A project directory is required.');
    this.cwd = cwd;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.createClient = createClient;
  }

  async run({ prompt, session, outputSchema, onEvent = () => {} }) {
    const client = this.createClient();
    const emit = event => onEvent({ provider: 'codex', ...event });
    const blockOnRequest = message => {
      emit({ type: 'approval-required', method: message.method, requestId: message.id,
        threadId: message.params?.threadId, turnId: message.params?.turnId,
        ...(typeof message.params?.command === 'string' ? { command: message.params.command.slice(0, 500) } : {}),
        reason: message.params?.reason ?? 'Provider requires input that this adapter cannot supply.' });
      client.fail(new BlockedError(`Provider request requires human handling: ${message.method}`));
    };
    client.on('serverRequest', blockOnRequest);
    try {
      await client.request('initialize', { clientInfo: { name: 'nightshift', title: 'Nightshift', version: '0.3.0' } });
      client.notify('initialized');
      // Checked before any thread exists, so a wrong account never reaches a model.
      const { account } = await client.request('account/read', { refreshToken: false }) ?? {};
      if (account?.type !== 'chatgpt') {
        throw new BillingGuardError(`Codex is signed in with ${account?.type ?? 'no account'}, not a ChatGPT plan; ` +
          'Nightshift refuses API-key billing.');
      }
      emit({ type: 'account', accountType: account.type, planType: account.planType });
      // Both new and resumed sessions stay read-only in this compatibility milestone.
      // "never" means Codex never asks: the read-only sandbox refuses writes and network
      // and reports the failure to the model. Nothing is approved. Values follow the
      // schema generated from codex-cli 0.162.1.
      const params = { cwd: this.cwd, sandbox: 'read-only', approvalPolicy: 'never', modelProvider: 'openai',
        ...(this.model ? { model: this.model } : {}) };
      const opened = session?.threadId
        ? await client.request('thread/resume', { ...params, threadId: session.threadId, excludeTurns: true })
        : await client.request('thread/start', params);
      if (opened?.modelProvider !== 'openai') {
        throw new BillingGuardError(`Codex selected model provider ${opened?.modelProvider ?? 'unknown'}, not openai; refusing to run.`);
      }
      const threadId = opened?.thread?.id;
      if (!threadId || (session?.threadId && threadId !== session.threadId)) throw new Error('Codex returned an invalid thread ID.');
      if (opened.thread.status?.type === 'active') throw new BlockedError('Existing Codex thread is still active; reconciliation is required.');
      // A synchronous persistence callback must succeed before turn/start is sent.
      emit({ type: 'session', threadId });
      return await this.turn(client, { threadId, prompt, outputSchema, emit });
    } finally {
      client.removeListener('serverRequest', blockOnRequest);
      await client.close();
    }
  }

  async turn(client, { threadId, prompt, outputSchema, emit }) {
    let turnId;
    let buffer = [];
    let finalText = '';
    let finished = false;
    let resolveTurn;
    let rejectTurn;
    const completion = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
    // Register a rejection handler immediately: events may arrive before the RPC response.
    completion.catch(() => {});
    const fail = error => { if (!finished) { finished = true; rejectTurn(error); } };
    const consume = message => {
      if (finished) return;
      const p = message.params ?? {};
      if (p.threadId !== threadId) return;
      const eventTurnId = p.turnId ?? p.turn?.id;
      if (eventTurnId !== turnId) return;
      try {
        if (message.method === 'item/agentMessage/delta') {
          emit({ type: 'output', threadId, turnId, text: p.delta ?? '' });
        } else if (message.method === 'item/completed') {
          const item = p.item ?? {};
          if (item.type === 'agentMessage' && typeof item.text === 'string') finalText = item.text;
          emit({ type: 'item-completed', threadId, turnId, item });
        } else if (message.method === 'turn/completed') {
          emit({ type: 'turn-completed', threadId, turnId, status: p.turn.status });
          if (p.turn.status !== 'completed') throw new Error(`Codex turn ${p.turn.status}: ${p.turn.error?.message ?? 'no result'}`);
          const result = JSON.parse(finalText);
          if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Final output is not a JSON object.');
          finished = true;
          resolveTurn(result);
        } else if (message.method === 'error') {
          emit({ type: 'provider-error', threadId, turnId, message: p.error?.message ?? 'Provider error', willRetry: p.willRetry === true });
          if (!p.willRetry) throw new Error(p.error?.message ?? 'Codex turn failed.');
        }
      } catch (error) { fail(error); }
    };
    const notification = message => {
      if (turnId) return consume(message);
      if (message.params?.threadId !== threadId) return;
      buffer.push(message);
      if (buffer.length > 2048) fail(new Error('Too many events arrived before the turn response.'));
    };
    const timer = setTimeout(() => fail(new Error('Codex turn timed out; reconcile its external effects before retrying.')), this.timeoutMs);
    client.on('notification', notification);
    client.on('fatal', fail);
    try {
      emit({ type: 'dispatch-intent', threadId });
      const started = await Promise.race([client.request('turn/start', {
        threadId, input: [{ type: 'text', text: prompt }],
        cwd: this.cwd, approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' }, outputSchema
      }), completion]);
      turnId = started?.turn?.id;
      if (!turnId) throw new Error('Codex returned no turn ID; dispatch outcome is uncertain.');
      emit({ type: 'turn-started', threadId, turnId });
      for (const event of buffer) consume(event);
      buffer = [];
      return await completion;
    } catch (error) {
      fail(error);
      // Best effort only. Never interpret interrupt acknowledgement as rollback.
      if (turnId && !client.failure) {
        try { await client.request('turn/interrupt', { threadId, turnId }, { timeoutMs: 1000 }); } catch {}
      }
      throw error;
    } finally {
      clearTimeout(timer);
      client.removeListener('notification', notification);
      client.removeListener('fatal', fail);
    }
  }
}
