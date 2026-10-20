---
name: nightshift
description: Hand a multi-step implementation plan to Nightshift, which runs it unattended in its own git worktree with sandboxed agents, checks, independent review, and kill switches, and stops at a branch for the owner to merge. Use when the user asks to "use Nightshift", "run this with Nightshift", "let Nightshift implement steps …", or to check, steer, or merge Nightshift plans.
---

# Nightshift

Nightshift is installed on this machine as the `nightshift` command. It turns the steps
in a document into a plan, works through it in an isolated worktree (the owner's
checkout is never touched), runs the project's checks after every task, has a separate
reviewer judge each change, commits accepted changes itself, and stops at a branch that
waits for the owner's merge. Project rules (AGENTS.md, CLAUDE.md) are passed to its
agents automatically; Nightshift's own limits win where they conflict (its agents never
commit, push, install, or use the network).

## From quick notes to a roadmap

The owner often pastes quick, messy notes ("reverb tail clicks on bypass", "preset browser
should remember the folder", ...) and wants them turned into a complete roadmap. Do this
with them before drafting anything:

1. Work out which project the notes are about. `nightshift projects` lists the projects
   in the owner's workspace with a one-line description; read code to confirm, and tell
   the owner which project you picked. If notes span several projects, say which belong
   elsewhere and plan one project at a time.
2. Read the relevant code and the project's rules (AGENTS.md, CLAUDE.md).
3. Ask what the code cannot answer, a few questions at a time, as multiple choice where
   sensible (use your question tool if you have one). Do not ask what the code settles.
4. Write the complete roadmap into the project, for example `docs/plans/<topic>.md`: a
   title, two or three sentences on scope, then numbered steps in order. **Each step is a
   milestone**: one meaningful outcome with a checkable result (a working feature, a
   component in place and used, a fix with its test) and how to verify it, worth a full
   agent session. Every step costs a worker, the checks, and a reviewer, so never make a
   step of a small edit (a rename, label wording, one value, a doc line): fold it into the
   milestone it serves. Most roadmaps have 2 to 6 steps. No check-only steps (Nightshift
   runs the checks itself). Include every note the owner wants done and nothing they did
   not ask for. Show it and revise until the owner is happy.
5. Continue with "Starting a plan" below, drafting from that document.

The Nightshift app's New Plan window runs this same interview, if the owner prefers it.

## Starting a plan: prepare, check, draft

You can do what Nightshift's agents may not (they never commit, push, merge, install, or
use the network), so get the project ready first. Plans start from the project's main
branch as it is on `origin` (fetched first), not from the current checkout: work merged
there is included; unpushed commits, unmerged branches, and uncommitted changes are not.

1. **Prepare.** Make sure the steps exist in a document in the repository (for example
   `docs/plans/<topic>.md`); if the user described the work in chat, write it there as
   numbered steps with clear outcomes and show it to them. Make sure the work the plan
   builds on is merged into main, and dependencies are installed. Committing, merging, and
   pushing follow the project's and the user's usual rules: ask before you push.
2. **Check.** Run `nightshift check --repo <path>` (add `--check "<command>"` for the
   project's test or build command if Nightshift does not know it yet). It shows where a
   plan would start, lists work it would leave out (unpushed, unmerged, uncommitted), and
   runs the checks in a fresh worktree at exactly that commit. If it says **Not ready**,
   fix the cause on that branch with the user's agreement and check again. If the needed
   work is local and the user does not want to push, draft with `--base main` (the local
   branch) instead.
3. **Draft**, do not start yet:

   ```sh
   nightshift draft <path/to/doc.md> [--steps "1-10"] [--agents claude:codex] [--base ref]
   ```

   It prints where the plan starts, the tasks, checks, allowed paths, limits, planner
   notes, and anything left out. `--agents worker:reviewer` chooses who works and who
   reviews (claude, codex); the default follows which providers are turned on. Each task
   carries a difficulty rating (low, medium, high) that sets the worker's starting effort;
   retries go one level up. If the owner disagrees with a rating:
   `nightshift difficulty <task> <level> --plan <id>`. Then run
   `nightshift check --plan <id>` to run the draft's own checks at its start commit.
4. **Ask.** Show the draft and the check result to the user and ask whether to start it.
   Only start when they say so:

   ```sh
   nightshift start <id>
   ```

   (`nightshift run <doc>` drafts and asks in one go in a terminal; do not pass `--yes`
   unless the user has already approved the plan.)

`merge` later merges into the branch the plan started from, locally; nothing is pushed.

## Watching and steering

```sh
nightshift list                       # all plans, status, progress
nightshift activity <id>              # what the agents did most recently
nightshift review <id>                # before approving: per-task diffs, verdicts, checks
nightshift report --plan <id>         # tasks, commits, blockers, limits, usage, merge command
nightshift logs <id>                  # runner log
nightshift pause --plan <id>          # resume --plan <id>
nightshift interrupt --plan <id>      # stop the running turn now; the plan pauses
nightshift retry <task-id> --plan <id>   # after a blocker is understood; then resume
nightshift limit turnMinutes 180 --plan <id>   # applies at once, also to the running turn
nightshift sync                       # notice plans merged on GitHub or by hand
```

Limits are generous by default and apply at once when changed; there is no need to pause
or restart a plan to raise one. When a plan is blocked, read the reason from `report` and explain it to the user; do not
retry or raise limits without their agreement. If the user wants to fix it with you, run
`nightshift fix-prompt <id>` for the context and work in the directory it names (do not
commit there); when it is fixed, the user accepts it with `nightshift accept <task> --plan <id>`.
A plan that says it is waiting for a usage limit continues by itself after the reset.
`nightshift queue add <id>` lines up plans to run one after another.

## Finishing

`nightshift merge <id>` (or `merge <id> --pr`, which pushes the plan branch and opens a pull
request) is the owner's approval. Never run it, and never run
`nightshift discard <id> --yes`, unless the user explicitly asks in this conversation.
Suggest reviewing the branch first (`report` prints the commands).

## Notes

- Providers: `nightshift enable codex` / `disable codex`. When Codex is off, Claude does
  both the work and the review, in separate conversations.
- Billing is subscription-only by design; never set API keys for Nightshift.
- Plans live in `~/.nightshift/plans/<id>`. The macOS app (Nightshift.app) shows the same
  plans and controls. Guide: `docs/Nightshift-Guide.pdf` in the Nightshift repository.
