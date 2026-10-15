import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildPlanner, gitRoot } from './providers.js';
import { chatPrompt, interviewPrompt } from './prompts.js';
import { collectRules, rulesBlock } from './rules.js';
import { listProjects, workspaceRoots } from './projects.js';

// One turn of a plan conversation with a read-only Claude session. Two ways to start:
// - repository chat: --repo given; the session works in that repository;
// - interview from notes: --notes; the session works from the workspace root, picks the
//   project itself, asks multiple-choice questions, and writes the roadmap.
// Later turns resume the same conversation (--session) in the same folder (--cwd).
export async function chatTurn({ repo, session, message, notes = false, cwd, withRules = false }) {
  if (!message?.trim()) throw new Error('Give a message.');
  const roots = workspaceRoots();
  const folder = resolve(cwd ?? (notes || !repo ? roots[0] : gitRoot(repo)));
  const isWorkspace = notes || !repo;
  const planner = buildPlanner('claude', folder, { folder: true, addDirs: isWorkspace ? roots.slice(1) : [] });
  let id = session ?? null;
  let prompt = message;
  if (!session) {
    prompt = isWorkspace
      ? interviewPrompt({ projects: listProjects(roots), rules: collectRules(folder), notes: message, repo: repo ? gitRoot(repo) : null })
      : chatPrompt({ repo: folder, rules: collectRules(folder), message });
  } else if (withRules && repo) {
    // Once the project is known, give the conversation that project's rules.
    prompt = `${rulesBlock(collectRules(gitRoot(repo)))}\n\n${message}`;
  }
  const reply = await planner.session.run({ prompt, session: session ? { threadId: session } : undefined, outputSchema: null,
    onEvent: event => { if (event.type === 'session') id = event.threadId; } });
  return { session: id, cwd: folder, ...parseReply(reply) };
}

// Splits a reply into readable text and the machine blocks the app acts on.
export function parseReply(reply) {
  const text = String(reply);
  const blocks = name => [...text.matchAll(new RegExp('```' + name + '\\s*\\n([\\s\\S]*?)\\n```', 'g'))].map(m => m[1].trim());
  const repoPath = blocks('nightshift-repo').at(-1) ?? null;
  const repo = repoPath && existsSync(join(repoPath, '.git')) ? repoPath : null;
  let questions = null;
  const raw = blocks('nightshift-questions').at(-1);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      questions = (Array.isArray(parsed) ? parsed : []).slice(0, 6)
        .filter(q => typeof q?.question === 'string' && q.question.trim())
        .map(q => ({ question: q.question.trim(), multiple: q.multiple === true,
          options: (Array.isArray(q.options) ? q.options : []).filter(o => typeof o === 'string' && o.trim()).slice(0, 8) }));
    } catch { questions = null; }
  }
  const document = blocks('(?:markdown|md)').at(-1);
  const display = text.replace(/```nightshift-(?:repo|questions)\s*\n[\s\S]*?\n```\s*/g, '').trim();
  return { reply: display, repo, repoMentioned: repoPath, questions: questions?.length ? questions : null,
    document: document ? `${document}\n` : null };
}

export const lastMarkdownBlock = text => parseReply(text).document;
