# Nightshift

A personal, local-first workspace that keeps coding agents moving while you are away.

**Status: supervisor core plus initial Codex and Claude adapters.**
Both adapters share one set of worker/reviewer prompts and are tested against
subprocess fixtures. Either provider can be the worker or the reviewer. Claude has
Both have completed live, read-only worker/reviewer runs, including Codex work reviewed by Claude.
Both are restricted to subscription billing (claude.ai, ChatGPT).
The web interface is not implemented.
The default demo is simulated and does not call a model or spend API credits.

## Why

The owner runs a Mac Studio 24/7 with a VM and currently uses remotely accessible
Codex and Claude desktop chats. Nightshift will own programmatic agent sessions,
give them a persistent project queue, verify results, and expose a remote-friendly
chat interface. Closing the interface must not stop the supervisor.

## Quick start

Requires Node.js 22.13 or newer, and the Claude and/or Codex CLI signed in with a
subscription (claude.ai, ChatGPT). From this folder:

```sh
node src/cli.js setup                                  # once, and after updating a CLI
node src/cli.js run /path/to/repo/docs/PLAN.md --steps "1-10"
```

`setup` also installs a `nightshift` command (in `~/.local/bin`) and a Nightshift skill for
Claude Code and Codex, so any session in any project knows how to hand work to
Nightshift when you ask it to.

`run` has an agent turn the document's steps into a plan (one task per step, with
acceptance criteria, checks, and allowed paths), shows it, and asks once. If you say
yes, it runs in the background in its own worktree until the plan is done or needs
you. `list` shows all plans; `merge <id>` is the final approval. Plans live in
`~/.nightshift/plans/<id>`.

A plan does not start from whatever happens to be checked out. By default Nightshift
fetches `origin` and starts from the project's main branch as it is there (for example
`origin/main`), so work merged from other sessions is included; without a remote it uses
the local main branch. The planner reads a snapshot of exactly that commit
(`~/.nightshift/snapshots/`), and `merge` merges into that same branch (`main`) wherever it
is checked out, or in a temporary worktree if it is not. Nothing is ever pushed.
`--base` picks another branch, tag, or commit; `branches --repo <path>` lists candidates.
Set `"defaultBase": "local"` (local main branch) or `"head"` (the checkout, the old
behavior) in `~/.nightshift/config.json` to change the default.

Commands for plans (`node src/cli.js --help` lists them all):

```sh
node src/cli.js run docs/PLAN.md --base v1.2           # start from a tag, branch, or commit instead of origin's main branch
node src/cli.js draft docs/PLAN.md --base main~3       # only draft; the exact commit and the ref are recorded in the plan
node src/cli.js branches --repo ../VSTS                # where a plan would start, and recent branches to choose from
node src/cli.js start <id>                             # start (or `stop <id>`) a plan's background runner
node src/cli.js list                                   # all plans; `now:` names the task running or in review
node src/cli.js logs <id> --lines 100                  # tail of the runner's serve.log (default 40 lines)
node src/cli.js report --plan <id>                     # Markdown report: each task's attempts and latest checks
node src/cli.js report --plan <id> --json              # one plan's summary, as one entry of `list --json`
node src/cli.js limit tokens 8000000 --plan <id>       # change a limit; unknown names are refused at once
node src/cli.js discard <id> --yes                     # remove an unmerged plan: its worktree, branch, and directory
node src/cli.js merge <id>                             # approve: merge the plan's branch into the branch it started from
```

`discard` without `--yes` only lists what it would remove. It refuses while the
plan's runner is alive (stop it first) and refuses merged plans. Plan checks may not
run `git push`, `git commit`, `git reset`, or `git rebase`.

To save one provider's usage, turn it off: `node src/cli.js disable codex` (undo with
`enable codex`). Nightshift then never starts it, and new plans use Claude for both the
work and the review, in separate conversations. Codex is currently turned off on the
development Mac.

**Project rules carry over.** Nightshift reads the repository's `AGENTS.md`/`CLAUDE.md`
(and local and parent-folder ones), snapshots them when a plan starts, and gives them
to every agent, whether you start the plan from a terminal, a Claude or Codex session,
or the app. Where a project's rules ask for something Nightshift forbids (commit, push,
install, network), Nightshift wins and the agent lists it as left for you.

**Effort.** The planner rates each task low, medium, or high; workers start at that effort
and go one level higher on every retry, while reviewers stay at a fixed high level. You
set the bounds (`nightshift effort`) and can change any rating on the draft.

**From quick notes.** In the app, New Plan takes your pasted notes: Claude finds the
project in your workspace (`nightshift projects`), interviews you with multiple-choice
questions, and writes the roadmap; you approve before anything runs. The same works from
the terminal (`nightshift chat --notes`) and from any Claude or Codex chat via the skill.

For a window and menu-bar view with notifications, build the app (see `app/README.md`):

```sh
app/build.sh
open app/build/Nightshift.app
```

## Try it offline

