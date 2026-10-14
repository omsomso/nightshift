import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { JsonlDecoder } from '../jsonl.js';

// JSONL transport only. Provider policy and task decisions belong above this layer.
export class RpcClient extends EventEmitter {
  constructor({ command = 'codex', args = ['app-server'], cwd, requestTimeoutMs = 30_000, maxLineBytes = 4_194_304 } = {}) {
    super();
    this.pending = new Map();
    this.nextId = 1;
    this.requestTimeoutMs = requestTimeoutMs;
    this.lines = new JsonlDecoder({ label: 'Codex protocol', maxLineBytes });
    this.failure = null;
    this.closing = false;
    this.child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    this.closed = new Promise(resolve => this.child.once('close', resolve));
    this.child.on('error', error => this.fail(new Error(`Codex process could not start: ${error.message}`)));
    this.child.on('close', (code, signal) => {
      if (!this.closing) this.fail(new Error(`Codex process disconnected (${signal ?? code}); reconcile its last turn before retrying.`));
    });
    this.child.stdin.on('error', error => this.fail(error));
    // Drain stderr without copying possible credentials into the project event log.
    this.child.stderr.resume();
    this.child.stdout.on('data', chunk => this.read(chunk));
  }

  read(chunk) {
    if (this.failure || this.closing) return;
    try {
      for (const message of this.lines.push(chunk)) {
        this.dispatch(message);
        if (this.failure || this.closing) return;
      }
    } catch (error) { this.fail(error); }
  }

  dispatch(message) {
    if (typeof message.method === 'string') {
      this.emit(Object.hasOwn(message, 'id') ? 'serverRequest' : 'notification', message);
    } else if (Object.hasOwn(message, 'id')) {
      const pending = this.pending.get(message.id);
      if (!pending) return; // A late response cannot resolve another request.
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`Codex RPC ${pending.method} failed: ${message.error.message ?? 'unknown error'}`));
      else if (Object.hasOwn(message, 'result')) pending.resolve(message.result);
      else pending.reject(new Error('Codex response has neither result nor error.'));
    } else throw new Error('Codex protocol failure: Invalid Codex protocol message.');
  }

  send(message) {
    if (this.failure) throw this.failure;
    if (this.closing) throw new Error('Codex connection is closed.');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  notify(method, params = {}) { this.send({ method, params }); }

  request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      if (this.failure || this.closing) return reject(this.failure ?? new Error('Codex connection is closed.'));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex RPC ${method} timed out; dispatch outcome may be uncertain.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit('fatal', error);
  }

  async close() {
    if (this.closing) return this.closed;
    this.closing = true;
    this.fail(new Error('Codex connection closed.'));
    if (this.child.exitCode !== null || this.child.signalCode !== null || !this.child.pid) return this.closed;
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 1000);
    try { await this.closed; } finally { clearTimeout(timer); }
  }
}
