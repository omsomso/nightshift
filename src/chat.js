import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildPlanner, gitRoot } from './providers.js';
import { chatPrompt, interviewPrompt } from './prompts.js';
import { collectRules, rulesBlock } from './rules.js';
import { listProjects, workspaceRoots } from './projects.js';
import { validateEffort, plannerEffort } from './effort.js';
import { readConfig } from './home.js';
import { resolveBase, snapshot, snapshotDir, describeBase } from './base.js';

// One turn of a plan conversation with a read-only Claude session. Two ways to start:
// - repository chat: --repo given; the session works in that repository;
// - interview from notes: --notes; the session works from the workspace root, picks the
//   project itself, asks multiple-choice questions, and writes the roadmap.
// Later turns resume the same conversation (--session) in the same folder (--cwd).
export async function chatTurn({ repo, session, message, notes = false, cwd, withRules = false, signal }) {
  if (!message?.trim()) throw new Error('Give a message.');
  const roots = workspaceRoots();
  const folder = resolve(cwd ?? (notes || !repo ? roots[0] : gitRoot(repo)));
  const isWorkspace = notes || !repo;
  // Once the project is known, the conversation reads a snapshot of the commit the plan will
  // start from (by default the fetched main branch), not whatever is checked out.
  let base = null;
  let baseNote = '';
  const project = repo ? gitRoot(repo) : null;
  if (project && (!session || withRules)) {
    base = resolveBase(project);
    snapshot(project, base.commit);
    baseNote = `Nightshift will start this plan from ${describeBase(base)}. Read the project's code at ${snapshotDir(project)}, a read-only snapshot of that commit; the checkout at ${project} may be on another branch or behind.`;
  }
  const extraDirs = project && existsSync(snapshotDir(project)) ? [snapshotDir(project)] : [];
  const planner = buildPlanner('claude', folder, { folder: true, addDirs: [...(isWorkspace ? roots.slice(1) : []), ...extraDirs] });
  let id = session ?? null;
  let prompt = message;
  if (!session) {
    prompt = isWorkspace
      ? interviewPrompt({ projects: listProjects(roots), rules: collectRules(folder), notes: message, repo: project })
      : chatPrompt({ repo: folder, rules: collectRules(folder), message });
    if (baseNote) prompt = `${baseNote}\n\n${prompt}`;
  } else if (withRules && project) {
    // Once the project is known, give the conversation that project's rules and base.
    prompt = [baseNote, rulesBlock(collectRules(project)), message].filter(Boolean).join('\n\n');
  }
  const reply = await planner.session.run({ prompt, session: session ? { threadId: session } : undefined, outputSchema: null, signal,
    effort: plannerEffort(validateEffort(readConfig().effort)),
    onEvent: event => { if (event.type === 'session') id = event.threadId; } });
  const parsed = parseReply(reply);
  // The interviewer may only now have picked the project: tell the app where it would start.
  if (!base && parsed.repo && !project) { try { base = resolveBase(parsed.repo, { fetch: false }); } catch {} }
  return { session: id, cwd: folder, ...parsed, ...(base ? { base: { ref: base.ref, commit: base.commit, subject: base.subject, date: base.date } } : {}) };
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
          // Options may be plain strings or {label, detail, recommended}; the app always gets objects.
          options: (Array.isArray(q.options) ? q.options : []).map(o => typeof o === 'string' ? { label: o.trim() }
            : o && typeof o.label === 'string' ? { label: o.label.trim(), ...(typeof o.detail === 'string' && o.detail.trim() ? { detail: o.detail.trim() } : {}), ...(o.recommended === true ? { recommended: true } : {}) } : null)
            .filter(o => o?.label).slice(0, 8) }));
    } catch { questions = null; }
  }
  const document = blocks('(?:markdown|md)').at(-1);
  const display = text.replace(/```nightshift-(?:repo|questions)\s*\n[\s\S]*?\n```\s*/g, '').trim();
  return { reply: display, repo, repoMentioned: repoPath, questions: questions?.length ? questions : null,
    document: document ? `${document}\n` : null };
}

export const lastMarkdownBlock = text => parseReply(text).document;