Requires Node.js 22.13 or newer (for built-in SQLite). No dependency installation is needed.

```sh
npm test
npm run demo
npm run status
```

The demo seeds two tasks in `.nightshift/nightshift.db`, executes them with a simulated
adapter and reviewer, and prints their saved status. Repeating it does not duplicate
completed tasks. `node src/cli.js demo ./another-demo` uses a separate state directory.

## Run it as a service

`serve` keeps running: it dispatches ready tasks, then waits for more. Other commands
talk to it through the state database, so they work from another terminal while it runs.

```sh
node src/cli.js serve --agents simulated            # or claude, codex, codex:claude --repo /path
node src/cli.js add --id docs --title "Document setup" --acceptance "README lists the steps."
node src/cli.js pause                                # stops new dispatch at the next boundary
node src/cli.js interrupt                            # stops the running turn now and pauses
node src/cli.js resume
node src/cli.js retry <task-id>                      # requeue a blocked task you have reconciled
node src/cli.js report --since 2026-10-14T00:00Z     # Markdown morning report
```

`serve` pauses itself after `--max-dispatches` (default 20) and stays paused across
restarts until you resume. Ctrl-C or SIGTERM stops after the current step. See
`docs/SERVICE.md` for starting it automatically at boot.

The core supports dependency ordering, persisted attempt limits, independent review
before completion, continuing past blocked tasks, and conservative recovery of
interrupted work. State lives in SQLite with an append-only event log. One runner
holds an expiring lease, and every write checks it.

## Edit mode

Give Nightshift a plan (a brief, ordered tasks, and the check commands) and it works
through it in its own git worktree: the agent edits inside an OS sandbox with no
network, Nightshift runs the checks and gates, a separate reviewer judges each change,
and Nightshift commits it. When every task and a final review pass, the branch waits
for you to merge. See `docs/EDIT_MODE.md`.

## Project map

- `docs/PROJECT.md`: product requirements and acceptance criteria.
- `docs/ARCHITECTURE.md`: session ownership, adapters, remote access, and persistence.
- `docs/ROADMAP.md`: ordered implementation backlog and next-agent handoff.
- `src/supervisor.js`: queue and verification state machine.
- `src/store.js`: SQLite state, append-only events, runner lease, and command queue.
- `src/cli.js`: plan commands (setup, run, draft, start, stop, list, logs, discard, merge) and service commands (serve, add, pause, resume, retry, limit, report).
- `src/report.js`: morning report rendering.
- `src/plan.js`, `src/workspace.js`: edit-mode plans, worktrees, checks, gates, and commits.
- `src/planner.js`, `src/plans.js`, `src/home.js`: drafting from documents, plan lifecycle, `~/.nightshift`.
- `app/`: the SwiftUI macOS app (window, menu bar, notifications) over the CLI.
- `src/providers.js`: version-checked provider setup shared by `serve` and `smoke`.
- `src/prompts.js`: provider-neutral worker/reviewer prompts and result schemas.
- `src/adapters/`: simulated, Codex, and Claude workers and reviewers (`agent.js` is shared).
- `src/codex/`: App Server JSONL transport, session management, and turn events.
- `src/claude/`: headless `claude -p` session, read-only flags, and stream events.
- `src/jsonl.js`: line framing shared by both transports.
- `src/smoke.js`: version-checked, read-only compatibility run for any provider pairing.
- `src/repair-check.js`: live check that a failed review resumes both saved sessions (`npm run repair:check`).
- `docs/CODEX_SETUP.md`, `docs/CLAUDE_SETUP.md`: setup, verified behavior, and recovery notes.
- `docs/SERVICE.md`: running `serve` under launchd (macOS) or systemd (Linux).
- `test/supervisor.test.js`: behavioral checks for unattended execution.
- `test/service.test.js`: store, lease, command, serve-loop, and report tests.
- `test/edit.test.js`: edit-mode cycle, gates, limits, final review, and serve end to end.
- `src/base.js`: where a plan starts (fetched default branch, `--base`), branch listing, and planning snapshots.
- `test/run.test.js`: setup pins, draft → background run → merge, `--base`, starting from a remote that is ahead, and runner stop.
- `test/cli.test.js`: `logs`, `discard`, limit names, `list` now line, report task detail, and `report --json`.
- `test/codex.test.js`, `test/claude.test.js`: subprocess protocol and persisted session tests.

## Next milestone

Run the live compatibility checks on the machine that will host Nightshift:
`npm run codex:smoke` (see `docs/CODEX_SETUP.md`), `npm run claude:smoke` (see
`docs/CLAUDE_SETUP.md`), and one mixed pairing such as `npm run smoke -- codex:claude`.
Resolve any protocol mismatch they reveal. Both adapters are read-only for now.
Workspace writes and the authenticated responsive UI come after this checkpoint.

## Git and remote setup

The repository is hosted privately at https://github.com/omsomso/nightshift (branch
`main`). No open-source license has been chosen. Runtime state (`.nightshift/`) and
`.env` files are excluded from Git.
