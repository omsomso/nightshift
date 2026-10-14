import { ClaudeSession } from '../claude/session.js';
import { AgentWorker, AgentReviewer } from './agent.js';

export class ClaudeAdapter extends AgentWorker {
  constructor(options) { super('claude', new ClaudeSession(options)); }
}

export class ClaudeReviewer extends AgentReviewer {
  constructor(options) { super('claude', new ClaudeSession(options)); }
}
