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
   title, two or three sentences on scope, then numbered steps in order, each one
   coherent change with a checkable outcome and how to verify it, small enough for one
   agent session. Include every note the owner wants done and nothing they did not ask
   for. Show it and revise until the owner is happy.
5. Continue with "Starting a plan" below, drafting from that document.

The Nightshift app's New Plan window runs this same interview, if the owner prefers it.

## Starting a plan

1. Make sure the steps exist in a document in the repository (for example
   `docs/PLAN.md` or a roadmap section). If the user described the work in chat, write
   it there first as numbered steps with clear outcomes, and show it to them.
2. Draft, do not start yet:

   ```sh
   nightshift draft <path/to/doc.md> [--steps "1-10"] [--agents claude:codex]
   ```

   It prints the drafted tasks, checks, allowed paths, limits, and planner notes.
   `--agents worker:reviewer` chooses who works and who reviews (claude, codex); the
   default follows which providers are turned on.
3. Show the draft to the user and ask whether to start it. Only start when they say so:

   ```sh
   nightshift start <id>
   ```

   (`nightshift run <doc>` drafts and asks in one go in a terminal; do not pass `--yes`
   unless the user has already approved the plan.)

Before starting, check that the repository's own work is committed (plans start from
the last commit) and that its checks pass today.

## Watching and steering

```sh
nightshift list                       # all plans, status, progress
nightshift report --plan <id>         # tasks, commits, blockers, limits, usage, merge command
nightshift logs <id>                  # runner log
nightshift pause --plan <id>          # resume --plan <id>
nightshift interrupt --plan <id>      # stop the running turn now; the plan pauses
nightshift retry <task-id> --plan <id>   # after a blocker is understood; then resume
nightshift limit tokens 8000000 --plan <id>
```

When a plan is blocked, read the reason from `report` and explain it to the user; do not
retry or raise limits without their agreement.

## Finishing

`nightshift merge <id>` is the owner's approval. Never run it, and never run
`nightshift discard <id> --yes`, unless the user explicitly asks in this conversation.
Suggest reviewing the branch first (`report` prints the commands).

## Notes

- Providers: `nightshift enable codex` / `disable codex`. When Codex is off, Claude does
  both the work and the review, in separate conversations.
- Billing is subscription-only by design; never set API keys for Nightshift.
- Plans live in `~/.nightshift/plans/<id>`. The macOS app (Nightshift.app) shows the same
  plans and controls. Guide: `docs/Nightshift-Guide.pdf` in the Nightshift repository.
