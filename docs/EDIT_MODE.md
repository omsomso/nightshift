# Edit mode

Status: approved by the owner and implemented on 2026-10-14. See "Verification" below
for what has been checked against real agents.

Goal: agents implement a whole plan unattended, in an isolated copy of the
repository, and stop at a branch that waits for the owner's merge. Dangerous or
runaway behavior is prevented by deterministic controller limits and OS sandboxes,
not by prompts alone.

## Units of work

- **Plan**: the unit the owner approves. A brief, an ordered task list, the check
  commands, and the limits. "Done" means every task is verified, the full checks
  pass, and a final review confirms the whole plan was implemented.
- **Task**: one step of the plan with its own acceptance criteria.
- **Worktree**: one per plan, on branch `nightshift/<plan-id>`, created from a recorded
  base commit. Tasks run one after another in it, so each builds on the last. The
  owner's checkout is never touched.

## Task cycle

1. **Work**: the worker edits files inside the worktree (sandboxed, see below).
2. **Checks**: Nightshift itself runs the plan's check commands (for example
   `npm test`) in the worktree with a timeout. An agent's claim that tests pass counts
   for nothing.
3. **Gates** (deterministic, before any review):
   - files changed only inside the plan's allowed paths, and no protected path changed;
   - the diff is under the size cap;
   - the diff is not empty, and differs from the previous failed attempt.
4. **Review**: a separate reviewer sees the task, the diff, and the check output, and
   judges acceptance *and* scope ("did this change only what the task asked?").
5. **Commit**: on a pass, Nightshift commits the change itself. Agents never commit,
   push, or merge.
6. **Repair**: on a fail, the worker resumes its conversation with the check output
   and review reason, within the attempt limit.

After the last task: run the full checks again, then a final review against the brief.
If both pass, the plan becomes `awaiting-approval`. If either fails, Nightshift turns the
findings into one fix-up task (`final-fixup-1`), runs it through the same cycle, and
repeats the final phase; when the fix-up rounds are used up, the plan blocks. The final
review judges only the plan's brief and tasks within its allowed paths; other
observations are suggestions, not failures. The morning report shows the
branch, diff summary, checks, and usage. Only the owner merges.

## Project rules

Nightshift's sandboxed agents do not load project instructions on their own (Claude's
restricted mode skips `CLAUDE.md`; verified 2026-10-15). Nightshift therefore collects
them itself (`src/rules.js`): `AGENTS.md` and `CLAUDE.md` at the repository root (from the
plan's base commit), `CLAUDE.local.md`/`AGENTS.local.md` from the owner's checkout, and
`AGENTS.md`/`CLAUDE.md` in parent folders up to the home folder. Identical texts are
included once. The set is snapshotted when the plan is created (`plan.rules`) and added
to every planner, worker, reviewer, and final-review prompt, with an explicit
precedence note: Nightshift's limits win, and steps the rules require but Nightshift
forbids (commit, push, install, network) are listed as left for the owner. A denied
`git commit`/`push`/... attempt is recorded as `policy-denied` and does not block the
task; any other denied request still does. The report and the app list the rule files
a plan used.

## Effort

Both CLIs take a reasoning-effort level per turn (Claude `--effort`: low, medium, high,
xhigh, max; Codex `effort` on `turn/start`, where Nightshift sends low, medium, or high).
Nightshift decides it deterministically (`src/effort.js`):

- The planner rates each task's difficulty (low, medium, high) with a one-line reason.
  That sets the worker's effort on the first attempt.
- Each retry goes one level higher: a failed check or review means the task was harder
  than rated.
- Reviewers (per task and final) run at a fixed level, default high, so a low rating never
  weakens a check. The planner and interviewer run at their own level, default high.
- Everything stays within the owner's bounds (default medium to xhigh), set with
  `nightshift effort set <min|max|reviewer|planner> <level>` or in the app's Accounts.
  A plan snapshots these when it starts; a plan file may set its own `effort`.
- The owner can change a task's rating on the draft (app, or
  `nightshift difficulty <task> <level> --plan <id>`); on a running plan it applies from
  the task's next attempt. The dispatch event and report record the effort used.

## Kill switches (all enforced by the controller)

| Limit | Default | When hit |
| --- | --- | --- |
| Attempts per task | 3 | task blocks, plan pauses |
| Time per turn | 20 min | turn interrupted, task blocks |
| Dispatches per plan | 3 × tasks + 2 | plan pauses |
| Tokens per plan | 5 M (input incl. cached + output) | plan pauses |
| Wall-clock per plan | 6 h | plan pauses |
| Changed lines per task | 800 | attempt fails the gate |
| Fix-up rounds after a failed final phase | 1 (0 disables) | plan blocks |
| Same failing check output twice, or an empty diff | — | task blocks (stagnation) |
| File outside allowed paths or a protected path | — | task blocks (drift) |

