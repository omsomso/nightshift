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
   push, or merge. The commit is made as the repository's own git user (the owner), with
   the task title as its message; the plan state records which task made each commit. Only
   a repository with no git identity configured gets commits named Nightshift. Merging an
   approved plan makes a merge commit titled after the plan, such as "Merge speaker
   headphone calibration".
6. **Repair**: on a fail, the worker resumes its conversation with the check output
   and review reason, within the attempt limit.

After the last task: run the full checks again, then a final review against the brief.
If both pass, the plan becomes `awaiting-approval`. If either fails, Nightshift turns the
findings into one fix-up task (`final-fixup-1`), runs it through the same cycle, and
repeats the final phase; when the fix-up rounds are used up, the plan blocks. The final
review judges only the plan's brief and tasks within its allowed paths; other
observations are suggestions, not failures. The morning report shows the
branch, diff summary, checks, and usage. Only the owner merges.

## Where a plan starts

The base is resolved when the plan is created (`src/base.js`), never taken from the
owner's current checkout: `origin` is fetched and the default is the remote's main branch
(`origin/main`, or whatever `origin/HEAD` names), falling back to the local main branch
without a remote. `--base` overrides it. The plan records the exact commit (`base`), the
ref as typed (`baseRef`), and the branch it belongs to (`baseBranch`). Planning reads a
detached snapshot of that commit in `~/.nightshift/snapshots/<repo>-<hash>`, so the planner
and the interview see the code the worktree will contain. `merge` merges into `baseBranch`:
in the worktree where it is checked out (which must be clean), else in a temporary
worktree; a missing local branch is created from the ref. Conflicts abort cleanly and
nothing is pushed.

`check` (`src/readiness.js`) runs the same checks a plan's baseline will, earlier: in a
fresh detached worktree at the start commit under `~/.nightshift/checks/`, removed
afterwards. Without `--check` it uses the checks of the repository's latest plan or draft,
else a detected test command (npm, cargo, go, make, SwiftPM, pytest). Like plan checks,
these commands are not sandboxed. It also reports work left out: local commits on the base
branch that its remote lacks, checkout commits not in the base, uncommitted changes, and
branches changed in the last three days with commits the base lacks.

## Project rules

Nightshift's sandboxed agents do not load project instructions on their own (Claude's
restricted mode skips `CLAUDE.md`; verified 2026-10-15). Nightshift therefore collects
them itself (`src/rules.js`): `AGENTS.md` and `CLAUDE.md` at the repository root (from the
plan's base commit, or from the owner's checkout when the repository keeps them
untracked), `CLAUDE.local.md`/`AGENTS.local.md` from the owner's checkout, and
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
| Time per turn | 120 min | turn stopped; the task runs again (its changes kept) while attempts remain, then blocks |
| Dispatches per plan | 3 × tasks + 2 | plan pauses |
| Tokens per plan | 20 M new tokens (input minus cache re-reads, plus output; `src/tokens.js`) | plan pauses |
| Wall-clock per plan | 24 h | plan pauses |
| Changed lines per task | 3000 | attempt fails the gate |
| Time per check | 60 min | the check fails |
| Fix-up rounds after a failed final phase | 1 (0 disables) | plan blocks |
| Same failing check output twice, or an empty diff | — | task blocks (stagnation) |
| File outside allowed paths or a protected path | — | task blocks (drift) |

The defaults (since 2026-10-20) are worst cases with a wide margin: real milestone tasks
took 15 to 30 minutes per turn, up to about 2,000 changed lines, and about 2 M new tokens
per plan. Limits catch runaways; they must never stop a healthy unattended plan. `limit`
changes apply at once: directly when no runner holds the plan, within a second through the
runner otherwise (the time per turn also applies to the turn in progress), and to the draft
before it starts. A turn that runs out of time is no longer "execution uncertain": its
changes stay in the worktree, the task runs again, and the next attempt is told it timed
out and which files it left. Pauses record their reason (`pause --reason`), shown in the app.

Plans approved outside Nightshift are noticed: `list` checks whether the plan branch's
commits are in the starting branch (local or `origin`), and `sync` (the app runs it every
two minutes) fetches `origin` and asks `gh` whether an open pull request was merged, which
also catches squash merges. Such plans become `merged` (with `mergedOutside`) and move to
the app's archive.

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

### Project checks

Nightshift runs the plan's checks itself, and since 2026-10-16 inside macOS's sandbox
(`src/sandbox.js`, `sandbox-exec`): writes are allowed only in the worktree, its git
metadata, a private `TMPDIR`, `/private/tmp`, the user cache folder, `~/Library/Caches`,
`~/.cache`, and `~/.npm` (plus `checkWritablePaths`), and outbound network is denied unless
`checkNetwork` is on. A failure that looks like a sandbox denial gets a hint in its output.
`sandboxChecks: false` turns it off. The readiness check uses the same sandbox.

## Usage limits

A turn that ends at the subscription's usage limit raises `UsageLimitError` with the reset
time (Claude: the `rate_limit_event` message or the result text, including the
`…|<epoch>` form; Codex: the error text or code; otherwise 30 minutes). The task goes back
to ready without counting the attempt, the plan pauses with `waitUntil` (persisted), and
the runner resumes it two minutes after the reset. `onUsageLimit: stop` blocks the task and
pauses instead. A queued plan does not start during such a wait.

## Refused requests and scratch files

A request the fence refuses (a file outside the working copy, a git history command, the
network) never stops a task: the agent is told no and carries on, the refusal is recorded
(`provider:policy-denied`, shown in Activity), and the change still has to pass the gates,
checks, and review. Until 2026-10-20 any refusal other than git history blocked the task,
which stopped a VSTS plan when its worker tried to read a screenshot it had saved outside
the worktree. Agents now keep screenshots, logs, and other scratch files in
`.nightshift-scratch/` inside the worktree; its own `.gitignore` keeps it out of every
change and commit, and it is removed before the worktree is.

## Plan granularity

Tasks are milestones: one meaningful outcome worth a full agent session (a feature that
works, a component in place and used, a fix with its test). Every task costs a worker turn,
the checks, and a review, so the planner, the interview, and the skill fold small edits
(renames, label wording, single values, doc lines) into the milestone they serve, combine
adjacent steps that only make sense together, and aim for 2 to 6 tasks per plan.

## Owner fixes

`accept <task>` (or Accept Fix in the app) takes what is in the worktree for a blocked
task: protected paths still block it, the allowed paths and size cap do not apply, the
checks must pass, and Nightshift commits it as the task without an agent review
(`ownerFixed`). `fix-prompt` writes the context for an interactive Claude session and
says where to run it: the worktree, or the project itself when the checks already fail at
the start.

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

Parallel plans, automatic merge, a planning agent that writes the task list, network
allowlists for package registries, and the web interface. (Pushing a plan branch now
happens only for an owner-approved pull request: `merge --pr`.)

## Decisions (owner, 2026-10-14)

1. One worktree per plan; tasks run in order and build on each other.
2. No agent network access while editing.
3. The owner writes the task list in v1.
4. The limits above are the defaults; a plan may change them.
5. A finished plan waits on its branch; only the owner merges.
