import { CodexSession } from '../codex/session.js';
import { AgentWorker, AgentReviewer } from './agent.js';

export class CodexAdapter extends AgentWorker {
  constructor(options) { super('codex', new CodexSession(options)); }
}

export class CodexReviewer extends AgentReviewer {
  constructor(options) { super('codex', new CodexSession(options)); }
}