Existing controls stay: `pause`, `interrupt`, the dispatch cap, billing guards, and
restart recovery (anything in flight blocks rather than replays). A blocked plan
waits for the owner; other plans are unaffected. Agents cannot add tasks, change
limits, or edit the plan.

## Sandbox (minimizing danger)

Both providers run with an OS-enforced fence, so the agent can run what it needs
for its step (builds, tests, scripts), while anything outside the fence fails:

| | Claude Code | Codex |
| --- | --- | --- |
| Writes | worktree + temp only (`sandbox.enabled`; file tools confined by `--restricted`) | `workspaceWrite` sandbox, worktree as the only writable root |
| Network | none (empty `allowedDomains`, `strictAllowlist`) | `networkAccess: false` |
| Escape | `allowUnsandboxedCommands: false`, `failIfUnavailable: true` | approval `never`: failures go back to the model, nothing asks |
| Credentials | `denyRead` for `~/.ssh`, `~/.aws`, `~/.config/gh`, keychains | reads are not restricted (known gap) |

Consequences: git metadata lives outside the worktree, so agents cannot commit or
rewrite history; no package installs or web lookups (dependencies must already be
installed); push is impossible. Protected paths that no task may change by default:
`.git`, `.github/`, `.claude/`, `.codex/`, `AGENTS.md`, `CLAUDE.md`, and Nightshift's
own state.

## Using it

Usually you do not write the plan by hand: `node src/cli.js run <doc> [--steps ...]` (or
New Plan in the app) has a read-only agent draft it from a document in the repository,
one task per step without inventing or reordering steps, and you approve the draft
before anything runs. The planner first reads the repository's agent instructions
(AGENTS.md, CLAUDE.md) and includes in the allowed paths any file they require
updating, such as a roadmap. To write one by hand instead, use a plan file (JSON). `repo` is relative to the plan file; `allowedPaths` are
repository-relative prefixes (omit for the whole repository); `limits` override the
defaults above.

```json
{
  "id": "math-extensions",
  "repo": "../my-project",
  "base": "main",
  "brief": "Extend the math library with multiplication and safe division, each with tests.",
  "checks": ["npm test"],
  "allowedPaths": ["src/", "test/"],
  "limits": { "tokens": 3000000 },
  "tasks": [
    { "id": "multiply", "title": "Add multiply(a, b)", "acceptance": "Exported and tested, including a negative number." },
    { "id": "divide", "title": "Add divide(a, b)", "acceptance": "Throws RangeError on zero; tests cover both cases." }
  ]
}
```

```sh
node src/cli.js plan plan.json --state .nightshift/math        # creates the worktree and branch
node src/cli.js serve --agents claude:codex --state .nightshift/math
node src/cli.js report --state .nightshift/math                # progress, limits, and the merge command
node src/cli.js limit tokens 6000000 --state .nightshift/math  # raise a limit after it was reached
node src/cli.js retry math-extensions --state .nightshift/math # reopen a blocked plan, then resume
```

Use one state directory per plan. Plans in different state directories can run at
the same time, each in its own worktree. The worktree lives at `<state>/worktree`.

## Verification (2026-10-14, dev Mac; claude 2.1.296, codex-cli 0.162.1)

Sandbox probe: a real edit-mode worker of each provider was asked to try four things in
a worktree. Both results matched:

| Attempt | Claude | Codex |
| --- | --- | --- |
| Write a file outside the worktree (not in temp) | blocked: operation not permitted | blocked: operation not permitted |
| `curl https://example.com` | blocked by the sandbox network proxy | blocked: host could not be resolved |
| `git commit` | refused by the deny rule (and the task blocks) | blocked: git metadata not writable |
| Write a file inside the worktree | allowed | allowed |

Note: Claude's sandbox also allows writes to its per-user temp directory by design.

Live plans on a toy Node project (two tasks: multiply, then divide with a zero check;
checks `npm test`; allowed paths `src/`, `test/`): `claude:codex` and `codex:claude`
both reached `awaiting-approval` in about a minute, every task on attempt 1, with a
passing final review. Each branch had exactly two Nightshift-authored commits touching
only `src/math.js` and `test/math.test.js`; tests passed on both branches; the owner's
`main` and working tree were unchanged. Usage per plan: about 160–176 thousand tokens.

Behavior to know: a denied tool request (such as an agent trying `git commit`) blocks
the task rather than letting the agent continue. Plan limits are checked before each
dispatch, so the last task before a limit can overshoot it.

Not yet verified live: a check failure followed by a repair, a gate block (drift or
size) with a real agent, the per-turn 20-minute timeout, and a large repository.

## Not in the first version

Parallel plans, automatic merge, pushing branches, a planning agent that writes the
task list, network allowlists for package registries, and the web interface.

## Decisions (owner, 2026-10-14)

1. One worktree per plan; tasks run in order and build on each other.
2. No agent network access while editing.
3. The owner writes the task list in v1.
4. The limits above are the defaults; a plan may change them.
5. A finished plan waits on its branch; only the owner merges.
