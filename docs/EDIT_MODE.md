# Edit mode (approved design, being implemented)

Status: approved by the owner on 2026-10-14. Implementation is in progress; see
docs/ROADMAP.md for what is built.

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
If both pass, the plan becomes `awaiting-approval`. The morning report shows the
branch, diff summary, checks, and usage. Only the owner merges.

## Kill switches (all enforced by the controller)

| Limit | Default | When hit |
| --- | --- | --- |
| Attempts per task | 3 | task blocks, plan pauses |
| Time per turn | 20 min | turn interrupted, task blocks |
| Dispatches per plan | 3 × tasks + 2 | plan pauses |
| Tokens per plan | 5 M (input incl. cached + output) | plan pauses |
| Wall-clock per plan | 6 h | plan pauses |
| Changed lines per task | 800 | attempt fails the gate |
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

## Not in the first version

Parallel plans, automatic merge, pushing branches, a planning agent that writes the
task list, network allowlists for package registries, and the web interface.

## Decisions (owner, 2026-10-14)

1. One worktree per plan; tasks run in order and build on each other.
2. No agent network access while editing.
3. The owner writes the task list in v1.
4. The limits above are the defaults; a plan may change them.
5. A finished plan waits on its branch; only the owner merges.
