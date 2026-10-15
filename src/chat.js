import { buildPlanner, gitRoot } from './providers.js';
import { chatPrompt } from './prompts.js';
import { collectRules } from './rules.js';

// One turn of the plan chat. The first turn sets the assistant's role and the project rules;
// later turns resume the same Claude conversation by its session id.
export async function chatTurn({ repo, session, message }) {
  if (!message?.trim()) throw new Error('Give a message.');
  const cwd = gitRoot(repo);
  const planner = buildPlanner('claude', cwd);
  let id = session ?? null;
  const prompt = session ? message : chatPrompt({ repo: cwd, rules: collectRules(cwd), message });
  const reply = await planner.session.run({ prompt, session: session ? { threadId: session } : undefined, outputSchema: null,
    onEvent: event => { if (event.type === 'session') id = event.threadId; } });
  return { session: id, repo: cwd, reply, document: lastMarkdownBlock(reply) };
}

// The last ```markdown (or ```md) block in a reply, without its fences.
export function lastMarkdownBlock(text) {
  const blocks = [...String(text).matchAll(/```(?:markdown|md)\s*\n([\s\S]*?)\n```/g)];
  return blocks.length ? blocks.at(-1)[1].trim() + '\n' : null;
}
